// Read-out mode: the host shows each multiple-choice answer, then starts the timer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';

const QUIZ = `
title: Read
readOut: true
scoring: { leaderboard: question }
rounds:
  - name: R
    questions:
      - { type: multiple-choice, text: Pick, options: [a, b, c], answer: 1 }
      - { type: letter, text: Who?, answer: Abba }
`;

test('answers appear one at a time and the timer only starts when the host says', () => {
  const game = new Game(parseQuiz(QUIZ));
  const t = game.join('A');
  assert.ok(t.ok);
  game.advance();
  assert.equal(game.phase, 'reading');
  const options = () => game.teamView(t.value.id)!.question!.options;
  assert.deepEqual(options(), []);
  assert.equal(game.teamView(t.value.id)!.question!.remainingMs, undefined, 'no clock yet');
  assert.equal(game.answer(t.value.id, 1).ok, false, 'cannot answer while it is being read');
  game.advance();
  game.advance();
  assert.deepEqual(options(), ['a', 'b']);
  assert.deepEqual(game.hostView().reading, { shown: 2, total: 3 });
  game.advance();
  assert.equal(game.phase, 'reading', 'all three showing, timer not started');
  game.advance();
  assert.equal(game.phase, 'open');
  assert.deepEqual(options(), ['a', 'b', 'c']);
  assert.ok(game.answer(t.value.id, 1).ok);
  game.dispose();
});

test('start the timer early, switch the mode off, and other question types wait for the host too', () => {
  const game = new Game(parseQuiz(QUIZ));
  game.join('A');
  assert.equal(game.startTimerNow().ok, false);
  game.advance();
  assert.ok(game.startTimerNow().ok);
  assert.equal(game.phase, 'open');
  assert.equal(game.teamView(game.hostView().teams[0]!.id)!.question!.options!.length, 3, 'every answer shows');
  game.advance(); // close
  game.advance(); // reveal
  game.advance(); // leaderboard
  game.advance(); // the letter question waits too, with nothing to reveal
  assert.equal(game.phase, 'reading');
  assert.equal(game.hostView().reading, undefined);
  game.advance();
  assert.equal(game.phase, 'open');
  game.dispose();

  const off = new Game(parseQuiz(QUIZ));
  off.setReadOut(false);
  off.advance();
  assert.equal(off.phase, 'open');
  off.dispose();
});

test('a question skipped while being read, and a saved game that is mid-reading', () => {
  const game = new Game(parseQuiz(QUIZ));
  const t = game.join('A');
  assert.ok(t.ok);
  game.advance();
  game.advance();
  const restored = Game.restore(game.quiz, JSON.parse(JSON.stringify(game.snapshot())));
  assert.equal(restored.phase, 'reading');
  assert.equal(restored.readOut, true);
  assert.deepEqual(restored.hostView().reading, { shown: 1, total: 3 }, 'keeps what was showing');
  restored.dispose();
  assert.ok(game.skip().ok);
  assert.equal(game.questionIndex, 1);
  game.dispose();
});

test('a question knows its place within its round, not the whole quiz', () => {
  const game = new Game(parseQuiz(`
title: Rounds
scoring: { leaderboard: question }
rounds:
  - name: One
    questions:
      - { type: letter, text: A, answer: Abba }
      - { type: letter, text: B, answer: Abba }
  - name: Two
    questions:
      - { type: letter, text: C, answer: Abba }
`));
  game.join('A');
  const place = () => [game.hostView().question!.roundQuestion, game.hostView().question!.roundQuestions];
  game.advance();
  assert.deepEqual(place(), [1, 2]);
  for (let i = 0; i < 3; i++) game.advance(); // close, reveal, leaderboard
  game.advance();
  assert.deepEqual(place(), [2, 2]);
  for (let i = 0; i < 4; i++) game.advance();
  assert.deepEqual(place(), [1, 1]);
  game.dispose();
});

