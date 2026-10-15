// The host can check and change the correct answer once time is up, and hide the team list on the TV.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, type Team } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const yaml = (q: string) => `title: T\nscoring: { leaderboard: question }\nrounds:\n  - name: R\n    questions: [${q}]\n`;
const MC = '{ type: multiple-choice, text: "Capital?", options: [Sydney, Canberra, Melbourne], answer: 0, seconds: 20 }';
const LETTER = '{ type: letter, text: "Who sang Imagine?", answer: "John Lennon", seconds: 20 }';
const NUMBER = '{ type: number, text: "Year?", answer: 1969, seconds: 20 }';
const NEAREST = '{ type: nearest, text: "Everest?", answer: 8849 }';

function setup(q: string) {
  const game = new Game(parseQuiz(yaml(q)));
  const join = (...names: string[]): Team[] => names.map((n) => {
    const r = game.join(n);
    assert.ok(r.ok);
    return r.value;
  });
  return { game, join };
}

test('multiple choice: the answer is visible to the host when time is up, can be changed, and scoring follows', () => {
  const { game, join } = setup(MC);
  const [a, b] = join('A', 'B');
  game.advance();
  game.answer(a!.id, 0);
  game.answer(b!.id, 1);
  assert.equal(game.phase, 'closed');
  const before = game.hostView().question!;
  assert.equal(before.answerText, 'Sydney');
  assert.equal(before.answer, 0);
  assert.equal(before.editable, true);
  assert.equal(before.answerEdited, false);

  assert.ok(game.setAnswer(1).ok, "oops: it's Canberra");
  const after = game.hostView().question!;
  assert.equal(after.answerText, 'Canberra');
  assert.equal(after.answer, 1);
  assert.equal(after.answerEdited, true);
  game.advance();
  assert.equal(game.teamView(a!.id)!.result!.correct, false);
  assert.equal(game.teamView(b!.id)!.result!.correct, true);
  assert.equal(game.teamView(b!.id)!.result!.correctIndex, 1);
  assert.equal(game.teamView(b!.id)!.result!.answerText, 'Canberra');
  assert.deepEqual(game.standings().map((r) => r.name), ['B', 'A']);

  // Changing it back clears the "changed" mark, and a mistake can still be fixed after the reveal.
  assert.ok(game.setAnswer(0).ok);
  assert.equal(game.hostView().question!.answerEdited, false);
  assert.equal(game.teamView(a!.id)!.result!.correct, true);
  game.dispose();
});

test('letter, number and nearest answers can be changed too', () => {
  const l = setup(LETTER);
  const [x] = l.join('X');
  l.game.advance();
  l.game.answer(x!.id, 'L');
  assert.equal(l.game.hostView().question!.editValue, 'J');
  assert.ok(l.game.setAnswer('l').ok, 'lower case is fine');
  assert.equal(l.game.hostView().question!.editValue, 'L');
  l.game.advance();
  assert.equal(l.game.teamView(x!.id)!.result!.correct, true);
  l.game.dispose();

  const n = setup(NUMBER);
  const [y] = n.join('Y');
  n.game.advance();
  n.game.answer(y!.id, 1970);
  assert.ok(n.game.setAnswer(1970).ok);
  assert.equal(n.game.hostView().question!.answerText, '1970');
  n.game.advance();
  assert.equal(n.game.teamView(y!.id)!.result!.correct, true);
  n.game.dispose();

  const e = setup(NEAREST);
  const [p, q] = e.join('P', 'Q');
  e.game.advance();
  e.game.answer(p!.id, 8800);
  e.game.answer(q!.id, 8890);
  e.game.advance();
  assert.equal(e.game.hostView().guesses![0]!.teams[0], 'Q', '8890 is closer to 8849 (41 away, against 49)');
  assert.ok(e.game.setAnswer(8810).ok);
  assert.equal(e.game.hostView().guesses![0]!.teams[0], 'P', 'now 8800 is closer');
  e.game.dispose();
});

