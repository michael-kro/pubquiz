// M8b: number and nearest-wins questions, up to six options, and the info line.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, type Team } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';

const yaml = (questions: string, scoring = '{ leaderboard: question }') => `title: T\nscoring: ${scoring}\nrounds:\n  - name: R\n    questions:\n${questions}\n`;
const NUMBER = '      - { type: number, text: "Year the Berlin Wall fell?", answer: 1989, tolerance: 0, info: "It came down on 9 November." }';
const NEAREST = '      - { type: nearest, text: "Height of Everest in metres?", answer: 8849 }';

function setup(questions: string, scoring?: string) {
  let now = 0;
  const game = new Game(parseQuiz(yaml(questions, scoring)), { now: () => now });
  const join = (...names: string[]): Team[] => names.map((n) => {
    const r = game.join(n);
    assert.ok(r.ok);
    return r.value;
  });
  return { game, join, tick: (ms: number) => (now += ms) };
}

test('validation: numbers must be numbers, options are 2 to 6', () => {
  assert.throws(() => parseQuiz(yaml('      - { type: number, text: Q }')), /answer/);
  assert.throws(() => parseQuiz(yaml('      - { type: number, text: Q, answer: abc }')), /answer: must be a number/);
  assert.throws(() => parseQuiz(yaml('      - { type: nearest, text: Q, answer: 1e15 }')), /too big/);
  assert.throws(() => parseQuiz(yaml('      - { type: number, text: Q, answer: 5, tolerance: -1 }')), /tolerance/);
  const seven = '      - { type: multiple-choice, text: Q, options: [a, b, c, d, e, f, g], answer: 0 }';
  assert.throws(() => parseQuiz(yaml(seven)), /at most 6 options/);
  const six = parseQuiz(yaml('      - { type: multiple-choice, text: Q, options: [a, b, c, d, e, f], answer: 5 }'));
  assert.equal(six.questions[0]!.type === 'multiple-choice' && six.questions[0]!.options.length, 6);
  assert.equal(parseQuiz(yaml(NUMBER)).questions[0]!.info, 'It came down on 9 November.');
});

test('number: exact match, or within the tolerance, speed scored, and bad input refused', () => {
  const { game, join, tick } = setup('      - { type: number, text: Q, answer: 100, tolerance: 2 }\n' + '      - { type: number, text: Q2, answer: 0.3 }');
  const [exact, near, far, none] = join('Exact', 'Near', 'Far', 'None');
  game.advance();
  assert.equal(game.answer(exact!.id, 'abc' as unknown as number).ok, false, 'must be a number');
  assert.equal(game.answer(exact!.id, Number.NaN).ok, false);
  assert.equal(game.answer(exact!.id, 1e13).ok, false);
  assert.equal(game.answer(exact!.id, [1] as unknown as number).ok, false);
  tick(2_000);
  game.answer(exact!.id, 100);
  game.answer(near!.id, 102);
  game.answer(far!.id, 103);
  game.advance(); // close
  game.advance(); // reveal
  assert.equal(game.hostView().summary, '2 teams got it right');
  const points = [exact, near, far, none].map((t) => game.teamView(t!.id)!.result!.points);
  assert.deepEqual(points, [950, 950, 0, 0]);
  assert.equal(game.teamView(far!.id)!.myAnswerText, '103');
  assert.equal(game.teamView(exact!.id)!.result!.answerText, '100 (give or take 2)');

  game.advance(); // leaderboard
  game.advance(); // question 2 open
  game.answer(exact!.id, 0.1 + 0.2); // floating-point dust must not matter
  game.advance(); // close
  game.advance(); // reveal
  assert.equal(game.hostView().summary, '1 team got it right');
  assert.equal(game.teamView(exact!.id)!.myAnswerText, '0.3');
  assert.equal(game.teamView(exact!.id)!.result!.correct, true);
  game.dispose();
});

test('nearest wins: the closest guess takes the points, ties share them, speed and the fast bonus do not matter', () => {
  const { game, join, tick } = setup(NEAREST, '{ fastBonus: 500, fastPlaces: 3, leaderboard: question }');
  const [slowClosest, quick, tied, nobody] = join('Slow', 'Quick', 'Tied', 'Nobody');
  game.advance();
  game.answer(quick!.id, 8000);
  tick(15_000);
  game.answer(slowClosest!.id, 8850);
  game.answer(tied!.id, 8850);
  game.advance();
  const guesses = game.hostView().guesses!;
  assert.deepEqual(guesses.map((g) => [g.value, g.off, g.teams, g.winner]), [
    ['8850', 'off by 1', ['Slow', 'Tied'], true],
    ['8000', 'off by 849', ['Quick'], false],
  ]);
  game.advance();
  const result = (t: Team) => game.teamView(t.id)!.result!;
  assert.equal(result(slowClosest!).points, 1000, 'no speed scaling');
  assert.equal(result(tied!).points, 1000, 'a tie shares the win');
  assert.equal(result(quick!).points, 0);
  assert.equal(result(nobody!).points, 0);
  assert.equal(result(slowClosest!).detail, 'Closest guess (off by 1)');
  assert.equal(result(quick!).detail, 'Off by 849');
  assert.deepEqual(game.hostView().fastest, [], 'no speed bonus on a nearest question');
  game.dispose();
});

test('nearest wins: spot on is called out, and with one team that team wins', () => {
  const { game, join } = setup(NEAREST);
  const [a] = join('A');
  game.advance();
  game.answer(a!.id, 8849);
  game.advance();
  assert.equal(game.teamView(a!.id)!.result!.detail, 'Closest guess: spot on!');
  assert.equal(game.hostView().guesses![0]!.off, 'spot on');
  game.dispose();
});

test('the info line reaches the host and teams only at the reveal', () => {
  const { game, join } = setup(NUMBER);
  const [a] = join('A');
  game.advance();
  game.answer(a!.id, 1989);
  assert.equal(game.teamView(a!.id)!.result, undefined);
  assert.equal(game.hostView().question!.info, 'It came down on 9 November.', 'the host always sees it');
  game.advance();
  assert.equal(game.teamView(a!.id)!.result!.info, 'It came down on 9 November.');
  game.dispose();
});

test('six multiple-choice options all work', () => {
  const { game, join } = setup('      - { type: multiple-choice, text: Q, options: [a, b, c, d, e, f], answer: 5 }');
  const [a, b] = join('A', 'B');
  game.advance();
  assert.equal(game.answer(a!.id, 5).ok, true);
  assert.equal(game.answer(b!.id, 6).ok, false);
  assert.equal(game.hostView().question!.options!.length, 6);
  game.advance();
  assert.deepEqual(game.hostView().distribution, [0, 0, 0, 0, 0, 1]);
  game.dispose();
});
