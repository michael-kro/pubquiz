// M6: protection against floods, guessing, odd team names and leaking the host key.
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import WebSocket from 'ws';
import { Game } from '../server/game.ts';
import { checkTeamName, clientAddress, TokenBucket, WindowCounter } from '../server/limits.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const quiz = parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n');
const start = (extra: Parameters<typeof createQuizServer>[0] = {}) =>
  createQuizServer({ closeEarly: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', ...extra });

test('token bucket: a burst is allowed, then actions are paced', () => {
  let now = 0;
  const bucket = new TokenBucket(3, 2, () => now);
  assert.deepEqual([bucket.take(), bucket.take(), bucket.take(), bucket.take()], [true, true, true, false]);
  now += 500; // one token back
  assert.deepEqual([bucket.take(), bucket.take()], [true, false]);
  now += 60_000; // never more than the burst size
  assert.deepEqual([1, 2, 3, 4].map(() => bucket.take()), [true, true, true, false]);
});

test('window counter: blocks after the limit, and lets go when the window passes', () => {
  let now = 0;
  const counter = new WindowCounter(2, 1000, () => now);
  counter.add('a');
  assert.equal(counter.blocked('a'), false);
  counter.add('a');
  assert.equal(counter.blocked('a'), true);
  assert.equal(counter.blocked('b'), false, 'other addresses are unaffected');
  now += 1001;
  assert.equal(counter.blocked('a'), false);
  counter.add('a');
  counter.add('a');
  counter.clear('a');
  assert.equal(counter.blocked('a'), false);
});

function request(remote: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress: remote }, headers } as unknown as IncomingMessage;
}

test('client address: forwarding headers are only believed from this laptop', () => {
  assert.equal(clientAddress(request('192.168.1.20')), '192.168.1.20');
  assert.equal(clientAddress(request('192.168.1.20', { 'cf-connecting-ip': '1.2.3.4' })), '192.168.1.20', 'a phone cannot claim another address');
  assert.equal(clientAddress(request('127.0.0.1', { 'cf-connecting-ip': '81.2.69.142' })), '81.2.69.142');
  assert.equal(clientAddress(request('::1', { 'x-forwarded-for': '81.2.69.142, 10.0.0.1' })), '81.2.69.142');
  assert.equal(clientAddress(request('::ffff:127.0.0.1')), '::ffff:127.0.0.1');
  assert.equal(clientAddress(request('127.0.0.1', { 'cf-connecting-ip': 'x'.repeat(100) })), '127.0.0.1');
});

test('team names: invisible and text-flipping characters are removed, length counts letters', () => {
  assert.deepEqual(checkTeamName('  Quiz​‍zards‮  '), { ok: true, name: 'Quizzards' });
  assert.deepEqual(checkTeamName('Les\u0000 Quiz'), { ok: true, name: 'Les Quiz' });
  assert.deepEqual(checkTeamName('​‌ ㅤ'), { ok: false, error: 'Enter a team name.' });
  assert.deepEqual(checkTeamName('🎉'.repeat(24)), { ok: true, name: '🎉'.repeat(24) });
  assert.equal(checkTeamName('🎉'.repeat(25)).ok, false);
});

test('team names: swearing is blocked, even disguised, but ordinary names are not', () => {
  for (const bad of ['fuck', 'FUCK OFF', 'f.u.c.k', 'sh1t happens', 'Big D1ck Energy', 'wank3r', 's h i t', 'The Cunts']) {
    const result = checkTeamName(bad);
    assert.equal(result.ok, false, bad);
  }
  for (const fine of ['Scunthorpe United', 'Essex Girls', 'Hancock', 'Cockney Rejects', 'Bass Hole', 'Assassins', 'Dickens', 'Quizzy Rascals', 'Les Quizérables']) {
    assert.equal(checkTeamName(fine).ok, true, fine);
  }
  assert.equal(checkTeamName('fuck', { filterWords: false }).ok, true, 'the host can turn the filter off');
});

