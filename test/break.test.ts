// The break screen: fun facts shown on phones and the TV between questions.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Game } from '../server/game.ts';
import { parseFactFile, loadBundledFacts, MAX_FACT_LENGTH } from '../server/facts.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const QUIZ = `
title: Break
facts: [Own fact one, Own fact two]
scoring: { leaderboard: question }
rounds:
  - name: R
    questions:
      - { type: multiple-choice, text: Q1, options: [a, b], answer: 0 }
      - { type: multiple-choice, text: Q2, options: [a, b], answer: 0 }
`;

test('the built-in fact files are valid, short and have no repeats', async () => {
  const files = (await readdir('facts')).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 5);
  const seen = new Set<string>();
  for (const f of files) {
    const parsed = parseFactFile(await readFile(`facts/${f}`, 'utf8'));
    assert.ok(parsed, f);
    for (const fact of parsed.facts) {
      assert.ok(fact.length <= MAX_FACT_LENGTH, `${f}: ${fact}`);
      assert.ok(!seen.has(fact.toLowerCase()), `repeat in ${f}: ${fact}`);
      seen.add(fact.toLowerCase());
    }
  }
  assert.equal((await loadBundledFacts()).length, seen.size);
});

test('a break can be taken between questions, shows on teams, and ends with one advance', () => {
  const game = new Game(parseQuiz(QUIZ));
  const t = game.join('A');
  assert.ok(t.ok);
  assert.ok(game.startBreak(5, ['f']).ok, 'in the lobby');
  assert.equal(game.startBreak(5, ['f']).ok, false, 'not twice');
  const view = game.teamView(t.value.id)!;
  assert.deepEqual(view.onBreak!.facts, ['f']);
  assert.ok(view.onBreak!.remainingMs! > 0);
  assert.equal(game.hostView().onBreak!.facts[0], 'f');
  game.advance(); // ends the break only
  assert.equal(game.hostView().onBreak, undefined);
  assert.equal(game.phase, 'lobby');
  game.advance();
  assert.equal(game.phase, 'open');
  assert.equal(game.startBreak(undefined, ['f']).ok, false, 'not during a question');
  game.answer(t.value.id, 0);
  game.advance();
  game.advance();
  assert.equal(game.phase, 'leaderboard');
  assert.ok(game.startBreak(undefined, []).ok);
  assert.equal(game.hostView().onBreak!.remainingMs, undefined, 'no timer');
  const restored = Game.restore(game.quiz, JSON.parse(JSON.stringify(game.snapshot())));
  assert.ok(restored.hostView().onBreak, 'a break survives a restart');
  assert.equal(game.startBreak(0, []).ok, false);
  restored.dispose();
  game.dispose();
});

test('over the socket: host starts and ends a break, the TV and phones follow, only the host can', async () => {
  const server = await createQuizServer({ quiz: parseQuiz(QUIZ), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  const ann = await Client.connect(server.port);
  ann.send({ t: 'join', room: server.roomCode, name: 'Ann' });
  await ann.waitFor((m) => m.t === 'joined');

  ann.send({ t: 'break', minutes: 5 });
  assert.match((await ann.waitFor((m) => m.t === 'error')).message, /Only the host/);
  host.send({ t: 'break', minutes: 5 });
  const onTv = await tv.state('lobby', (v) => v.onBreak);
  assert.ok(onTv.onBreak.facts.every((f: string) => f.startsWith('Own fact')), 'the quiz own facts are used');
  await ann.state('lobby', (v) => v.onBreak);
  host.send({ t: 'end-break' });
  await ann.state('lobby', (v) => !v.onBreak);
  for (const c of [host, tv, ann]) await c.close();
  await server.close();
});