test('invalid changes are refused, and only once time is up', () => {
  const { game, join } = setup(MC);
  const [a] = join('A', 'B');
  game.advance();
  assert.deepEqual(game.setAnswer(1), { ok: false, error: 'The answer can be changed once time is up.' }, 'not while it is open');
  game.answer(a!.id, 0);
  game.advance();
  assert.equal(game.setAnswer(7).ok, false);
  assert.equal(game.setAnswer(-1).ok, false);
  assert.equal(game.setAnswer('B').ok, false);
  assert.equal(game.setAnswer(1.5).ok, false);
  assert.equal(game.hostView().question!.answerEdited, false);
  game.dispose();

  const l = setup(LETTER);
  l.join('X');
  l.game.advance();
  l.game.advance();
  assert.equal(l.game.setAnswer('XY').ok, false);
  assert.equal(l.game.setAnswer('7').ok, false);
  assert.equal(l.game.setAnswer(3).ok, false);
  l.game.dispose();

  const o = setup('{ type: ordering, text: Q, items: [a, b, c, d, e] }');
  o.join('X');
  o.game.advance();
  o.game.advance();
  assert.equal(o.game.setAnswer(1).ok, false, "ordering answers can't be changed here");
  assert.equal(o.game.hostView().question!.editable, false);
  o.game.dispose();
});

test('a changed answer is saved with the game', () => {
  const { game, join } = setup(MC);
  const [a] = join('A', 'B');
  game.advance();
  game.answer(a!.id, 1);
  game.advance();
  game.setAnswer(1);
  const restored = Game.restore(game.quiz, JSON.parse(JSON.stringify(game.snapshot())));
  assert.equal(restored.hostView().question!.answerText, 'Canberra');
  assert.equal(restored.hostView().question!.answerEdited, true);
  restored.dispose();
  game.dispose();
});

test('over the socket: only the host can change the answer or hide teams on the TV; the TV sees no teams, and never the answer early', async () => {
  const server = await createQuizServer({ quiz: parseQuiz(yaml(MC)), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  const team = await Client.connect(server.port);
  team.send({ t: 'join', room: server.roomCode, name: 'Ann' });
  await team.waitFor((m) => m.t === 'joined');

  assert.equal((await tv.state('lobby', (v) => v.teams.length === 1)).tvShowTeams, true);
  team.send({ t: 'tv-teams', visible: false });
  team.send({ t: 'set-answer', value: 1 });
  assert.equal((await team.waitFor((m) => m.t === 'error')).message, 'Only the host can do that.');

  host.send({ t: 'tv-teams', visible: false });
  const hidden = await tv.state('lobby', (v) => v.teamsHidden === true);
  assert.deepEqual(hidden.teams, []);
  assert.equal(hidden.standings.length, 1, 'the TV can still say how many are playing');
  assert.equal((await host.state('lobby', (v) => v.tvShowTeams === false)).teams.length, 1, 'the host still sees everyone');
  host.send({ t: 'tv-teams', visible: true });
  assert.equal((await tv.state('lobby', (v) => v.teams.length === 1)).teamsHidden, false);

  host.send({ t: 'advance' });
  await team.state('open');
  team.send({ t: 'answer', value: 0 });
  const closed = await host.state('closed');
  assert.equal(closed.question.answerText, 'Sydney');
  assert.equal((await tv.state('closed')).question.answerText, '', 'the TV still sees nothing');
  host.send({ t: 'set-answer', value: 1 });
  assert.equal((await host.state('closed', (v) => v.question.answerEdited === true)).question.answerText, 'Canberra');
  assert.equal((await tv.state('closed', (v) => v.question.answerEdited === true)).question.answerText, '', 'nor after the host changes it');
  host.send({ t: 'set-answer', value: 99 });
  assert.equal((await host.waitFor((m) => m.t === 'error')).message, 'That is not one of the options.');
  for (const c of [host, tv, team]) await c.close();
  await server.close();
});