test('the game uses the name check, and the host can turn the word filter off', () => {
  const game = new Game(parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n'));
  assert.equal(game.join('Quiz‮zards').ok && game.getTeamNames().includes('Quizzards'), true);
  assert.equal(game.join('Shit Happens').ok, false);
  game.dispose();
  const open = new Game(quiz, { nameFilter: false });
  assert.equal(open.join('Shit Happens').ok, true);
  open.dispose();
});

test('every page carries headers that stop the host key leaking or the page being framed', async () => {
  const server = await start();
  for (const path of ['/', '/host', '/screen', '/play.js']) {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
  }
  await server.close();
});

test('a connection that floods messages is slowed, told once, and eventually dropped', async () => {
  const server = await start();
  const team = await Client.connect(server.port);
  team.send({ t: 'join', room: server.roomCode, name: 'Flooder' });
  await team.waitFor((m) => m.t === 'joined');
  for (let i = 0; i < 400; i++) team.send({ t: 'answer', value: 'a' });
  // The server hangs up on it. (We check the server's side: after a hard reset the flooding client's own
  // socket may not be told promptly.)
  const deadline = Date.now() + 5000;
  while (server.game!.hostView().teams[0]?.connected !== false) {
    assert.ok(Date.now() < deadline, 'the flooding connection was dropped');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  team.ws.terminate();
  assert.equal(server.game!.hostView().teams.length, 1, 'the team is still in the quiz');
  const other = await Client.connect(server.port);
  other.send({ t: 'join', room: server.roomCode, name: 'Calm' });
  await other.waitFor((m) => m.t === 'joined');
  await other.close();
  await server.close();
});

test('the flood warning is sent once', async () => {
  const server = await start();
  const team = await Client.connect(server.port);
  const errors: string[] = [];
  team.ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.t === 'error') errors.push(m.message);
  });
  for (let i = 0; i < 60; i++) team.send({ t: 'advance' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(errors.filter((e) => e === 'Slow down.').length, 1);
  await team.close();
  await server.close();
});

test('guessing room codes or team codes is limited per address', async () => {
  const server = await start();
  const client = await Client.connect(server.port);
  for (let i = 0; i < 20; i++) client.send({ t: 'join', room: 'ZZZZ', name: `Guess ${i}` });
  await new Promise((resolve) => setTimeout(resolve, 400));
  client.send({ t: 'join', room: server.roomCode, name: 'Right Code' });
  const blocked = await client.waitFor((m) => m.t === 'error' && /Too many/.test(m.message), 3000);
  assert.match(blocked.message, /Wait a minute/);
  assert.equal(server.game!.hostView().teams.length, 0, 'even the right code is refused while blocked');

  // A stale saved token is not a guess, so it never counts against anyone.
  const phones = await Client.connect(server.port);
  for (let i = 0; i < 30; i++) phones.send({ t: 'rejoin', token: `old-token-${i}` });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const second = await Client.connect(server.port);
  second.ws.close();
  await client.close();
  await phones.close();
  await server.close();
});

test('different visitors behind the tunnel are counted separately', async () => {
  const server = await start({ hostPin: 'a-long-pin-9' });
  const login = (pin: string, ip: string) =>
    fetch(`http://127.0.0.1:${server.port}/login`, { method: 'POST', body: JSON.stringify({ pin }), headers: { 'cf-connecting-ip': ip } });
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong', '9.9.9.9')).status, 401);
  assert.equal((await login('a-long-pin-9', '9.9.9.9')).status, 429, 'the guesser is locked out');
  assert.equal((await login('a-long-pin-9', '8.8.8.8')).status, 200, 'someone else is not');
  await server.close();
});

test('too many connections from one address are turned away', async () => {
  const server = await start();
  const sockets: WebSocket[] = [];
  let refused = 0;
  await Promise.all(
    Array.from({ length: 85 }, () => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      sockets.push(ws);
      return new Promise<void>((resolve) => {
        ws.once('open', () => resolve());
        ws.once('close', (code) => {
          if (code === 1013) refused++;
          resolve();
        });
        ws.once('error', () => resolve());
      });
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(refused, 5);
  for (const ws of sockets) ws.terminate();
  await server.close();
});

test('every host action is refused for anyone without the host key, and changes nothing', async () => {
  const server = await start();
  const stranger = await Client.connect(server.port);
  const team = await Client.connect(server.port);
  team.send({ t: 'join', room: server.roomCode, name: 'Ann' });
  await team.waitFor((m) => m.t === 'joined');
  const teamId = server.game!.hostView().teams[0]!.id;
  const hostActions = [
    { t: 'advance' },
    { t: 'pause' },
    { t: 'resume' },
    { t: 'extend', seconds: 30 },
    { t: 'skip' },
    { t: 'kick', teamId },
    { t: 'mark', key: 'abba', correct: true },
    { t: 'network', action: 'use-lan' },
    { t: 'end-quiz' },
  ];
  for (const client of [stranger, team]) {
    for (const action of hostActions) {
      client.send(action);
      assert.equal((await client.waitFor((m) => m.t === 'error')).message, 'Only the host can do that.', JSON.stringify(action));
    }
  }
  assert.equal(server.game!.phase, 'lobby');
  assert.equal(server.game!.hostView().teams.length, 1);

  // Nor does a wrong key or the TV's key make anyone a host.
  for (const key of ['', 'guess', server.screenKey]) {
    const fake = await Client.connect(server.port);
    fake.send({ t: 'host', key });
    assert.match((await fake.waitFor((m) => m.t === 'error')).message, /Wrong host key/);
    fake.send({ t: 'advance' });
    await fake.close();
  }
  assert.equal(server.game!.phase, 'lobby');
  for (const c of [stranger, team]) await c.close();
  await server.close();
});
