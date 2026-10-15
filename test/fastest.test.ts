// M8a: the quickest correct teams earn extra points.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, type Team } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';

const q = '{ type: multiple-choice, text: Q, options: [a, b], answer: 0, seconds: 20 }';
const make = (scoring: string) => parseQuiz(`title: T\nscoring: ${scoring}\nrounds:\n  - name: R\n    questions: [${q}, ${q}]\n`);

function setup(quiz = make('{ fastBonus: 300, fastPlaces: 3 }')) {
  let now = 0;
  const game = new Game(quiz, { now: () => now });
  const join = (...names: string[]): Team[] => names.map((n) => {
    const r = game.join(n);
    assert.ok(r.ok);
    return r.value;
  });
  return { game, join, tick: (ms: number) => (now += ms) };
}

test('the quickest three correct teams earn 100%, 60% and 30% of the bonus', () => {
  const { game, join, tick } = setup();
  const [a, b, c, d, wrong] = join('A', 'B', 'C', 'D', 'Wrong');
  game.advance();
  tick(1_000);
  game.answer(wrong!.id, 1); // quickest of all, but wrong: earns nothing
  tick(1_000);
  game.answer(b!.id, 0);
  tick(1_000);
  game.answer(a!.id, 0);
  tick(1_000);
  game.answer(d!.id, 0);
  tick(1_000);
  game.answer(c!.id, 0);
  game.advance();
  const result = (t: Team) => game.teamView(t.id)!.result!;
  // Speed points (half off at the deadline over 20 s) plus the bonus: 2 s, 3 s, 4 s, 5 s.
  assert.equal(result(b!).points, 950 + 300);
  assert.equal(result(a!).points, 925 + 180);
  assert.equal(result(d!).points, 900 + 90);
  assert.equal(result(c!).points, 875, 'fourth quickest: no bonus');
  assert.equal(result(wrong!).points, 0);
  assert.match(result(b!).detail!, /⚡ Fastest correct answer: \+300/);
  assert.match(result(a!).detail!, /⚡ Second fastest correct answer: \+180/);
  assert.match(result(d!).detail!, /Third fastest correct answer: \+90/);
  assert.equal(result(c!).detail, undefined);
  assert.deepEqual(game.hostView().fastest, [
    { name: 'B', points: 300, place: 1, ms: 2000 },
    { name: 'A', points: 180, place: 2, ms: 3000 },
    { name: 'D', points: 90, place: 3, ms: 4000 },
  ]);
  game.dispose();
});

test('fastPlaces limits who earns it, and a bonus of 0 turns it off', () => {
  const { game, join, tick } = setup(make('{ fastBonus: 200, fastPlaces: 1 }'));
  const [a, b] = join('A', 'B');
  game.advance();
  tick(1_000);
  game.answer(a!.id, 0);
  tick(1_000);
  game.answer(b!.id, 0);
  game.advance();
  assert.equal(game.hostView().fastest!.length, 1);
  assert.equal(game.teamView(b!.id)!.result!.points, 950, 'second quickest, but only one place earns the bonus');
  game.dispose();

  const off = setup(make('{ fastBonus: 0, fastPlaces: 3 }'));
  const [x] = off.join('X');
  off.game.advance();
  off.game.answer(x!.id, 0);
  off.game.advance();
  assert.deepEqual(off.game.hostView().fastest, []);
  assert.equal(off.game.teamView(x!.id)!.result!.points, 1000);
  off.game.dispose();
});

test('the bonus works with flat scoring, counts in the standings, and nothing is shown before the reveal', () => {
  const { game, join, tick } = setup(make('{ mode: flat, fastBonus: 500, fastPlaces: 2 }'));
  const [slow, quick] = join('Slow', 'Quick');
  game.advance();
  tick(1_000);
  game.answer(quick!.id, 0);
  tick(8_000);
  game.answer(slow!.id, 0);
  assert.deepEqual(game.hostView().fastest, [], 'not revealed yet');
  assert.equal(game.standings()[0]!.score, 0);
  game.advance();
  game.advance();
  assert.deepEqual(game.standings().map((r) => [r.name, r.score]), [['Quick', 1500], ['Slow', 1300]]);
  game.dispose();
});

test('first mode keeps its own bonus, and skipped questions pay no bonus', () => {
  const { game, join, tick } = setup(make('{ mode: first, bonus: 400, fastBonus: 999 }'));
  const [a, b] = join('A', 'B');
  game.advance();
  tick(1_000);
  game.answer(a!.id, 0);
  game.answer(b!.id, 0);
  game.advance();
  assert.equal(game.teamView(a!.id)!.result!.points, 1400, 'only first mode’s bonus, not the fastest-teams one');
  assert.equal(game.teamView(b!.id)!.result!.points, 1000);
  game.advance();
  game.advance();
  game.skip();
  assert.deepEqual(game.fastestTeams(), []);
  game.dispose();
});
