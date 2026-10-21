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
  createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, allowEmptyStart: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', ...extra });

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

test('keys travel in headers and in the link fragment, never in a request address', async () => {
  // A key in a URL passes through any proxy (the internet link included) and can sit in its logs. The host link carries
  // its key after the #, which browsers keep to themselves, and the pages fetch clips, QR codes and downloads with the
  // key in a header. A key given in the address is simply not a key.
  const server = await start();
  assert.match(server.hostUrl, /\/host#key=/);
  assert.doesNotMatch(server.hostUrl, /\?key=/);
  const base = `http://127.0.0.1:${server.port}`;
  // (The library API is covered the same way in library.test.ts; this server has no library.)
  for (const [path, inAddress] of [
    ['/results.csv', 404],
    ['/host-qr.svg', 401],
  ] as const) {
    assert.equal((await fetch(`${base}${path}?key=${server.hostKey}`)).status, inAddress, `${path} with the key in the address`);
    assert.equal((await fetch(`${base}${path}`, { headers: { 'x-host-key': server.hostKey } })).status, 200, `${path} with the key in a header`);
  }
  await server.close();
});

test('a WebSocket upgrade from another website is refused; the app itself and non-browser clients connect', async () => {
  const server = await start();
  const attempt = (headers: Record<string, string>) =>
    new Promise<'open' | 'refused'>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers });
      ws.once('open', () => {
        ws.terminate();
        resolve('open');
      });
      ws.once('unexpected-response', () => resolve('refused'));
      ws.once('error', () => resolve('refused'));
    });
  assert.equal(await attempt({ Origin: 'https://evil.example' }), 'refused', 'another site');
  assert.equal(await attempt({ Origin: `http://127.0.0.1:${server.port}` }), 'open', 'the app page, by the address it was opened on');
  assert.equal(await attempt({ Origin: 'null' }), 'refused', 'an opaque origin');
  assert.equal(await attempt({}), 'open', 'a client that is not a browser');
  await server.close();
});

test('an oversized WebSocket frame closes that connection and nothing else', async () => {
  // Found by the fuzz test: without an error listener on each socket, ws's "Max payload size exceeded" was an
  // uncaught exception, so one 5 KB frame from anyone with the join link took the whole server down.
  const server = await start();
  const bad = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  bad.on('error', () => {});
  await new Promise((resolve) => bad.once('open', resolve));
  const closed = new Promise<number>((resolve) => bad.once('close', (code) => resolve(code)));
  bad.send(`{"t":"join","name":"${'a'.repeat(5000)}"}`);
  assert.equal(await closed, 1009, 'the offending connection is closed as too big');
  // Everyone else carries on.
  const team = await Client.connect(server.port);
  team.send({ t: 'join', name: 'Still here' });
  await team.waitFor((m) => m.t === 'joined');
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status, 200);
  await team.close();
  await server.close();
});

test('the TV is sent nothing that gives the answer away before the reveal, for every question type', async () => {
  // Found by the fuzz test: number, nearest and letter questions carried the host's editable answer (editValue) in
  // the TV's view while the question was open. The TV page never showed it, but anyone with the TV link could read it.
  const secrets = { letter: 'Zyxwvu', number: '7777777', nearest: '424242', 'multiple-choice': 'ONLYRIGHT', music: 'SECRETTUNE', buzzer: 'SECRETBUZZ' };
  const tvQuiz = parseQuiz(`
title: TV secrets
readOut: false
rounds:
  - name: R
    questions:
      - { type: letter, text: Q1, answer: Zyxwvu Secretname, seconds: 60 }
      - { type: number, text: Q2, answer: 7777777, seconds: 60 }
      - { type: nearest, text: Q3, answer: 424242, seconds: 60 }
      - { type: multiple-choice, text: Q4, options: [a, ONLYRIGHT, c], answer: 1, seconds: 60 }
      - { type: music, text: Q5, accept: [SECRETTUNE], seconds: 60 }
      - { type: buzzer, text: Q6, answer: SECRETBUZZ, seconds: 60 }
`);
  const server = await start({ quiz: tvQuiz, closeEarly: false });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  await tv.state('lobby');
  for (const [i, q] of tvQuiz.questions.entries()) {
    host.send({ t: 'advance' });
    const open = await tv.state('open', (v) => v.question?.index === i);
    host.send({ t: 'advance' });
    const closed = await tv.state('closed', (v) => v.question?.index === i);
    for (const view of [open, closed]) {
      const raw = JSON.stringify(view);
      const secret = secrets[q.type as keyof typeof secrets];
      // Multiple-choice options are shown by design; everything else must stay hidden, and the letter must not appear as a lone value.
      if (q.type !== 'multiple-choice') assert.ok(!raw.includes(secret), `${q.type} (${view.phase}): the TV was sent the answer: ${raw.slice(0, 300)}`);
      assert.equal(view.question.editValue, undefined, `${q.type} (${view.phase}): no editable answer on the TV`);
      assert.equal(view.question.answer, undefined, `${q.type} (${view.phase}): no answer index on the TV`);
      assert.equal(view.question.answerText, '', `${q.type} (${view.phase}): no answer text on the TV`);
      assert.equal(view.question.hostText, undefined);
    }
    host.send({ t: 'advance' }); // reveal
    await tv.state('reveal', (v) => v.question?.index === i);
    if (q.type === 'buzzer') continue;
  }
  for (const c of [host, tv]) await c.close();
  await server.close();
});

test('every page carries headers that stop the host key leaking or the page being framed', async () => {
  const server = await start();
  // Error pages too: a 404 is typed and locked down like everything else.
  for (const path of ['/', '/host', '/screen', '/play.js', '/status.json', '/healthz', '/robots.txt', '/no-such-page']) {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.match(res.headers.get('permissions-policy') ?? '', /microphone=\(\)/, path);
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin', path);
    assert.match(res.headers.get('content-type') ?? '', /^(text|application)\//, `${path} has a content type`);
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
