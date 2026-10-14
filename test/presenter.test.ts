// M4: round breaks, leaderboard movement, results (CSV), the TV screen and the results file.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Game, type Team } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer, toCsv } from '../server/server.ts';
import { Client } from './client.ts';

const quiz = parseQuiz(`
title: Presenter
rounds:
  - name: One
    questions:
      - { type: multiple-choice, text: Q1, options: [a, b], answer: 0, seconds: 20 }
      - { type: multiple-choice, text: Q2, options: [a, b], answer: 0, seconds: 20 }
  - name: Two
    questions:
      - { type: multiple-choice, text: Q3, options: [a, b], answer: 1, seconds: 20 }
`);

function join3(game: Game, ...names: string[]): Team[] {
  return names.map((name) => {
    const result = game.join(name);
    assert.ok(result.ok);
    return result.value;
  });
}

function toLeaderboard(game: Game): void {
  while (game.phase !== 'leaderboard') game.advance();
}

test('questions know their round, and the last one in a round is a round break', () => {
  const game = new Game(quiz);
  join3(game, 'A');
  const views: [number, string, boolean][] = [];
  for (let i = 0; i < 3; i++) {
    game.advance();
    const q = game.hostView().question!;
    views.push([q.roundNumber, q.round, q.lastInRound]);
    assert.equal(q.roundTotal, 2);
    toLeaderboard(game);
  }
  assert.deepEqual(views, [
    [1, 'One', false],
    [1, 'One', true],
    [2, 'Two', true],
  ]);
  game.dispose();
});

test('standings say what each team gained and how far it moved after each question', () => {
  let now = 0;
  const game = new Game(quiz, { now: () => now });
  const [a, b, c] = join3(game, 'A', 'B', 'C');
  game.advance();
  game.answer(a!.id, 0); // right
  game.answer(b!.id, 1); // wrong
  game.answer(c!.id, 1); // wrong
  game.advance();
  game.advance();
  let rows = Object.fromEntries(game.standings().map((r) => [r.name, r]));
  assert.equal(rows.A!.gained, 1000);
  assert.equal(rows.B!.gained, 0);
  assert.equal(rows.A!.moved, undefined, 'no movement after the first question');

  game.advance(); // Q2 open
  game.answer(a!.id, 1); // wrong
  game.answer(b!.id, 0); // right
  game.answer(c!.id, 1); // wrong
  game.advance();
  game.advance();
  rows = Object.fromEntries(game.standings().map((r) => [r.name, r]));
  assert.deepEqual([rows.A!.rank, rows.B!.rank, rows.C!.rank], [1, 1, 3]);
  assert.equal(rows.B!.moved, 1, 'B went from 2nd (tied with C) to 1st');
  assert.equal(rows.A!.moved, 0);
  assert.equal(rows.C!.moved, -1, 'C dropped from 2nd (tied) to 3rd');
  assert.equal(rows.B!.gained, 1000);
  game.dispose();
});

test('results are not given away early: nothing counts until its question is revealed', () => {
  const game = new Game(quiz);
  const [a] = join3(game, 'Ann');
  game.advance();
  game.answer(a!.id, 0);
  assert.deepEqual(game.resultsTable(), [['Rank', 'Team', 'Total'], ['1', 'Ann', '0']], 'nothing is revealed yet');
  game.advance();
  game.advance();
  assert.deepEqual(game.resultsTable(), [
    ['Rank', 'Team', 'Total', 'Q1 (One)'],
    ['1', 'Ann', '1000', '1000'],
  ]);
  game.dispose();
});

test('CSV: quoted where needed, and formulas in team names are made harmless', () => {
  const csv = toCsv([
    ['Team', 'Total'],
    ['=HYPERLINK("http://evil")', '10'],
    ['+1 team', '5'],
    ['Comma, Inc', '1'],
    ['Quote "q"', '2'],
    ['Line\nbreak', '3'],
  ]);
  assert.ok(csv.startsWith('﻿Team,Total\r\n'), 'starts with a BOM so Excel reads accents');
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil""\)",10/);
  assert.match(csv, /'\+1 team,5/);
  assert.match(csv, /"Comma, Inc",1/);
  assert.match(csv, /"Quote ""q""",2/);
  assert.match(csv, /"Line\nbreak",3/);
});

test('the TV screen sees the quiz but never the answer before the reveal, and has no controls', async () => {
  const server = await createQuizServer({ quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  await tv.state('lobby');
  assert.equal((await host.state('lobby')).screenKey, server.screenKey);

  const team = await Client.connect(server.port);
  team.send({ t: 'join', room: server.roomCode, name: 'Ann' });
  await team.waitFor((m) => m.t === 'joined');

  host.send({ t: 'advance' });
  const open = await tv.state('open');
  assert.equal(open.question.text, 'Q1');
  assert.equal(open.question.answerText, '');
  assert.equal(open.question.answer, undefined);
  assert.equal((await host.state('open')).question.answerText, 'a', 'the host still sees it');
  team.send({ t: 'answer', value: 0 });
  const closed = await tv.state('closed');
  assert.equal(closed.question.answerText, '');
  assert.equal(closed.review, undefined);

  tv.send({ t: 'advance' });
  tv.send({ t: 'network', action: 'use-lan' });
  assert.equal((await tv.waitFor((m) => m.t === 'error')).message, 'Only the host can do that.');
  assert.equal(server.game!.phase, 'closed', 'the TV could not advance the quiz');

  host.send({ t: 'advance' });
  assert.equal((await tv.state('reveal')).question.answerText, 'a');
  assert.equal((await tv.state('reveal').catch(() => ({ screenKey: '' }))).screenKey, '');

  const stranger = await Client.connect(server.port);
  stranger.send({ t: 'screen', key: server.hostKey });
  assert.match((await stranger.waitFor((m) => m.t === 'error')).message, /Wrong screen link/);
  assert.equal(
    (await fetch(`http://127.0.0.1:${server.port}/screen`)).status,
    200,
    'the page itself is public; the data needs the key',
  );
  for (const c of [host, tv, team, stranger]) await c.close();
  await server.close();
});

test('the screen link survives a restart, and /results.csv needs the host key', async () => {
  const first = await createQuizServer({ quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', hostKey: 'fixed-host-key-for-testing' });
  const key = first.screenKey;
  const base = `http://127.0.0.1:${first.port}`;
  assert.equal((await fetch(`${base}/results.csv`)).status, 404);
  assert.equal((await fetch(`${base}/results.csv?key=${first.screenKey}`)).status, 404, 'the TV key is not enough');
  const ok = await fetch(`${base}/results.csv?key=fixed-host-key-for-testing`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') ?? '', /text\/csv/);
  await first.close();
  const second = await createQuizServer({ quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', hostKey: 'fixed-host-key-for-testing' });
  assert.equal(second.screenKey, key);
  await second.close();
});

test('a results file is written next to the quiz when the game finishes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pubquiz-results-'));
  const server = await createQuizServer({
    quiz,
    port: 0,
    bindHost: '127.0.0.1',
    publicHost: '127.0.0.1',
    session: { path: join(dir, 'friday.session.json'), quizHash: 'x' },
  });
  const game = server.game!;
  const team = game.join('Winners');
  assert.ok(team.ok);
  game.advance();
  game.answer(team.value.id, 0);
  for (let i = 0; i < 2; i++) game.advance();
  while (game.phase !== 'finished') game.advance();
  await server.close();
  const files = (await readdir(dir)).filter((f) => f.includes('results'));
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^friday\.results-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(await readFile(join(dir, files[0]!), 'utf8'), /Winners,/);
});
