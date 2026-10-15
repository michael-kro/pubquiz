// M4b: pause/extend/skip, leaderboard cadence, scoring modes, tie-break, phone-measured timing and the host PIN.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Game, type Team } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const q = (extra = '') => `{ type: multiple-choice, text: Q, options: [a, b], answer: 0, seconds: 20 ${extra}}`;

const BASIC = parseQuiz(`
title: Controls
scoring: { leaderboard: question }
rounds:
  - name: R1
    questions: [${q()}, ${q()}]
  - name: R2
    questions: [${q()}]
`);

function setup(quiz = BASIC) {
  let now = 1_000_000;
  const game = new Game(quiz, { now: () => now });
  return { game, tick: (ms: number) => (now += ms) };
}

function join(game: Game, ...names: string[]): Team[] {
  return names.map((name) => {
    const result = game.join(name);
    assert.ok(result.ok);
    return result.value;
  });
}

test('pause stops the clock for everyone; resume gives back exactly the time that was left', () => {
  const { game, tick } = setup();
  const [a, b] = join(game, 'A', 'B');
  game.advance();
  tick(5_000);
  assert.ok(game.pause().ok);
  assert.equal(game.pause().ok, false, 'already paused');
  assert.equal(game.teamView(a!.id)!.question!.paused, true);
  tick(60_000);
  assert.equal(game.teamView(a!.id)!.question!.remainingMs, 15_000, 'the clock is frozen');
  assert.deepEqual(game.answer(a!.id, 0), { ok: false, error: 'The quiz master has paused the quiz.' });

  assert.ok(game.resume().ok);
  assert.equal(game.resume().ok, false, 'not paused any more');
  assert.equal(game.teamView(a!.id)!.question!.paused, undefined);
  assert.equal(game.teamView(a!.id)!.question!.remainingMs, 15_000);
  tick(2_000);
  game.answer(a!.id, 0);
  // 5 s before the pause plus 2 s after: 7 s of 20, so 1000 × (1 − 0.5 × 7/20) = 825.
  game.answer(b!.id, 1);
  game.advance();
  assert.equal(game.teamView(a!.id)!.result!.points, 825);
  game.dispose();
});

test('a team that joins during a pause starts its clock when play resumes', () => {
  const { game, tick } = setup();
  const [a] = join(game, 'A');
  game.advance();
  game.pause();
  tick(30_000);
  const [late] = join(game, 'Late');
  tick(10_000);
  game.resume();
  tick(4_000);
  game.answer(late!.id, 0);
  game.answer(a!.id, 1);
  game.advance();
  assert.equal(game.teamView(late!.id)!.result!.points, 900, '4 s of 20');
  game.dispose();
});

test('extend adds time to the question, including while paused', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const game = new Game(BASIC);
    join(game, 'A');
    game.advance();
    mock.timers.tick(10_000);
    assert.ok(game.extend(10).ok);
    assert.equal(game.hostView().question!.remainingMs, 20_000);
    mock.timers.tick(19_999 + 1_500);
    assert.equal(game.phase, 'open', 'still open past the original deadline');
    mock.timers.tick(1);
    assert.equal(game.phase, 'closed');

    game.advance();
    game.advance();
    game.advance(); // Q2 open
    game.pause();
    game.extend(30);
    assert.equal(game.hostView().question!.remainingMs, 50_000);
    assert.equal(game.extend(0).ok, false);
    assert.equal(game.extend(500).ok, false);
    game.advance(); // closing while paused works
    assert.equal(game.phase, 'closed');
    assert.equal(game.extend(5).ok, false, 'nothing to extend once closed');
    game.dispose();
  } finally {
    mock.timers.reset();
  }
});

test('skip throws a question away: no points for anyone, and the quiz moves on', () => {
  const { game } = setup();
  const [a] = join(game, 'A');
  game.advance();
  game.answer(a!.id, 0);
  assert.equal(game.phase, 'closed');
  assert.ok(game.skip().ok);
  assert.equal(game.questionIndex, 1);
  assert.equal(game.phase, 'open');
  game.answer(a!.id, 0);
  game.advance();
  game.advance();
  assert.equal(game.standings()[0]!.score, 1000, 'only the question that was not skipped counts');
  assert.deepEqual(game.resultsTable()[1], ['1', 'A', '1000', '0', '1000']);
  assert.equal(game.skip().ok, false, 'a revealed question cannot be skipped');
  game.advance();
  game.advance(); // Q3 open
  assert.ok(game.skip().ok);
  assert.equal(game.phase, 'finished', 'skipping the last question ends the quiz');
  game.dispose();
});

test('leaderboard after each round only: the quiz goes straight on until a round ends', () => {
  const quiz = parseQuiz(`
title: Rounds
scoring: { leaderboard: round }
rounds:
  - name: R1
    questions: [${q()}, ${q()}]
  - name: R2
    questions: [${q()}]
`);
  const { game } = setup(quiz);
  const [a] = join(game, 'A');
  const phases: string[] = [];
  game.advance();
  for (let i = 0; i < 3; i++) {
    game.answer(a!.id, 0);
    game.advance(); // reveal
    game.advance();
    phases.push(`${game.questionIndex}:${game.phase}`);
    if (game.phase === 'leaderboard') game.advance();
  }
  assert.deepEqual(phases, ['1:open', '1:leaderboard', '2:leaderboard']);
  assert.equal(game.phase, 'finished');
  game.dispose();
});

