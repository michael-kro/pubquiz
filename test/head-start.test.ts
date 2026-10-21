// Head starts: seconds taken off a slower player's answer time, so they can still win the speed points.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, type Team } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';

const QUIZ = `
title: Head start
scoring: { mode: rank }
rounds:
  - name: R
    questions:
      - { type: multiple-choice, text: Q1, options: [a, b], answer: 0, seconds: 30 }
      - { type: multiple-choice, text: Q2, options: [a, b], answer: 0, seconds: 30 }
`;

function setup() {
  let clock = 1_000_000;
  const game = new Game(parseQuiz(QUIZ), { now: () => clock, closeEarly: false });
  const [fast, slow] = ['Fast', 'Slow'].map((n) => {
    const r = game.join(n);
    assert.ok(r.ok);
    return r.value;
  }) as [Team, Team];
  const score = (t: Team) => game.standings().find((r) => r.teamId === t.id)!.score;
  return { game, fast, slow, score, tick: (ms: number) => (clock += ms) };
}

test('without a head start the faster team wins the speed bonus', () => {
  const { game, fast, slow, score, tick } = setup();
  game.advance();
  tick(2000);
  game.answer(fast.id, 0);
  tick(3000);
  game.answer(slow.id, 0);
  game.advance();
  game.advance();
  assert.ok(score(fast) > score(slow));
});

test('a head start takes seconds off a team’s answer time, so a slower team can come out ahead', () => {
  const { game, fast, slow, score, tick } = setup();
  assert.ok(game.setHeadStart(slow.id, 5).ok);
  assert.equal(game.hostView().teams.find((t) => t.id === slow.id)!.headStart, 5);
  game.advance();
  tick(2000);
  game.answer(fast.id, 0);
  tick(3000); // five seconds in: slower by 3 s, but with 5 s taken off it counts as instant
  game.answer(slow.id, 0);
  game.advance();
  game.advance();
  assert.ok(score(slow) > score(fast), 'the slower player, with a head start, is ranked fastest');
  assert.equal(game.hostView().teams.find((t) => t.id === slow.id)!.headStart, 5);
});

test('a head start never makes an answer time negative, and clearing it puts things back', () => {
  const { game, fast, slow, score, tick } = setup();
  game.setHeadStart(slow.id, 30);
  game.setHeadStart(slow.id, 0);
  assert.equal(game.hostView().teams.find((t) => t.id === slow.id)!.headStart, 0);
  game.advance();
  tick(1000);
  game.answer(fast.id, 0);
  tick(1000);
  game.answer(slow.id, 0);
  game.advance();
  game.advance();
  assert.ok(score(fast) > score(slow));
});

test('bad head starts are refused', () => {
  const { game, slow } = setup();
  assert.equal(game.setHeadStart('nobody', 5).ok, false);
  assert.equal(game.setHeadStart(slow.id, -1).ok, false);
  assert.equal(game.setHeadStart(slow.id, 31).ok, false);
  assert.equal(game.setHeadStart(slow.id, Number.NaN).ok, false);
});

test('head starts survive a restart', () => {
  const { game, slow } = setup();
  game.setHeadStart(slow.id, 4);
  const restored = Game.restore(game.quiz, JSON.parse(JSON.stringify(game.snapshot())));
  assert.equal(restored.hostView().teams.find((t) => t.id === slow.id)!.headStart, 4);
  game.dispose();
  restored.dispose();
});

test('only the host can set a head start, over the socket', async () => {
  const { createQuizServer } = await import('../server/server.ts');
  const { Client } = await import('./client.ts');
  const server = await createQuizServer({ quiz: parseQuiz(QUIZ), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', allowEmptyStart: true, closeEarly: false, lockOnStart: false, tvShowTeams: true });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const team = await Client.connect(server.port);
  team.send({ t: 'join', name: 'Kid' });
  await team.waitFor((m) => m.t === 'joined');
  const id = (await host.state('lobby', (v) => v.teams.length === 1)).teams[0].id;
  team.send({ t: 'head-start', teamId: id, seconds: 5 });
  assert.match((await team.waitFor((m) => m.t === 'error')).message, /Only the host/);
  host.send({ t: 'head-start', teamId: id, seconds: 5 });
  assert.equal((await host.state('lobby', (v) => v.teams[0].headStart === 5)).teams[0].headStart, 5);
  host.send({ t: 'head-start', teamId: id, seconds: 99 });
  assert.match((await host.waitFor((m) => m.t === 'error')).message, /Unrecognised|between 0 and 30/);
  for (const c of [host, team]) await c.close();
  await server.close();
});
