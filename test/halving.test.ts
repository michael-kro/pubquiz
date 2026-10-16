// A round (usually the last) where one wrong answer halves a team's score for that round.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, type Team } from '../server/game.ts';
import { parseQuiz, QuizError } from '../server/quiz.ts';

const QUIZ = `
title: Halve
scoring: { mode: flat, leaderboard: question }
rounds:
  - name: Warm up
    questions:
      - { type: multiple-choice, text: W, options: [a, b], answer: 0, points: 100 }
  - name: Final
    halveOnWrong: true
    questions:
      - { type: multiple-choice, text: F1, options: [a, b], answer: 0, points: 100 }
      - { type: multiple-choice, text: F2, options: [a, b], answer: 0, points: 100 }
      - { type: multiple-choice, text: F3, options: [a, b], answer: 0, points: 100 }
      - { type: nearest, text: F4, answer: 50, points: 100 }
`;

function play() {
  const game = new Game(parseQuiz(QUIZ));
  const join = (name: string): Team => {
    const r = game.join(name);
    assert.ok(r.ok);
    return r.value;
  };
  const score = (t: Team) => game.standings().find((r) => r.teamId === t.id)!.score;
  /** Opens the next question, lets every team in `answers` answer (index or text), and reveals it. */
  const ask = (answers: Map<Team, number | undefined>) => {
    if (game.phase === 'lobby' || game.phase === 'leaderboard') game.advance();
    assert.equal(game.phase, 'open');
    for (const [team, value] of answers) if (value !== undefined) game.answer(team.id, value);
    game.advance(); // close
    game.advance(); // reveal
  };
  const next = () => game.advance(); // leaderboard
  return { game, join, score, ask, next };
}

test('without a wrong answer a halving round pays in full', () => {
  const { game, join, score, ask, next } = play();
  const [a, b] = [join('A'), join('B')];
  ask(new Map([[a, 0], [b, 0]])); next();
  for (let i = 0; i < 3; i++) { ask(new Map([[a, 0], [b, 0]])); next(); }
  assert.equal(score(a), 400);
  game.dispose();
});

test('one wrong answer halves the whole round, before and after it, but not earlier rounds', () => {
  const { game, join, score, ask, next } = play();
  const [a, b] = [join('A'), join('B')];
  ask(new Map([[a, 0], [b, 0]])); next(); // warm up: both 100
  ask(new Map([[a, 0], [b, 0]])); next(); // F1: both 200 total
  assert.equal(score(b), 200);
  ask(new Map([[a, 0], [b, 1]])); // F2: B is wrong
  assert.equal(score(a), 300);
  assert.equal(score(b), 100 + 100 / 2 * 1, 'warm-up 100 + half of the round so far (100 from F1, nothing for F2)');
  const result = game.teamView(b.id)!.result!;
  assert.equal(result.points, -50, 'the question took 50 off B');
  assert.match(result.detail ?? '', /halved/);
  const standing = game.standings().find((r) => r.teamId === b.id)!;
  assert.equal(standing.gained, -50);
  next();
  ask(new Map([[a, 0], [b, 0]])); // F3: both right
  assert.equal(score(a), 400);
  assert.equal(score(b), 100 + (100 + 0 + 100) / 2, 'later right answers still count, at half');
  assert.match(game.teamView(b.id)!.result!.detail ?? '', /halved after a wrong answer/);
  game.dispose();
});

test('not answering does not halve, a second wrong answer does not halve again, and closest-wins never triggers it', () => {
  const { game, join, score, ask, next } = play();
  const [quiet, twice, nearest] = [join('Quiet'), join('Twice'), join('Nearest')];
  ask(new Map([[quiet, 0], [twice, 0], [nearest, 0]])); next(); // warm up
  ask(new Map<Team, number | undefined>([[quiet, undefined], [twice, 1], [nearest, 0]])); next(); // F1
  assert.equal(score(quiet), 100, 'no answer: nothing earned, nothing halved');
  assert.equal(score(twice), 100 + 0, 'wrong: round so far is 0, halved is 0');
  ask(new Map<Team, number | undefined>([[quiet, 0], [twice, 1], [nearest, 0]])); next(); // F2
  assert.equal(score(quiet), 200, 'the quiet team is not halved');
  assert.equal(score(twice), 100, 'two wrong answers halve once, not twice');
  ask(new Map<Team, number | undefined>([[quiet, 0], [twice, 0], [nearest, 0]])); next(); // F3: twice gets one right
  assert.equal(score(twice), 100 + 50);
  ask(new Map([[quiet, 7], [twice, 7], [nearest, 50]])); // F4 closest wins: not a right or wrong answer
  assert.equal(score(quiet), 300);
  assert.equal(score(twice), 150, 'a non-winning guess on a closest-wins question is not a wrong answer');
  assert.equal(score(nearest), 500, 'right every time, plus the closest guess');
  game.dispose();
});

test('a host change of the answer recalculates, and the round is flagged for phones, the TV and the results', () => {
  const { game, join, score } = play();
  const a = join('A');
  join('Other');
  game.advance();
  game.answer(a.id, 0);
  game.advance(); game.advance(); game.advance(); game.advance(); // close, reveal, leaderboard, open F1
  assert.equal(game.phase, 'open');
  assert.equal(game.hostView().question!.halveOnWrong, true);
  assert.equal(game.teamView(a.id)!.question!.halveOnWrong, true);
  game.answer(a.id, 1);
  game.advance(); // close
  game.setAnswer(1); // the host decides b was right all along (time is up, before the reveal)
  game.advance(); // reveal
  assert.equal(score(a), 100 + 100, 'the answer was changed to the one A gave: no halving');
  assert.match(game.resultsTable()[0]!.join('|'), /before halving/);
  game.dispose();
});

test('a round cannot be both a wager round and a halving round', () => {
  assert.throws(() => parseQuiz(QUIZ.replace('halveOnWrong: true', 'halveOnWrong: true\n    wager: true')), (e) => e instanceof QuizError && /both a wager round and a halve/.test(e.message));
});