test('scoring modes: flat ignores time; first adds a bonus for the first correct team; rounds can differ', () => {
  const quiz = parseQuiz(`
title: Modes
scoring: { mode: flat, bonus: 500 }
rounds:
  - name: Flat
    questions: [${q()}]
  - name: First
    mode: first
    questions: [${q()}]
  - name: Speed
    mode: speed
    questions: [${q()}]
`);
  assert.deepEqual(quiz.questions.map((x) => x.mode), ['flat', 'first', 'speed']);
  const { game, tick } = setup(quiz);
  const [slow, fast, wrong] = join(game, 'Slow', 'Fast', 'Wrong');
  const play = () => {
    game.advance();
    tick(2_000);
    game.answer(fast!.id, 0);
    tick(10_000);
    game.answer(slow!.id, 0);
    game.answer(wrong!.id, 1);
    game.advance();
    const points = [slow, fast, wrong].map((t) => game.teamView(t!.id)!.result!.points);
    game.advance();
    return points;
  };
  assert.deepEqual(play(), [1000, 1000, 0], 'flat: the same however long it took');
  assert.deepEqual(play(), [1000, 1500, 0], 'first: the fastest correct team gets the bonus');
  assert.deepEqual(play(), [700, 950, 0], 'speed: 12 s and 2 s of 20');
  assert.match(game.teamView(fast!.id)!.standings!.map((r) => r.name).join(), /Fast/);
  game.dispose();
});

test('"first" bonus goes only to a correct team, even if a wrong team was quicker', () => {
  const quiz = parseQuiz(`title: T\nscoring: { mode: first }\nrounds:\n  - name: R\n    questions: [${q()}]\n`);
  const { game, tick } = setup(quiz);
  const [wrongFirst, rightLater] = join(game, 'WrongFirst', 'RightLater');
  game.advance();
  tick(1_000);
  game.answer(wrongFirst!.id, 1);
  tick(3_000);
  game.answer(rightLater!.id, 0);
  game.advance();
  assert.equal(game.teamView(rightLater!.id)!.result!.points, 1500);
  assert.equal(game.teamView(rightLater!.id)!.result!.detail, '⚡ First correct answer: bonus!');
  assert.equal(game.teamView(wrongFirst!.id)!.result!.points, 0);
  game.dispose();
});

test('equal scores are split by the quicker total time; truly equal teams share a place', () => {
  const quiz = parseQuiz(`title: T\nscoring: { mode: flat, leaderboard: question }\nrounds:\n  - name: R\n    questions: [${q()}, ${q()}]\n`);
  const { game, tick } = setup(quiz);
  const [quick, slow, same, none] = join(game, 'Quick', 'Slow', 'Same', 'None');
  for (let i = 0; i < 2; i++) {
    game.advance();
    tick(1_000);
    game.answer(quick!.id, 0);
    game.answer(same!.id, 0);
    tick(3_000);
    game.answer(slow!.id, 0);
    game.advance();
    game.advance();
    if (i === 0) game.advance();
  }
  const rows = Object.fromEntries(game.standings().map((r) => [r.name, r]));
  assert.deepEqual([rows.Quick!.score, rows.Slow!.score, rows.Same!.score, rows.None!.score], [2000, 2000, 2000, 0]);
  assert.deepEqual([rows.Quick!.rank, rows.Same!.rank, rows.Slow!.rank, rows.None!.rank], [1, 1, 3, 4]);
  game.dispose();
});

test('phone-measured time is used only when it fits what the server saw', () => {
  const { game, tick } = setup();
  const teams = join(game, 'Honest', 'Cheat', 'Slow', 'Early', 'NoClaim');
  game.advance();
  tick(10_000);
  // Server saw 10 s since sending; the phone's round trip is 200 ms, tolerance 150 ms.
  game.answer(teams[0]!.id, 0, 200, 9_850); // inside the bound: trusted
  game.answer(teams[1]!.id, 0, 200, 100); // claims an instant answer: not trusted
  game.answer(teams[2]!.id, 0, 200, 10_500); // longer than time since sent: impossible
  game.answer(teams[3]!.id, 0, 200, 9_600); // below the bound: not trusted
  game.answer(teams[4]!.id, 0, 200); // sent nothing: server figure
  game.advance();
  const points = teams.map((t) => game.teamView(t.id)!.result!.points);
  // 1000 × (1 − 0.5 × t/20 s): 9.85 s → 754 (rounded), 9.8 s → 755.
  assert.equal(points[0], Math.round(1000 * (1 - (0.5 * 9.85) / 20)));
  for (const i of [1, 2, 3, 4]) assert.equal(points[i], 755, `team ${i} gets the server's figure of 9.8 s`);
  assert.ok(points[0]! < points[1]!, 'the honest claim is a little slower than the server figure, so it scores less');
  game.dispose();
});