test('letter questions: a grouped keypad is the default, and a tap on the key holding the letter is right', () => {
  const quiz = parseQuiz(`
title: Letters
scoring: { leaderboard: question }
rounds:
  - name: R
    questions:
      - { type: letter, text: Who sang Imagine?, answer: John Lennon }
      - { type: letter, text: Who sang Hey Jude?, answer: Paul McCartney, keypad: single }
`);
  const game = new Game(quiz);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => {
    const r = game.join(n);
    assert.ok(r.ok);
    return r.value;
  });
  game.advance();
  assert.equal(game.hostView().question!.keypad, 'grouped');
  assert.ok(game.answer(a!.id, 'J').ok);
  assert.ok(game.answer(b!.id, 'j').ok, 'a single letter is still accepted');
  assert.equal(game.answer(c!.id, 'JKL').ok, false, 'not a key');
  assert.ok(game.answer(c!.id, 'QV').ok, 'a shared key counts as a tap');
  game.advance();
  game.advance();
  assert.equal(game.teamView(a!.id)!.result!.correct, true);
  assert.equal(game.teamView(b!.id)!.result!.correct, true);
  assert.equal(game.teamView(c!.id)!.result!.correct, false);
  assert.match(game.hostView().summary!, /J ×2/);
  game.advance();
  game.advance();
  assert.equal(game.hostView().question!.keypad, 'single');
  game.dispose();
});

test('the quickest right answer is named to every screen on the reveal', async () => {
  let clock = 1_000_000;
  const game = new Game(parseQuiz(`
title: Fast
scoring: { leaderboard: question }
rounds:
  - name: R
    questions:
      - { type: multiple-choice, text: Q, options: [a, b], answer: 0 }
      - { type: nearest, text: N, answer: 5 }
`), { now: () => clock });
  const [slow, quick, wrong] = ['Slow', 'Quick', 'Wrong'].map((n) => {
    const r = game.join(n);
    assert.ok(r.ok);
    return r.value;
  });
  game.advance();
  assert.equal(game.teamView(slow!.id)!.speedster, undefined, 'not before the reveal');
  clock += 4000;
  game.answer(slow!.id, 0);
  clock += 100;
  game.answer(quick!.id, 0, 500);
  game.answer(wrong!.id, 1, 100);
  assert.equal(game.phase, 'closed', 'everyone answered');
  game.advance();
  assert.equal(game.phase, 'reveal');
  assert.deepEqual([game.teamView(wrong!.id)!.speedster?.name, game.hostView().speedster?.name], [quick!.name, quick!.name]);
  game.advance(); // leaderboard
  game.advance(); // the nearest question: speed is irrelevant
  for (const t of [slow, quick, wrong]) game.answer(t!.id, 5);
  game.advance();
  assert.equal(game.phase, 'reveal');
  assert.equal(game.hostView().speedster, undefined);
  game.dispose();
});

test('the server runs the clock down even when everyone has answered, unless closing early is switched on', async () => {
  const { createQuizServer } = await import('../server/server.ts');
  const { Client } = await import('./client.ts');
  const server = await createQuizServer({ quiz: parseQuiz(QUIZ.replace('readOut: true', 'readOut: false')), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const ann = await Client.connect(server.port);
  ann.send({ t: 'join', room: server.roomCode, name: 'Ann' });
  await ann.waitFor((m) => m.t === 'joined');
  host.send({ t: 'advance' });
  await ann.state('open');
  ann.send({ t: 'answer', value: 1 });
  const view = await host.state('open', (v) => v.answeredCount === 1);
  assert.equal(view.closeEarly, false);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(server.game!.phase, 'open', 'still counting down');
  host.send({ t: 'close-early', on: true });
  await host.state('open', (v) => v.closeEarly === true);
  for (const c of [host, ann]) await c.close();
  await server.close();
});

test('a team sees how long it took to lock in, and the fastest team is named with its time', () => {
  let clock = 5_000_000;
  const game = new Game(parseQuiz(QUIZ.replace('readOut: true', 'readOut: false')), { now: () => clock });
  const [a, b] = ['A', 'B'].map((n) => {
    const r = game.join(n);
    assert.ok(r.ok);
    return r.value;
  });
  game.advance();
  clock += 2320;
  game.answer(a!.id, 1);
  clock += 1000;
  game.answer(b!.id, 1);
  assert.equal(game.teamView(a!.id)!.myAnswerMs, 2320);
  assert.equal(game.teamView(b!.id)!.myAnswerMs, 3320);
  game.advance();
  assert.equal(game.hostView().speedster!.ms, 2320);
  game.dispose();
});
