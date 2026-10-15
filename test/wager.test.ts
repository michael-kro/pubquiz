// Jeopardy-style wager round: teams bet points on a category before seeing the question.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, WAGER_FLOOR, type Team } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const QUIZ = `
title: Wager
scoring: { leaderboard: question, speedFactor: 0 }
rounds:
  - name: Warm up
    questions:
      - { type: multiple-choice, text: Easy one, options: [a, b], answer: 0, points: 1000 }
  - name: Final round
    wager: true
    wagerCap: 5000
    questions:
      - { type: multiple-choice, text: "Which river flows through Cairo?", category: Rivers, options: [Nile, Amazon], answer: 0 }
      - { type: ordering, text: "Smallest planet first", category: Planets, items: [Mercury, Mars, Venus, Earth, Jupiter] }
`;

function setup() {
  const game = new Game(parseQuiz(QUIZ));
  const join = (...names: string[]): Team[] => names.map((n) => {
    const r = game.join(n);
    assert.ok(r.ok);
    return r.value;
  });
  return { game, join };
}

/** Plays the warm-up question so teams start the final round with these scores (1000 for a right answer, else 0). */
function warmUp(game: Game, right: Team[], wrong: Team[]): void {
  game.advance();
  for (const t of right) game.answer(t.id, 0);
  for (const t of wrong) game.answer(t.id, 1);
  game.advance(); // reveal
  game.advance(); // leaderboard
}

test('the format: a round can be a wager round, with an optional cap and a category on each question', () => {
  const quiz = parseQuiz(QUIZ);
  assert.deepEqual(quiz.questions.map((q) => [q.wager, q.wagerCap, q.type === 'multiple-choice' || q.type === 'ordering' ? q.category : undefined]), [
    [false, undefined, undefined],
    [true, 5000, 'Rivers'],
    [true, 5000, 'Planets'],
  ]);
  assert.throws(() => parseQuiz(QUIZ.replace('wagerCap: 5000', 'wagerCap: 0')), /wagerCap/);
});

test('while teams bet they see only the category; the host sees the question; then the host shows it', () => {
  const { game, join } = setup();
  const [a, b] = join('A', 'B');
  warmUp(game, [a!], [b!]);
  game.advance();
  assert.equal(game.phase, 'wagering');
  const teamQ = game.teamView(a!.id)!.question!;
  assert.deepEqual([teamQ.text, teamQ.category, teamQ.wager, teamQ.options, teamQ.remainingMs], ['', 'Rivers', true, undefined, undefined]);
  const host = game.hostView();
  assert.equal(host.question!.text, '', 'not in the shared question view');
  assert.equal(host.question!.hostText, 'Which river flows through Cairo?', 'but the host can read it');
  assert.deepEqual(host.wagering, { done: 0, total: 2 });

  game.advance();
  assert.equal(game.phase, 'open');
  assert.equal(game.teamView(a!.id)!.question!.text, 'Which river flows through Cairo?');
  assert.equal(game.hostView().question!.hostText, undefined);
  game.dispose();
});

test('a bet is a whole number up to your score (at least 200, never over the round cap), locked once placed', () => {
  const { game, join } = setup();
  const [rich, poor] = join('Rich', 'Poor');
  warmUp(game, [rich!], [poor!]);
  game.advance();
  assert.deepEqual(game.teamView(rich!.id)!.wagerInfo, { cap: 1000, amount: undefined });
  assert.deepEqual(game.teamView(poor!.id)!.wagerInfo, { cap: WAGER_FLOOR, amount: undefined }, 'a team on zero can still bet the minimum');
  assert.equal(game.placeWager(poor!.id, WAGER_FLOOR + 1).ok, false);
  assert.equal(game.placeWager(poor!.id, -5).ok, false);
  assert.equal(game.placeWager(poor!.id, 50.5).ok, false);
  assert.deepEqual(game.placeWager(rich!.id, 1001), { ok: false, error: 'You can bet at most 1000.' });
  assert.ok(game.placeWager(rich!.id, 600).ok);
  assert.deepEqual(game.placeWager(rich!.id, 100), { ok: false, error: 'Your bet is already locked in.' });
  assert.equal(game.teamView(rich!.id)!.wagerInfo!.amount, 600);
  assert.deepEqual(game.hostView().wagering, { done: 1, total: 2 });
  game.advance();
  assert.equal(game.placeWager(poor!.id, 100).ok, false, 'too late once the question is showing');
  game.dispose();

  // The round cap applies even to a team with a big score.
  const big = new Game(parseQuiz(QUIZ.replace('points: 1000', 'points: 9000')));
  const t = big.join('T');
  assert.ok(t.ok);
  big.advance();
  big.answer(t.value.id, 0);
  big.advance();
  big.advance();
  big.advance();
  assert.equal(big.wagerCapFor(t.value.id), 5000);
  big.dispose();
});

test('scoring: a right answer wins the bet, a wrong or missing one loses it, no bet means no risk', () => {
  const { game, join } = setup();
  const [win, lose, silent, safe] = join('Win', 'Lose', 'Silent', 'Safe');
  warmUp(game, [win!, lose!, silent!, safe!], []); // everyone on 1000
  game.advance();
  game.placeWager(win!.id, 400);
  game.placeWager(lose!.id, 700);
  game.placeWager(silent!.id, 300);
  // Safe bets nothing. Silent never answers.
  game.advance();
  game.answer(win!.id, 0);
  game.answer(lose!.id, 1);
  game.answer(safe!.id, 1);
  game.advance(); // close
  game.advance(); // reveal
  const result = (t: Team) => game.teamView(t.id)!.result!;
  assert.deepEqual([result(win!).points, result(win!).detail, result(win!).correct], [400, 'Wagered 400: +400', true]);
  assert.deepEqual([result(lose!).points, result(lose!).detail], [-700, 'Wagered 700: -700']);
  assert.deepEqual([result(silent!).points, result(silent!).detail], [-300, 'No answer: you lose your 300 wager']);
  assert.deepEqual([result(safe!).points, result(safe!).detail], [0, 'No wager']);
  assert.deepEqual(game.standings().map((r) => [r.name, r.score]), [['Win', 1400], ['Safe', 1000], ['Silent', 700], ['Lose', 300]]);
  assert.deepEqual(game.hostView().wagers, [
    { name: 'Lose', amount: 700, won: false },
    { name: 'Win', amount: 400, won: true },
    { name: 'Silent', amount: 300, won: false },
    { name: 'Safe', amount: 0, won: false },
  ]);
  assert.equal(game.resultsTable()[1]!.at(-1), '400', 'the results table agrees');
  assert.equal(game.resultsTable().find((r) => r[1] === 'Silent')!.at(-1), '-300');
  game.dispose();
});

test('a team can drop below zero, and the speed bonus and fast bonus do not apply to a wager question', () => {
  const game = new Game(parseQuiz(QUIZ.replace('speedFactor: 0', 'speedFactor: 0.5, fastBonus: 500, fastPlaces: 3')));
  const t = game.join('T');
  assert.ok(t.ok);
  game.advance();
  game.answer(t.value.id, 1); // wrong: 0 points
  game.advance();
  game.advance();
  game.advance(); // wagering
  assert.ok(game.placeWager(t.value.id, 200).ok);
  game.advance();
  game.answer(t.value.id, 1);
  game.advance();
  game.advance();
  assert.equal(game.standings()[0]!.score, -200);
  game.advance(); // on to the ordering question: wagering
  assert.equal(game.phase, 'wagering');
  assert.equal(game.hostView().question!.hostText, 'Smallest planet first');
  game.advance(); // open: an ordering question works after a wager
  assert.equal(game.teamView(t.value.id)!.question!.items!.length, 5);
  game.dispose();
});

test('skipping a wager question cancels the bets', () => {
  const { game, join } = setup();
  const [a] = join('A');
  warmUp(game, [a!], []);
  game.advance();
  game.placeWager(a!.id, 800);
  assert.ok(game.skip().ok, 'skip works while teams are betting');
  assert.equal(game.questionIndex, 2);
  assert.equal(game.phase, 'wagering', 'on to the next wager question');
  assert.equal(game.standings()[0]!.score, 1000, 'the bet on the skipped question was not taken');
  assert.equal(game.hostView().wagers, undefined);
  game.dispose();
});

test('bets are saved with the game', () => {
  const { game, join } = setup();
  const [a] = join('A');
  warmUp(game, [a!], []);
  game.advance();
  game.placeWager(a!.id, 250);
  const restored = Game.restore(game.quiz, JSON.parse(JSON.stringify(game.snapshot())));
  assert.equal(restored.phase, 'wagering');
  const again = restored.rejoin({ token: a!.token })!;
  assert.deepEqual(restored.teamView(again.id)!.wagerInfo, { cap: 1000, amount: 250 });
  restored.advance();
  restored.answer(again.id, 0);
  restored.advance();
  restored.advance();
  assert.equal(restored.teamView(again.id)!.result!.points, 250);
  restored.dispose();
  game.dispose();
});

test('over the socket: teams bet, the TV never sees the question while they do, only teams can bet', async () => {
  const server = await createQuizServer({ closeEarly: true, quiz: parseQuiz(QUIZ), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  const ann = await Client.connect(server.port);
  ann.send({ t: 'join', room: server.roomCode, name: 'Ann' });
  await ann.waitFor((m) => m.t === 'joined');

  host.send({ t: 'advance' });
  await ann.state('open');
  ann.send({ t: 'answer', value: 0 });
  await host.state('closed');
  for (let i = 0; i < 3; i++) host.send({ t: 'advance' }); // reveal, leaderboard, wagering
  const wagering = await tv.state('wagering');
  assert.equal(wagering.question.text, '', 'the TV shows no question');
  assert.equal(wagering.question.category, 'Rivers');
  assert.equal(wagering.question.hostText, undefined, 'nor the host-only text');
  assert.equal((await host.state('wagering')).question.hostText, 'Which river flows through Cairo?');

  host.send({ t: 'wager', amount: 5 });
  assert.equal((await host.waitFor((m) => m.t === 'error')).message, 'Join a team first.');
  ann.send({ t: 'wager', amount: 5000 });
  assert.match((await ann.waitFor((m) => m.t === 'error')).message, /at most/);
  ann.send({ t: 'wager', amount: 500 });
  assert.deepEqual((await host.state('wagering', (v) => v.wagering.done === 1)).wagering, { done: 1, total: 1 });
  assert.equal((await tv.state('wagering', (v) => v.wagering.done === 1)).wagering.done, 1);
  host.send({ t: 'advance' });
  assert.equal((await tv.state('open')).question.text, 'Which river flows through Cairo?');
  for (const c of [host, tv, ann]) await c.close();
  await server.close();
});
