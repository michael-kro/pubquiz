// Entry fee and "admit team": teams wait until the host has checked they've paid.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const QUIZ = `
title: Pay
entryFee: £5 per team
scoring: { leaderboard: question }
rounds:
  - name: R
    questions:
      - { type: multiple-choice, text: Q, options: [a, b], answer: 0 }
`;

test('the entry fee comes from the quiz file, can be changed, and is shown to teams', () => {
  const game = new Game(parseQuiz(QUIZ));
  const t = game.join('A');
  assert.ok(t.ok);
  assert.equal(game.teamView(t.value.id)!.entryFee, '£5 per team');
  assert.equal(game.hostView().entryFee, '£5 per team');
  game.setEntryFee('  £10 a table ​ ');
  assert.equal(game.hostView().entryFee, '£10 a table');
  game.setEntryFee('');
  assert.equal(game.teamView(t.value.id)!.entryFee, undefined, 'no fee, nothing to show');
  game.dispose();
});

test('with admission on, new teams wait: not on the board, cannot answer, until the host admits them', () => {
  const game = new Game(parseQuiz(QUIZ));
  const early = game.join('Early');
  assert.ok(early.ok);
  game.setRequireAdmission(true);
  assert.equal(game.hostView().teams.length, 1, 'teams already in stay in');
  const late = game.join('Late');
  assert.ok(late.ok);
  assert.deepEqual(game.hostView().pendingTeams.map((t) => t.name), ['Late']);
  assert.equal(game.hostView().teams.length, 1);
  const view = game.teamView(late.value.id)!;
  assert.equal(view.pendingAdmission, true);
  assert.equal(view.entryFee, '£5 per team');
  assert.equal(game.join('late').ok, false, 'the name is taken even while waiting');
  game.advance();
  assert.equal(game.answer(late.value.id, 0).ok, false, 'a waiting team cannot answer');
  assert.ok(game.rejoin({ token: late.value.token }), 'a waiting team can reconnect');
  assert.equal(game.standings().length, 1, 'and is not on the leaderboard');

  assert.equal(game.admit('nobody'), false);
  assert.ok(game.admit(late.value.id));
  assert.equal(game.hostView().pendingTeams.length, 0);
  assert.equal(game.teamView(late.value.id)!.pendingAdmission, undefined);
  assert.ok(game.answer(late.value.id, 0).ok, 'admitted during a question: it can answer');
  game.dispose();
});

test('admit all, turn away, switching admission off, the 30 team cap and saving', () => {
  const game = new Game(parseQuiz(QUIZ));
  game.setRequireAdmission(true);
  const a = game.join('A');
  const b = game.join('B');
  const c = game.join('C');
  assert.ok(a.ok && b.ok && c.ok);
  assert.ok(game.kick(c.value.id), 'turning a waiting team away');
  assert.equal(game.hostView().pendingTeams.length, 2);
  const restored = Game.restore(game.quiz, JSON.parse(JSON.stringify(game.snapshot())));
  assert.deepEqual(restored.hostView().pendingTeams.map((t) => t.name), ['A', 'B'], 'waiting teams survive a restart');
  assert.equal(restored.hostView().requireAdmission, true);
  assert.ok(restored.rejoin({ token: a.value.token }));
  restored.admitAll();
  assert.equal(restored.hostView().teams.length, 2);
  restored.dispose();

  game.setRequireAdmission(false);
  assert.equal(game.hostView().teams.length, 2, 'switching it off lets everyone waiting in');
  game.setRequireAdmission(true);
  for (let i = 0; i < 28; i++) assert.ok(game.join(`Team ${i}`).ok);
  assert.equal(game.join('One too many').ok, false, 'waiting teams count towards the cap of 30');
  game.dispose();
});

test('over the socket: the TV never sees who is waiting, only the host can admit, the team is let in at once', async () => {
  const server = await createQuizServer({ quiz: parseQuiz(QUIZ), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', tvShowTeams: true });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  host.send({ t: 'require-admission', on: true });
  await host.state('lobby', (v) => v.requireAdmission === true);

  const ann = await Client.connect(server.port);
  ann.send({ t: 'join', room: server.roomCode, name: 'Ann' });
  await ann.waitFor((m) => m.t === 'joined');
  assert.equal((await ann.state('lobby', (v) => v.pendingAdmission === true)).entryFee, '£5 per team');
  const hostSees = await host.state('lobby', (v) => v.pendingTeams.length === 1);
  assert.equal(hostSees.pendingTeams[0].name, 'Ann');
  const tvSees = await tv.state('lobby', (v) => v.entryFee === '£5 per team');
  assert.deepEqual([tvSees.pendingTeams, tvSees.teams], [[], []], 'nothing about waiting teams on the TV');

  ann.send({ t: 'admit', teamId: hostSees.pendingTeams[0].id });
  assert.match((await ann.waitFor((m) => m.t === 'error')).message, /Only the host/);
  host.send({ t: 'admit', teamId: hostSees.pendingTeams[0].id });
  const admitted = await ann.state('lobby', (v) => !v.pendingAdmission);
  assert.equal(admitted.teamName, 'Ann');
  assert.equal((await host.state('lobby', (v) => v.teams.length === 1)).pendingTeams.length, 0);
  host.send({ t: 'set-entry-fee', fee: '£8' });
  assert.equal((await tv.state('lobby', (v) => v.entryFee === '£8')).entryFee, '£8');
  for (const c of [host, tv, ann]) await c.close();
  await server.close();
});

test('the quiz cannot start until a team has joined, unless the host allows it', async () => {
  const waiting = new Game(parseQuiz(QUIZ), { allowEmptyStart: false });
  assert.equal(waiting.canStart(), false);
  waiting.advance();
  assert.equal(waiting.phase, 'lobby', 'Start does nothing with nobody in');
  waiting.setRequireAdmission(true);
  assert.ok(waiting.join('Waiting').ok);
  assert.equal(waiting.canStart(), false, 'a team that is still waiting to be admitted does not count');
  waiting.admitAll();
  assert.equal(waiting.hostView().canStart, true);
  waiting.advance();
  assert.equal(waiting.phase, 'open');
  waiting.dispose();

  const trial = new Game(parseQuiz(QUIZ), { allowEmptyStart: false });
  trial.setAllowEmptyStart(true);
  assert.equal(trial.hostView().allowEmptyStart, true);
  trial.advance();
  assert.equal(trial.phase, 'open', 'allowed: starts with nobody in');
  trial.dispose();

  // Over the socket the host is told why nothing happened.
  const server = await createQuizServer({ quiz: parseQuiz(QUIZ), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  assert.equal((await host.state('lobby')).canStart, false);
  host.send({ t: 'advance' });
  assert.match((await host.waitFor((m) => m.t === 'error')).message, /first team/);
  const ann = await Client.connect(server.port);
  ann.send({ t: 'join', name: 'Ann' });
  await ann.waitFor((m) => m.t === 'joined');
  assert.equal((await host.state('lobby', (v) => v.canStart)).canStart, true);
  host.send({ t: 'advance' });
  await host.state('open');
  for (const c of [host, ann]) await c.close();
  await server.close();
});

test('the most teams that can join is a host setting that defaults to 30', async () => {
  const game = new Game(parseQuiz(QUIZ));
  assert.equal(game.hostView().maxTeams, 30);
  game.setMaxTeams(2);
  assert.ok(game.join('A').ok && game.join('B').ok);
  const full = game.join('C');
  assert.equal(full.ok, false);
  assert.match(full.ok ? '' : full.error, /full \(2 teams\)/);
  game.setMaxTeams(1);
  assert.equal(game.hostView().teams.length, 2, 'lowering it never removes teams already in');
  game.setMaxTeams(500);
  assert.equal(game.hostView().maxTeams, 100, 'there is a ceiling');
  game.setMaxTeams(0);
  assert.equal(game.hostView().maxTeams, 1, 'and at least one');
  game.setMaxTeams(Number.NaN);
  assert.equal(game.hostView().maxTeams, 1, 'nonsense is ignored');
  game.setMaxTeams(12);
  const restored = Game.restore(game.quiz, JSON.parse(JSON.stringify(game.snapshot())));
  assert.equal(restored.hostView().maxTeams, 12, 'saved with the game');
  restored.dispose();
  game.dispose();

  const server = await createQuizServer({ quiz: parseQuiz(QUIZ), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const ann = await Client.connect(server.port);
  ann.send({ t: 'join', name: 'Ann' });
  await ann.waitFor((m) => m.t === 'joined');
  ann.send({ t: 'set-max-teams', max: 1 });
  assert.match((await ann.waitFor((m) => m.t === 'error')).message, /Only the host/);
  host.send({ t: 'set-max-teams', max: 1 });
  assert.equal((await host.state('lobby', (v) => v.maxTeams === 1)).maxTeams, 1);
  const bob = await Client.connect(server.port);
  bob.send({ t: 'join', name: 'Bob' });
  assert.match((await bob.waitFor((m) => m.t === 'error')).message, /full \(1 teams\)/);
  for (const c of [host, ann, bob]) await c.close();
  await server.close();
});
