// M2 exit test: phones dropping mid-question, and the whole server restarting mid-quiz.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { test } from 'node:test';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer, type QuizServer } from '../server/server.ts';
import { createSaver, readSession } from '../server/session.ts';
import { Client, type Message } from './client.ts';

const quiz = parseQuiz(`
title: Robust
scoring: { leaderboard: question }
rounds:
  - name: R
    questions:
      - { type: multiple-choice, text: Q1, options: [a, b], answer: 0, seconds: 30 }
      - { type: multiple-choice, text: Q2, options: [a, b], answer: 1, seconds: 30 }
`);

const start = (extra: Partial<Parameters<typeof createQuizServer>[0]> = {}) =>
  createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', ...extra });

async function hostOf(server: QuizServer): Promise<Client> {
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  await host.waitFor((m) => m.t === 'state');
  return host;
}

async function join(server: QuizServer, name: string): Promise<{ client: Client; token: string }> {
  const client = await Client.connect(server.port);
  client.send({ t: 'join', room: server.roomCode, name });
  const joined = await client.waitFor((m) => m.t === 'joined');
  return { client, token: joined.token };
}

async function rejoin(server: QuizServer, token: string): Promise<Client> {
  const client = await Client.connect(server.port);
  client.send({ t: 'rejoin', token });
  await client.waitFor((m) => m.t === 'joined');
  return client;
}

test('phones that lose signal mid-question: the question carries on, and they can rejoin and answer', async () => {
  const server = await start();
  const host = await hostOf(server);
  const teams = await Promise.all(['A', 'B', 'C', 'D'].map((name) => join(server, name)));
  const [a, b, c, d] = teams as [(typeof teams)[0], (typeof teams)[0], (typeof teams)[0], (typeof teams)[0]];

  host.send({ t: 'advance' });
  await host.state('open');
  a.client.send({ t: 'answer', value: 0 });

  // C and D lose signal without a clean close (airplane mode).
  c.client.ws.terminate();
  d.client.ws.terminate();
  await host.state('open', (v) => v.connectedCount === 2);

  // C comes back mid-question and answers; D stays offline.
  const cAgain = await rejoin(server, c.token);
  const cView = await cAgain.state('open');
  assert.ok(cView.question.remainingMs > 0, 'the rejoined phone gets the live question');
  cAgain.send({ t: 'answer', value: 0 });
  b.client.send({ t: 'answer', value: 1 });

  // Every connected team has answered, so it closes without waiting for D.
  const closed = await host.state('closed');
  assert.deepEqual(
    closed.teams.map((t: Message) => [t.name, t.connected, t.answered]),
    [
      ['A', true, true],
      ['B', true, true],
      ['C', true, true],
      ['D', false, false],
    ],
  );

  host.send({ t: 'advance' });
  host.send({ t: 'advance' });
  const board = await host.state('leaderboard');
  const scores = Object.fromEntries(board.standings.map((r: Message) => [r.name, r.score]));
  assert.ok(scores.A > 0 && scores.C > 0);
  assert.equal(scores.B, 0);
  assert.equal(scores.D, 0);

  // D comes back at the leaderboard and sees it.
  const dAgain = await rejoin(server, d.token);
  assert.equal((await dAgain.state('leaderboard')).teamName, 'D');

  // A duplicate answer, an answer after closing and a junk message are all refused politely.
  a.client.send({ t: 'answer', value: 1 });
  assert.match((await a.client.waitFor((m) => m.t === 'error')).message, /closed/);
  a.client.ws.send('not json');
  assert.equal((await a.client.waitFor((m) => m.t === 'error')).message, 'Unrecognised message.');

  for (const client of [host, a.client, b.client, cAgain, dAgain]) await client.close();
  await server.close();
});

test('a silent connection is dropped after missed pings, so the team shows as offline', async () => {
  const server = await start({ pingIntervalMs: 50 });
  const host = await hostOf(server);
  const team = await join(server, 'Sleepy');
  // Stop answering pings, like a phone that went to sleep without closing the socket.
  (team.client.ws as unknown as { pong: () => void }).pong = () => {};
  // ws replies to pings automatically; remove that so pings go unanswered.
  team.client.ws.removeAllListeners('ping');
  (team.client.ws as unknown as { _receiver: { removeAllListeners: (e: string) => void } })._receiver.removeAllListeners('ping');
  await host.waitFor((m) => m.t === 'state' && m.view.teams[0]?.connected === false, 3000);
  await host.close();
  await server.close();
});

test('the server restarts mid-question and carries on: same room, same host link, scores kept', async (t) => {
  const dir = await mkdtemp(joinPath(tmpdir(), 'pubquiz-'));
  const path = joinPath(dir, 'quiz.session.json');
  const session = { path, quizHash: 'test' };

  const first = await start({ session });
  t.after(() => first.close());
  const host = await hostOf(first);
  const a = await join(first, 'A');
  const b = await join(first, 'B');
  host.send({ t: 'advance' });
  await host.state('open');
  a.client.send({ t: 'answer', value: 0 });
  b.client.send({ t: 'answer', value: 0 });
  for (let i = 0; i < 3; i++) host.send({ t: 'advance' });
  await host.state('open', (v) => v.question.index === 1);
  a.client.send({ t: 'answer', value: 1 });
  await host.state('open', (v) => v.answeredCount === 1);
  const scoresBefore = (await a.client.state('open', (v) => v.question.index === 1)).score;
  assert.ok(scoresBefore > 0);
  await first.close(); // like a crash: everything in memory is gone

  const saved = await readSession(path);
  assert.ok(saved);
  assert.equal(saved.game.phase, 'open');

  const second = await start({ session: { ...session, resume: saved } });
  t.after(() => second.close());
  assert.equal(second.roomCode, first.roomCode);
  assert.equal(second.hostKey, first.hostKey);

  const host2 = await hostOf(second);
  const a2 = await rejoin(second, a.token);
  const b2 = await rejoin(second, b.token);
  const aView = await a2.state('open');
  assert.equal(aView.score, scoresBefore);
  assert.equal(aView.myAnswerText, 'b', "A's answer from before the restart is kept");
  b2.send({ t: 'answer', value: 0 });
  await host2.state('closed');
  host2.send({ t: 'advance' });
  host2.send({ t: 'advance' });
  host2.send({ t: 'advance' });
  const final = await host2.state('finished');
  assert.deepEqual(
    final.standings.map((r: Message) => r.name),
    ['A', 'B'],
  );
  for (const client of [host, a.client, b.client, host2, a2, b2]) await client.close();
  await second.close();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).game.phase, 'finished');
});

test('the saver coalesces bursts of changes and always writes the latest state', async () => {
  const written: number[] = [];
  let state = 0;
  const saver = createSaver(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    written.push(state);
  }, 20);
  for (state = 1; state <= 5; state++) saver.schedule();
  state = 5;
  await saver.flush();
  saver.schedule();
  state = 6;
  await saver.flush();
  assert.deepEqual(written, [5, 6]);
});
