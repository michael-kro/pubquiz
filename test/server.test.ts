// Plays a quiz end to end against the real server over WebSockets.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer, type QuizServer } from '../server/server.ts';
import { Client, type Message } from './client.ts';

const quiz = parseQuiz(`
title: Server Test
scoring: { leaderboard: question }
rounds:
  - name: R1
    questions:
      - { type: multiple-choice, text: Q1, options: [a, b, c], answer: 1, seconds: 30 }
      - { type: multiple-choice, text: Q2, options: [a, b], answer: 0, seconds: 30 }
`);

let server: QuizServer;

before(async () => {
  server = await createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
});

after(async () => {
  await server.close();
});

async function joinTeam(name: string): Promise<{ client: Client; token: string }> {
  const client = await Client.connect(server.port);
  client.send({ t: 'join', room: server.roomCode.toLowerCase(), name });
  const joined = await client.waitFor((m) => m.t === 'joined' || m.t === 'error');
  assert.equal(joined.t, 'joined', joined.message);
  return { client, token: joined.token };
}

test('serves the team page, host page and QR code', async () => {
  const base = `http://127.0.0.1:${server.port}`;
  for (const [path, type] of [
    ['/', 'text/html'],
    ['/host', 'text/html'],
    ['/play.js', 'text/javascript'],
    ['/qr.svg', 'image/svg+xml'],
  ] as const) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.ok(res.headers.get('content-type')?.startsWith(type), path);
  }
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal(server.joinUrl, `http://127.0.0.1:${server.port}/?room=${server.roomCode}`);
});

test('rejects a wrong host key and a wrong room code', async () => {
  const fakeHost = await Client.connect(server.port);
  fakeHost.send({ t: 'host', key: 'guess' });
  assert.match((await fakeHost.waitFor((m) => m.t === 'error')).message, /Wrong host key/);

  const team = await Client.connect(server.port);
  team.send({ t: 'join', room: 'ZZZZ', name: 'Lost' });
  assert.match((await team.waitFor((m) => m.t === 'error')).message, /room code/);
  team.send({ t: 'advance' });
  assert.match((await team.waitFor((m) => m.t === 'error')).message, /Only the host/);
  await team.close();
  await fakeHost.close();
});

test('three teams play a whole quiz, including a reconnect and a kick', async () => {
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  await host.state('lobby');

  const alpha = await joinTeam('Alpha');
  const bravo = await joinTeam('Bravo');
  const charlie = await joinTeam('Charlie');
  await host.state('lobby', (v) => v.teams.length === 3);

  const dupe = await Client.connect(server.port);
  dupe.send({ t: 'join', room: server.roomCode, name: 'ALPHA' });
  assert.match((await dupe.waitFor((m) => m.t === 'error')).message, /taken/);
  await dupe.close();

  // Question 1: everyone answers, so it closes without the host.
  host.send({ t: 'advance' });
  const q1 = await alpha.client.state('open');
  assert.equal(q1.question.text, 'Q1');
  assert.ok(q1.question.remainingMs > 25_000);
  alpha.client.send({ t: 'answer', value: 1 });
  bravo.client.send({ t: 'answer', value: 0 });
  charlie.client.send({ t: 'answer', value: 1 });
  const closed = await host.state('closed');
  assert.deepEqual(closed.distribution, [1, 2, 0]);

  host.send({ t: 'advance' });
  const alphaReveal = await alpha.client.state('reveal');
  assert.equal(alphaReveal.result.correct, true);
  assert.ok(alphaReveal.result.points > 900);
  assert.equal((await bravo.client.state('reveal')).result.points, 0);

  host.send({ t: 'advance' });
  const board = await host.state('leaderboard');
  assert.deepEqual(
    board.standings.map((r: Message) => r.name).slice(2),
    ['Bravo'],
  );

  // Charlie's phone drops and comes back with its stored token.
  await charlie.client.close();
  await host.state('leaderboard', (v) => v.connectedCount === 2);
  const charlieAgain = await Client.connect(server.port);
  charlieAgain.send({ t: 'rejoin', token: charlie.token });
  assert.equal((await charlieAgain.waitFor((m) => m.t === 'joined')).teamName, 'Charlie');
  const restored = await charlieAgain.state('leaderboard');
  assert.ok(restored.score > 500);

  // Opening the team on a second device moves the team there.
  const charlieThird = await Client.connect(server.port);
  charlieThird.send({ t: 'rejoin', token: charlie.token });
  await charlieThird.waitFor((m) => m.t === 'joined');
  await charlieAgain.waitFor((m) => m.t === 'replaced');

  // Host removes Bravo.
  const bravoId = board.standings.find((r: Message) => r.name === 'Bravo').teamId;
  host.send({ t: 'kick', teamId: bravoId });
  await bravo.client.waitFor((m) => m.t === 'kicked');
  await host.state('leaderboard', (v) => v.teams.length === 2);

  // Question 2: nobody answers, host closes it and runs to the end.
  host.send({ t: 'advance' });
  await host.state('open');
  alpha.client.send({ t: 'answer', value: 9 });
  assert.match((await alpha.client.waitFor((m) => m.t === 'error')).message, /not one of the options/);
  host.send({ t: 'advance' });
  await host.state('closed');
  for (let i = 0; i < 3; i++) host.send({ t: 'advance' });
  const final = await charlieThird.state('finished');
  assert.equal(final.standings.length, 2);

  const rejected = await Client.connect(server.port);
  rejected.send({ t: 'rejoin', token: 'not-a-token' });
  await rejected.waitFor((m) => m.t === 'rejoin-failed');

  for (const c of [host, alpha.client, charlieThird, rejected]) await c.close();
});
