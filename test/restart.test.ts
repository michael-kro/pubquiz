// The program stops in the middle of a quiz (a crash, a closed laptop) and is started again: what comes back.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Game } from '../server/game.ts';
import { Library } from '../server/library.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer, type QuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const QUIZ = 'title: Restart\nrounds:\n  - name: R\n    questions:\n      - { type: multiple-choice, text: Q1, options: [a, b, c], answer: 0, seconds: 30 }\n      - { type: multiple-choice, text: Q2, options: [a, b, c], answer: 1, seconds: 30 }\n      - { type: number, text: Q3, answer: 7, seconds: 30 }\n';

const open = (dir: string): Promise<QuizServer> =>
  createQuizServer({ closeEarly: false, lockOnStart: false, tvShowTeams: true, allowEmptyStart: true, library: new Library(dir), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
const run = (server: QuizServer, fresh: boolean) =>
  fetch(`http://127.0.0.1:${server.port}/api/quizzes/restart/run`, { method: 'POST', headers: { 'x-host-key': server.hostKey, 'content-type': 'application/json' }, body: JSON.stringify({ fresh }) });

test('a question that was open when the program stopped comes back paused, with the time it had left', async () => {
  const quiz = parseQuiz(QUIZ);
  let now = 1_000_000;
  const game = new Game(quiz, { now: () => now });
  game.closeEarly = false; // one team answering must not close the question
  const team = game.join('Alpha');
  assert.ok(team.ok);
  game.advance(); // lobby → Q1 open
  assert.equal(game.phase, 'open');
  now += 12_000; // 18 s left
  assert.ok(game.answer(team.value.id, 0).ok);
  const snapshot = JSON.parse(JSON.stringify(game.snapshot()));

  now += 90_000; // the program was down for a minute and a half
  const back = Game.restore(quiz, snapshot, { now: () => now });
  assert.equal(back.phase, 'open', 'still the open question, not closed by a clock that ran on');
  assert.equal(back.restoredPaused, true);
  const view = back.hostView();
  assert.equal(view.question?.paused, true);
  assert.equal(view.question?.pausedByRestart, true);
  const left = view.question?.remainingMs ?? 0;
  assert.ok(Math.abs(left - 18_000) < 50, `18 s left, not ${left}`);
  assert.deepEqual(view.teams.map((t) => [t.name, t.answered]), [['Alpha', true]], 'the answer given before the stop is kept');

  assert.ok(back.resume().ok);
  assert.equal(back.restoredPaused, false);
  now += 5_000;
  const after = back.hostView().question?.remainingMs ?? 0;
  assert.ok(Math.abs(after - 13_000) < 50, `the clock runs from where it stopped: ${after}`);
});

test('phones that reconnect before the host resumes are let back in by themselves, with their scores', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pubquiz-restart-'));
  await mkdir(join(dir, 'restart'));
  await writeFile(join(dir, 'restart', 'quiz.yaml'), QUIZ);
  const first = await open(dir);
  assert.equal((await run(first, true)).status, 200);
  const host = await Client.connect(first.port);
  host.send({ t: 'host', key: first.hostKey });
  const phone = await Client.connect(first.port);
  phone.send({ t: 'join', room: first.roomCode, name: 'Alpha', phone: true });
  const token = (await phone.waitFor((m) => m.t === 'joined')).token as string;
  host.send({ t: 'advance' });
  await phone.state('open');
  phone.send({ t: 'answer', value: 0 });
  await host.state('open', (v) => v.teams[0]?.answered === true);
  host.send({ t: 'advance' }); // close
  host.send({ t: 'advance' }); // reveal: Alpha scores
  const scored = await host.state('reveal');
  assert.ok(scored.teams[0].score > 0);
  host.send({ t: 'advance' }); // Q2 open
  await host.state('open', (v) => v.question.index === 1);
  await new Promise((resolve) => setTimeout(resolve, 400)); // the session file is written a moment after each change
  await phone.close();
  await host.close();
  await first.close(); // the "crash": the process goes away with a question open

  const second = await open(dir);
  const again = await Client.connect(second.port);
  again.send({ t: 'rejoin', token, phone: true });
  const refused = await again.waitFor((m) => m.t === 'rejoin-failed');
  assert.equal(refused.reason, 'no-quiz', 'told to wait, not to start again');
  assert.equal((await fetch(`http://127.0.0.1:${second.port}/status.json`).then((r) => r.json())).running, false);

  // The host presses Resume. The phone sent nothing more, and is back in with its score, on the paused question.
  assert.equal((await run(second, false)).status, 200);
  const joined = await again.waitFor((m) => m.t === 'joined', 3000);
  assert.equal(joined.teamName, 'Alpha');
  const view = await again.state('open');
  assert.equal(view.question.index, 1);
  assert.equal(view.question.paused, true);
  assert.ok(view.score > 0, 'the score from before the restart');

  const host2 = await Client.connect(second.port);
  host2.send({ t: 'host', key: second.hostKey });
  const hv = await host2.state('open');
  assert.deepEqual(hv.teams.map((t: { name: string; connected: boolean }) => [t.name, t.connected]), [['Alpha', true]]);
  assert.equal(hv.question.pausedByRestart, true, 'the host is told why it is paused');
  host2.send({ t: 'resume' });
  await again.state('open', (v) => !v.question.paused);
  again.send({ t: 'answer', value: 1 });
  await host2.state('open', (v) => v.teams[0]?.answered === true);

  // A token nobody knows is still refused for good.
  const stranger = await Client.connect(second.port);
  stranger.send({ t: 'rejoin', token: 'nope' });
  assert.equal((await stranger.waitFor((m) => m.t === 'rejoin-failed')).reason, 'unknown');

  for (const c of [again, host2, stranger]) await c.close();
  await second.close();
});
