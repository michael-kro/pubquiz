// "Rank" scoring: a right answer is worth 10, plus 10 for the fastest right answer, 9 for the next, 8, and so on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, type Team } from '../server/game.ts';
import { DEFAULT_POINTS, parseQuiz } from '../server/quiz.ts';

const QUIZ = (extra = '') => `
title: Rank
${extra}
rounds:
  - name: R
    questions:
      - { type: multiple-choice, text: Q1, options: [a, b], answer: 0 }
      - { type: nearest, text: Q2, answer: 50 }
`;

function setup(names: string[], yaml = QUIZ()) {
  let clock = 1_000_000;
  const game = new Game(parseQuiz(yaml), { now: () => clock, closeEarly: false });
  const teams = names.map((n) => {
    const r = game.join(n);
    assert.ok(r.ok);
    return r.value;
  });
  const score = (t: Team) => game.standings().find((r) => r.teamId === t.id)!.score;
  const tick = (ms: number) => (clock += ms);
  return { game, teams, score, tick };
}

test('without a scoring block a quiz uses rank scoring, with questions worth 10', () => {
  // The suite runs with PUBQUIZ_SCORING_DEFAULT=speed; ask for the real default in a fresh process.
  const out = (async () => {
    const { execFileSync } = await import('node:child_process');
    const env = { ...process.env, PUBQUIZ_SCORING_DEFAULT: '', PUBQUIZ_POINTS_UNIT: '' };
    return execFileSync(process.execPath, ['--input-type=module', '-e', "import('./server/quiz.ts').then((m) => { const q = m.parseQuiz('title: T\\nrounds:\\n  - name: R\\n    questions:\\n      - { type: letter, text: Q, answer: Abba }\\n'); console.log(q.questions[0].mode, q.questions[0].points, q.rankBonus); })"], { env, encoding: 'utf8' }).trim();
  })();
  return out.then((text) => assert.equal(text, 'rank 10 10'));
});

test('a right answer is 10, the fastest gets +10, then +9, +8, and wrong answers get nothing', () => {
  const { game, teams, score, tick } = setup(['A', 'B', 'C', 'D'], QUIZ('scoring: { mode: rank }'));
  const [a, b, c, d] = teams as [Team, Team, Team, Team];
  game.advance();
  tick(1000);
  game.answer(a.id, 0);
  tick(1000);
  game.answer(b.id, 0);
  tick(1000);
  game.answer(c.id, 1); // quicker than D but wrong
  tick(1000);
  game.answer(d.id, 0);
  game.advance(); // close
  game.advance(); // reveal
  assert.equal(score(a), 10 + 10, 'fastest');
  assert.equal(score(b), 10 + 9, 'second fastest');
  assert.equal(score(c), 0, 'wrong: nothing, and not counted in the ranking');
  assert.equal(score(d), 10 + 8, 'third among the RIGHT answers, even though C was quicker');
  const result = game.teamView(a.id)!.result!;
  assert.equal(result.points, 20);
  assert.match(result.detail ?? '', /10 for the right answer \+ 10 for the fastest answer/);
  assert.match(game.teamView(d.id)!.result!.detail ?? '', /3rd fastest/);
  game.dispose();
});

test('the bonus runs out after the tenth, closest-wins questions have none, and the bonus is adjustable', () => {
  const names = Array.from({ length: 12 }, (_, i) => `Team ${i + 1}`);
  const { game, teams, score, tick } = setup(names, QUIZ('scoring: { mode: rank }'));
  game.advance();
  for (const t of teams) {
    tick(100);
    game.answer(t.id, 0);
  }
  game.advance();
  game.advance();
  assert.deepEqual(teams.map(score), [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 10], '10 + 10 down to 10 + 1, then just 10');
  game.advance(); // mid-round: straight on to the closest-wins question
  for (const t of teams) game.answer(t.id, 50);
  game.advance();
  game.advance();
  assert.equal(score(teams[0]!), 20 + 10, 'closest wins pays its flat points: no speed bonus');
  game.dispose();

  const small = setup(['A', 'B'], QUIZ('scoring: { mode: rank, rankBonus: 3 }'));
  small.game.advance();
  small.tick(100);
  small.game.answer(small.teams[0]!.id, 0);
  small.tick(100);
  small.game.answer(small.teams[1]!.id, 0);
  small.game.advance();
  small.game.advance();
  assert.deepEqual(small.teams.map(small.score), [13, 12], 'a bonus of 3: +3 then +2');
  small.game.dispose();
});

test('a question can set its own points, a round can use another mode, and rank is a valid choice in the file', () => {
  const quiz = parseQuiz(`
title: Mixed
scoring: { mode: rank }
rounds:
  - name: Ranked
    questions:
      - { type: letter, text: Q, answer: Abba }
      - { type: letter, text: Q2, answer: Abba, points: 25 }
  - name: Flat
    mode: flat
    questions:
      - { type: letter, text: Q3, answer: Abba }
`);
  assert.deepEqual(quiz.questions.map((q) => [q.mode, q.points]), [['rank', 10], ['rank', 25], ['flat', DEFAULT_POINTS]]);
  assert.throws(() => parseQuiz('title: T\nscoring: { mode: nonsense }\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: A }\n'), /must be one of: rank, speed, flat, first/);
});
