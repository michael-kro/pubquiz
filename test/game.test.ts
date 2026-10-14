import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Game, MAX_TEAMS, type Team } from '../server/game.ts';
import type { Quiz } from '../server/quiz.ts';
import { scoreAnswer } from '../server/scoring.ts';

const quiz: Quiz = {
  title: 'Test',
  speedFactor: 0.5,
  questions: [
    { type: 'multiple-choice', round: 'R1', text: 'Q1', options: ['a', 'b', 'c', 'd'], answer: 1, seconds: 20, points: 1000 },
    { type: 'multiple-choice', round: 'R1', text: 'Q2', options: ['a', 'b'], answer: 0, seconds: 10, points: 1000 },
  ],
  media: new Map(),
};

function setup() {
  let now = 1_000_000;
  const game = new Game(quiz, { now: () => now });
  const clock = { advance: (ms: number) => (now += ms) };
  return { game, clock };
}

function join(game: Game, name: string): Team {
  const result = game.join(name);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.value;
}

test('scoring: full points instantly, half at the deadline, none when wrong', () => {
  const base = { points: 1000, durationMs: 20_000, speedFactor: 0.5 };
  assert.equal(scoreAnswer({ ...base, correct: true, answerMs: 0 }), 1000);
  assert.equal(scoreAnswer({ ...base, correct: true, answerMs: 10_000 }), 750);
  assert.equal(scoreAnswer({ ...base, correct: true, answerMs: 99_000 }), 500);
  assert.equal(scoreAnswer({ ...base, correct: true, answerMs: -50 }), 1000);
  assert.equal(scoreAnswer({ ...base, correct: false, answerMs: 0 }), 0);
  assert.equal(scoreAnswer({ ...base, speedFactor: 0, correct: true, answerMs: 19_000 }), 1000);
});

test('team names: trimmed, unique ignoring case, length-limited, capped at 30 teams', () => {
  const { game } = setup();
  assert.equal(join(game, '  The   Quizzards ').name, 'The Quizzards');
  assert.deepEqual(game.join('the quizzards'), { ok: false, error: 'That team name is taken. Pick another.' });
  assert.equal(game.join('   ').ok, false);
  assert.equal(game.join('x'.repeat(25)).ok, false);
  for (let i = 1; i < MAX_TEAMS; i++) join(game, `Team ${i}`);
  const full = game.join('One Too Many');
  assert.ok(!full.ok && full.error.includes('full'));
  game.dispose();
});

test('plays a full quiz: timing-based points, scores hidden until reveal, ties share a rank', () => {
  const { game, clock } = setup();
  const fast = join(game, 'Fast');
  const slow = join(game, 'Slow');
  const wrong = join(game, 'Wrong');

  game.advance();
  assert.equal(game.phase, 'open');
  clock.advance(2_000);
  assert.ok(game.answer(fast.id, 1).ok);
  clock.advance(8_000);
  assert.ok(game.answer(slow.id, 1).ok);
  assert.equal(game.phase, 'open', 'stays open until every team has answered');
  assert.deepEqual(game.answer(slow.id, 2), { ok: false, error: 'Your team has already answered.' });
  assert.ok(game.answer(wrong.id, 0).ok);
  assert.equal(game.phase, 'closed', 'closes once every connected team has answered');

  assert.equal(game.teamView(fast.id)!.score, 0, 'points are not shown before the reveal');
  assert.equal(game.teamView(fast.id)!.result, undefined);
  assert.deepEqual(game.hostView().distribution, [1, 2, 0, 0]);

  game.advance();
  assert.equal(game.phase, 'reveal');
  assert.deepEqual(game.teamView(fast.id)!.result, { correctIndex: 1, correct: true, points: 950, answerText: 'b', detail: undefined });
  assert.deepEqual(game.teamView(slow.id)!.result, { correctIndex: 1, correct: true, points: 750, answerText: 'b', detail: undefined });
  assert.deepEqual(game.teamView(wrong.id)!.result, { correctIndex: 1, correct: false, points: 0, answerText: 'b', detail: undefined });

  game.advance();
  assert.equal(game.phase, 'leaderboard');
  assert.deepEqual(
    game.standings().map((r) => [r.name, r.score, r.rank]),
    [
      ['Fast', 950, 1],
      ['Slow', 750, 2],
      ['Wrong', 0, 3],
    ],
  );

  // Question 2: host closes it early; only Wrong answers, correctly, so it ties nobody.
  game.advance();
  assert.equal(game.questionIndex, 1);
  clock.advance(10_000);
  assert.ok(game.answer(wrong.id, 0).ok, 'an answer exactly at the deadline still counts');
  game.advance();
  assert.equal(game.phase, 'closed');
  assert.equal(game.answer(fast.id, 0).ok, false);
  game.advance();
  game.advance();
  game.advance();
  assert.equal(game.phase, 'finished');
  assert.equal(game.teamView(fast.id)!.standings!.length, 3);
  game.advance();
  assert.equal(game.phase, 'finished', 'advance does nothing once finished');
  assert.equal(game.join('Latecomer').ok, false);
  game.dispose();
});

test('equal scores share a rank', () => {
  const { game } = setup();
  const a = join(game, 'A');
  const b = join(game, 'B');
  join(game, 'C');
  game.advance();
  game.answer(a.id, 1);
  game.answer(b.id, 1);
  game.advance();
  game.advance();
  game.advance();
  assert.deepEqual(
    game.standings().map((r) => r.rank),
    [1, 1, 3],
  );
  game.dispose();
});

test('rejects invalid choices and unknown teams', () => {
  const { game } = setup();
  const team = join(game, 'A');
  assert.equal(game.answer(team.id, 0).ok, false, 'no question open in the lobby');
  game.advance();
  assert.equal(game.answer(team.id, 4).ok, false);
  assert.equal(game.answer(team.id, -1).ok, false);
  assert.equal(game.answer('nope', 1).ok, false);
  game.dispose();
});

test('a team that reconnects mid-question keeps its original start time', () => {
  const { game, clock } = setup();
  const a = join(game, 'A');
  join(game, 'B');
  game.advance();
  clock.advance(10_000);
  game.disconnect(a.id);
  assert.equal(game.hostView().connectedCount, 1);
  assert.equal(game.rejoin(a.token)?.id, a.id);
  game.answer(a.id, 1);
  game.advance();
  game.advance();
  assert.equal(game.teamView(a.id)!.result!.points, 750);
  assert.equal(game.rejoin('bad-token'), undefined);
  game.dispose();
});

test('disconnected teams do not hold up auto-close; kicking the last holdout closes the question', () => {
  const { game } = setup();
  const a = join(game, 'A');
  const b = join(game, 'B');
  const c = join(game, 'C');
  game.advance();
  game.disconnect(c.id);
  game.answer(a.id, 1);
  assert.equal(game.phase, 'open');
  assert.ok(game.kick(b.id));
  assert.equal(game.phase, 'closed');
  assert.equal(game.getTeam(b.id), undefined);
  assert.equal(game.kick(b.id), false);
  game.dispose();
});

test('the question closes by itself when time runs out', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const game = new Game(quiz);
    join(game, 'A');
    game.advance();
    mock.timers.tick(19_999);
    assert.equal(game.phase, 'open');
    assert.equal(game.hostView().question!.remainingMs, 1);
    mock.timers.tick(1);
    assert.equal(game.phase, 'closed');
    game.dispose();
  } finally {
    mock.timers.reset();
  }
});
