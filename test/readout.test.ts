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

test('start the timer early, switch the mode off, and other question types are unaffected', () => {
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
  game.advance(); // letter question skips reading
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