test('a snapshot keeps a paused clock and skipped questions', () => {
  const { game, tick } = setup();
  const [a] = join(game, 'A');
  game.advance();
  game.skip();
  tick(3_000);
  game.pause();
  const snapshot = JSON.parse(JSON.stringify(game.snapshot()));
  game.dispose();
  const restored = Game.restore(BASIC, snapshot);
  assert.equal(restored.paused, true);
  assert.equal(restored.questionIndex, 1);
  assert.equal(restored.rejoin({ token: a!.token })?.name, 'A');
  assert.equal(restored.phase, 'open');
  restored.dispose();
});

async function start(extra: Parameters<typeof createQuizServer>[0] = {}) {
  return createQuizServer({ closeEarly: true, quiz: BASIC, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', ...extra });
}

test('only the host can pause, resume, extend or skip, over the socket', async () => {
  const server = await start();
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const team = await Client.connect(server.port);
  team.send({ t: 'join', room: server.roomCode, name: 'Ann' });
  await team.waitFor((m) => m.t === 'joined');
  host.send({ t: 'advance' });
  await team.state('open');

  for (const message of [{ t: 'pause' }, { t: 'resume' }, { t: 'extend', seconds: 10 }, { t: 'skip' }]) {
    team.send(message);
    assert.equal((await team.waitFor((m) => m.t === 'error')).message, 'Only the host can do that.');
  }
  assert.equal(server.game!.paused, false);

  host.send({ t: 'pause' });
  assert.equal((await team.state('open', (v) => v.question.paused === true)).question.paused, true);
  team.send({ t: 'answer', value: 0 });
  assert.match((await team.waitFor((m) => m.t === 'error')).message, /paused/);
  host.send({ t: 'resume' });
  await team.state('open', (v) => !v.question.paused);
  host.send({ t: 'extend', seconds: 15 });
  await host.state('open', (v) => v.question.remainingMs > 30_000);
  host.send({ t: 'resume' });
  assert.match((await host.waitFor((m) => m.t === 'error')).message, /Not paused/);
  host.send({ t: 'skip' });
  await host.state('open', (v) => v.question.index === 1);
  for (const c of [host, team]) await c.close();
  await server.close();
});

test('the phone sends its own timing and the server uses it when plausible', async () => {
  const server = await start();
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const team = await Client.connect(server.port);
  team.send({ t: 'join', room: server.roomCode, name: 'Ann' });
  await team.waitFor((m) => m.t === 'joined');
  host.send({ t: 'advance' });
  await team.state('open');
  await new Promise((resolve) => setTimeout(resolve, 300));
  team.send({ t: 'answer', value: 0, elapsedMs: 250 });
  await host.state('closed');
  host.send({ t: 'advance' });
  const result = (await team.state('reveal')).result;
  // About 0.25 to 0.3 s into 20: just under 1000 × (1 − 0.5 × 0.0125).
  assert.ok(result.points >= 990 && result.points <= 994, `points ${result.points}`);
  team.send({ t: 'answer', value: 0, elapsedMs: -5 });
  assert.equal((await team.waitFor((m) => m.t === 'error')).message, 'Unrecognised message.', 'negative times are refused outright');
  for (const c of [host, team]) await c.close();
  await server.close();
});

test('host PIN: typing it gives the host key, wrong guesses are limited, and no PIN means no login', async () => {
  const server = await start({ hostPin: 'letmein-123' });
  const base = `http://127.0.0.1:${server.port}`;
  const login = (pin: string) =>
    fetch(`${base}/login`, { method: 'POST', body: JSON.stringify({ pin }), headers: { 'content-type': 'application/json' } });

  assert.deepEqual(await (await fetch(`${base}/login`)).json(), { pin: true });
  for (let i = 0; i < 5; i++) assert.equal((await login(`wrong-${i}`)).status, 401);
  assert.equal((await login('letmein-123')).status, 429, 'locked out after 5 wrong guesses, even with the right PIN');
  await server.close();

  const second = await start({ hostPin: 'letmein-123' });
  const url = `http://127.0.0.1:${second.port}/login`;
  const ok = await fetch(url, { method: 'POST', body: JSON.stringify({ pin: ' letmein-123 ' }) });
  assert.equal(ok.status, 200);
  const { key } = (await ok.json()) as { key: string };
  assert.equal(key, second.hostKey);
  assert.equal((await fetch(url, { method: 'POST', body: 'not json' })).status, 400);
  const host = await Client.connect(second.port);
  host.send({ t: 'host', key });
  assert.equal((await host.waitFor((m) => m.t === 'state')).view.phase, 'lobby');
  await host.close();
  await second.close();

  const noPin = await start();
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${noPin.port}/login`)).json(), { pin: false });
  assert.equal((await fetch(`http://127.0.0.1:${noPin.port}/login`, { method: 'POST', body: '{"pin":"x"}' })).status, 404);
  await noPin.close();
});
