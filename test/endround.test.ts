// The host can end a round early: the rest of it is skipped and the round's leaderboard shows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, type Team } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const QUIZ = `
title: End round
scoring: { mode: flat }
rounds:
  - name: One
    questions:
      - { type: multiple-choice, text: A1, options: [a, b], answer: 0, points: 100 }
      - { type: multiple-choice, text: A2, options: [a, b], answer: 0, points: 100 }
      - { type: multiple-choice, text: A3, options: [a, b], answer: 0, points: 100 }
  - name: Two
    questions:
      - { type: multiple-choice, text: B1, options: [a, b], answer: 0, points: 100 }
      - { type: multiple-choice, text: B2, options: [a, b], answer: 0, points: 100 }
`;

function setup() {
  const game = new Game(parseQuiz(QUIZ));
  const t = game.join('A');
  assert.ok(t.ok);
  const team: Team = t.value;
  const score = () => game.standings()[0]!.score;
  return { game, team, score };
}

test('ending a round mid-question skips that question and the rest, and shows the round leaderboard', () => {
  const { game, team, score } = setup();
  assert.equal(game.canEndRound(), false, 'not in the lobby');
  game.advance();
  game.answer(team.id, 0);
  game.advance(); game.advance(); // closed, reveal A1: 100 points
  assert.equal(game.canEndRound(), true);
  game.advance(); // A2 opens
  game.answer(team.id, 0);
  assert.ok(game.endRound().ok);
  assert.equal(game.phase, 'leaderboard');
  assert.equal(game.questionIndex, 2, 'on the last question of the round, so it is a round break');
  assert.equal(game.hostView().question!.lastInRound, true);
  assert.equal(score(), 100, 'A2 was on screen and not revealed: skipped, so it scored nothing');
  assert.equal(game.canEndRound(), false, 'nothing more to end on a leaderboard');
  game.advance();
  assert.equal(game.phase, 'open');
  assert.equal(game.hostView().question!.round, 'Two', 'the next round starts');
  game.dispose();
});

test('ending a round after a reveal keeps that question, and the last round ends the quiz', () => {
  const { game, team, score } = setup();
  game.advance();
  game.answer(team.id, 0);
  game.advance(); game.advance(); // reveal A1
  assert.ok(game.endRound().ok);
  assert.equal(score(), 100, 'the revealed question still counts');
  assert.equal(game.hostView().standings![0]!.gained, 100, 'the round board shows what the round earned');
  game.advance(); // round two, B1
  game.answer(team.id, 0);
  game.advance(); game.advance(); // reveal B1
  assert.equal(game.canEndRound(), true, 'B2 is still to come');
  assert.ok(game.endRound().ok);
  assert.equal(game.phase, 'leaderboard');
  assert.equal(score(), 200);
  game.advance();
  assert.equal(game.phase, 'finished', 'ending the last round finishes the quiz');
  game.dispose();
});

test('it is refused when there is nothing to end, and only the host can do it', async () => {
  const { game } = setup();
  assert.equal(game.endRound().ok, false);
  game.dispose();

  const server = await createQuizServer({ quiz: parseQuiz(QUIZ), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const ann = await Client.connect(server.port);
  ann.send({ t: 'join', name: 'Ann' });
  await ann.waitFor((m) => m.t === 'joined');
  host.send({ t: 'end-round' });
  assert.match((await host.waitFor((m) => m.t === 'error')).message, /while one of its questions is on screen/);
  host.send({ t: 'advance' });
  await host.state('open', (v) => v.canEndRound === true);
  ann.send({ t: 'end-round' });
  assert.match((await ann.waitFor((m) => m.t === 'error')).message, /Only the host/);
  host.send({ t: 'end-round' });
  const board = await ann.state('leaderboard');
  assert.equal(board.question.lastInRound, true);
  for (const c of [host, ann]) await c.close();
  await server.close();
});
