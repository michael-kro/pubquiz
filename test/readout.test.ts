// Read-out mode: the host shows each multiple-choice answer, then starts the timer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';

const QUIZ = `
title: Read
readOut: true
scoring: { leaderboard: question }
rounds:
  - name: R
    questions:
      - { type: multiple-choice, text: Pick, options: [a, b, c], answer: 1 }
      - { type: letter, text: Who?, answer: Abba }
`;

test('answers appear one at a time and the last one starts the timer', () => {
  const game = new Game(parseQuiz(QUIZ));
  const t = game.join('A');
  assert.ok(t.ok);
  game.advance();
  assert.equal(game.phase, 'reading');
  const options = () => game.teamView(t.value.id)!.question!.options;
  assert.deepEqual(options(), []);
  assert.equal(game.teamView(t.value.id)!.question!.remainingMs, undefined, 'no clock yet');
  assert.equal(game.answer(t.value.id, 1).ok, false, 'cannot answer while it is being read');
  game.advance();
  game.advance();
  assert.deepEqual(options(), ['a', 'b']);
  assert.deepEqual(game.hostView().reading, { shown: 2, total: 3 });
  game.advance();
  assert.equal(game.phase, 'open', 'showing the last answer starts the timer');
  assert.deepEqual(options(), ['a', 'b', 'c']);
  assert.ok(game.answer(t.value.id, 1).ok);
  game.dispose();
});

test('start the timer early, switch the mode off, and other question types wait for the host too', () => {
  const game = new Game(parseQuiz(QUIZ));
  game.join('A');
  assert.equal(game.startTimerNow().ok, false);
  game.advance();
  assert.ok(game.startTimerNow().ok);
  assert.equal(game.phase, 'open');
  assert.equal(game.teamView(game.hostView().teams[0]!.id)!.question!.options!.length, 3, 'every answer shows');
  game.advance(); // close
  game.advance(); // reveal
  game.advance(); // leaderboard
  game.advance(); // the letter question waits too, with nothing to reveal
  assert.equal(game.phase, 'reading');
  assert.equal(game.hostView().reading, undefined);
  game.advance();
  assert.equal(game.phase, 'open');
  game.dispose();

  const off = new Game(parseQuiz(QUIZ));
  off.setReadOut(false);
  off.advance();
  assert.equal(off.phase, 'open');
  off.dispose();
});

test('a question skipped while being read, and a saved game that is mid-reading', () => {
  const game = new Game(parseQuiz(QUIZ));
  const t = game.join('A');
  assert.ok(t.ok);
  game.advance();
  game.advance();
  const restored = Game.restore(game.quiz, JSON.parse(JSON.stringify(game.snapshot())));
  assert.equal(restored.phase, 'reading');
  assert.equal(restored.readOut, true);
  assert.deepEqual(restored.hostView().reading, { shown: 1, total: 3 }, 'keeps what was showing');
  restored.dispose();
  assert.ok(game.skip().ok);
  assert.equal(game.questionIndex, 1);
  game.dispose();
});

test('a question knows its place within its round, not the whole quiz', () => {
  const game = new Game(parseQuiz(`
title: Rounds
scoring: { leaderboard: question }
rounds:
  - name: One
    questions:
      - { type: letter, text: A, answer: Abba }
      - { type: letter, text: B, answer: Abba }
  - name: Two
    questions:
      - { type: letter, text: C, answer: Abba }
`));
  game.join('A');
  const place = () => [game.hostView().question!.roundQuestion, game.hostView().question!.roundQuestions];
  game.advance();
  assert.deepEqual(place(), [1, 2]);
  for (let i = 0; i < 3; i++) game.advance(); // close, reveal, leaderboard
  game.advance();
  assert.deepEqual(place(), [2, 2]);
  for (let i = 0; i < 4; i++) game.advance();
  assert.deepEqual(place(), [1, 1]);
  game.dispose();
});

test('letter questions: a grouped keypad is the default, and a tap on the key holding the letter is right', () => {
  const quiz = parseQuiz(`
title: Letters
scoring: { leaderboard: question }
rounds:
  - name: R
    questions:
      - { type: letter, text: Who sang Imagine?, answer: John Lennon }
      - { type: letter, text: Who sang Hey Jude?, answer: Paul McCartney, keypad: single }
`);
  const game = new Game(quiz);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => {
    const r = game.join(n);
    assert.ok(r.ok);
    return r.value;
  });
  game.advance();
  assert.equal(game.hostView().question!.keypad, 'grouped');
  assert.ok(game.answer(a!.id, 'J').ok);
  assert.ok(game.answer(b!.id, 'j').ok, 'a single letter is still accepted');
  assert.equal(game.answer(c!.id, 'JKL').ok, false, 'not a key');
  assert.ok(game.answer(c!.id, 'QV').ok, 'a shared key counts as a tap');
  game.advance();
  game.advance();
  assert.equal(game.teamView(a!.id)!.result!.correct, true);
  assert.equal(game.teamView(b!.id)!.result!.correct, true);
  assert.equal(game.teamView(c!.id)!.result!.correct, false);
  assert.match(game.hostView().summary!, /J ×2/);
  game.advance();
  game.advance();
  assert.equal(game.hostView().question!.keypad, 'single');
  game.dispose();
});

test('the quickest right answer is named to every screen on the reveal', async () => {
  let clock = 1_000_000;
  const game = new Game(parseQuiz(`
title: Fast
scoring: { leaderboard: question }
rounds:
  - name: R
    questions:
      - { type: multiple-choice, text: Q, options: [a, b], answer: 0 }
      - { type: nearest, text: N, answer: 5 }
`), { now: () => clock });
  const [slow, quick, wrong] = ['Slow', 'Quick', 'Wrong'].map((n) => {
    const r = game.join(n);
    assert.ok(r.ok);
    return r.value;
  });
  game.advance();
  assert.equal(game.teamView(slow!.id)!.speedster, undefined, 'not before the reveal');
  clock += 4000;
  game.answer(slow!.id, 0);
  clock += 100;
  game.answer(quick!.id, 0, 500);
  game.answer(wrong!.id, 1, 100);
  assert.equal(game.phase, 'closed', 'everyone answered');
  game.advance();
  assert.equal(game.phase, 'reveal');
  assert.deepEqual([game.teamView(wrong!.id)!.speedster?.name, game.hostView().speedster?.name], [quick!.name, quick!.name]);
  game.advance(); // leaderboard
  game.advance(); // the nearest question: speed is irrelevant
  for (const t of [slow, quick, wrong]) game.answer(t!.id, 5);
  game.advance();
  assert.equal(game.phase, 'reveal');
  assert.equal(game.hostView().speedster, undefined);
  game.dispose();
});

test('the server runs the clock down even when everyone has answered, unless closing early is switched on', async () => {
  const { createQuizServer } = await import('../server/server.ts');
  const { Client } = await import('./client.ts');
  const server = await createQuizServer({ quiz: parseQuiz(QUIZ.replace('readOut: true', 'readOut: false')), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const ann = await Client.connect(server.port);
  ann.send({ t: 'join', room: server.roomCode, name: 'Ann' });
  await ann.waitFor((m) => m.t === 'joined');
  host.send({ t: 'advance' });
  await ann.state('open');
  ann.send({ t: 'answer', value: 1 });
  const view = await host.state('open', (v) => v.answeredCount === 1);
  assert.equal(view.closeEarly, false);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(server.game!.phase, 'open', 'still counting down');
  host.send({ t: 'close-early', on: true });
  await host.state('open', (v) => v.closeEarly === true);
  for (const c of [host, ann]) await c.close();
  await server.close();
});

test('a team sees how long it took to lock in, and the fastest team is named with its time', () => {
  let clock = 5_000_000;
  const game = new Game(parseQuiz(QUIZ.replace('readOut: true', 'readOut: false')), { now: () => clock });
  const [a, b] = ['A', 'B'].map((n) => {
    const r = game.join(n);
    assert.ok(r.ok);
    return r.value;
  });
  game.advance();
  clock += 2320;
  game.answer(a!.id, 1);
  clock += 1000;
  game.answer(b!.id, 1);
  assert.equal(game.teamView(a!.id)!.myAnswerMs, 2320);
  assert.equal(game.teamView(b!.id)!.myAnswerMs, 3320);
  game.advance();
  assert.equal(game.hostView().speedster!.ms, 2320);
  game.dispose();
});

test('with start-on-last switched off, the host starts the timer separately', () => {
  const game = new Game(parseQuiz(QUIZ));
  game.setStartOnLastAnswer(false);
  game.join('A');
  game.advance();
  for (let i = 0; i < 3; i++) game.advance();
  assert.equal(game.phase, 'reading', 'all three showing, timer waiting');
  assert.deepEqual(game.hostView().reading, { shown: 3, total: 3 });
  assert.equal(game.hostView().startOnLastAnswer, false);
  game.advance();
  assert.equal(game.phase, 'open');
  game.dispose();
});

test('locking the quiz stops new teams joining, but teams already in can rejoin', () => {
  const game = new Game(parseQuiz(QUIZ));
  const a = game.join('A');
  assert.ok(a.ok);
  game.setJoiningLocked(true);
  assert.equal(game.hostView().joiningLocked, true);
  const late = game.join('Late');
  assert.equal(late.ok, false);
  assert.match(late.ok ? '' : late.error, /closed the quiz to new teams/);
  assert.ok(game.rejoin({ token: a.value.token }), 'an existing team gets back in');
  assert.ok(game.rejoin({ code: a.value.code }), 'and with its code');
  const restored = Game.restore(game.quiz, JSON.parse(JSON.stringify(game.snapshot())));
  assert.equal(restored.join('Later').ok, false, 'the lock survives a restart');
  restored.dispose();
  game.setJoiningLocked(false);
  assert.ok(game.join('Late').ok);
  game.dispose();
});

test('pressing Start quiz locks the door when the host has asked for that', () => {
  const game = new Game(parseQuiz(QUIZ), { lockOnStart: true });
  game.join('A');
  assert.equal(game.hostView().joiningLocked, false, 'open in the lobby');
  assert.equal(game.hostView().lockOnStart, true);
  game.advance();
  assert.equal(game.joiningLocked, true);
  assert.equal(game.join('Late').ok, false);
  game.dispose();

  const open = new Game(parseQuiz(QUIZ), { lockOnStart: true });
  open.setLockOnStart(false);
  open.join('A');
  open.advance();
  assert.ok(open.join('Late').ok, 'unticked: late teams can still join');
  open.dispose();
});

test('optional prizes for 1st to 3rd: set by the host, seen by everyone, saved with the game', () => {
  const game = new Game(parseQuiz(QUIZ.replace('readOut: true', 'readOut: true\nprizes: [A round of drinks]')));
  const t = game.join('A');
  assert.ok(t.ok);
  assert.deepEqual(game.teamView(t.value.id)!.prizes, ['A round of drinks', '', ''], 'from the quiz file');
  game.setPrizes(['Trophy', '  £20 bar tab ', '', 'ignored fourth']);
  assert.deepEqual(game.hostView().prizes, ['Trophy', '£20 bar tab', '']);
  assert.deepEqual(game.teamView(t.value.id)!.prizes, ['Trophy', '£20 bar tab', '']);
  const restored = Game.restore(game.quiz, JSON.parse(JSON.stringify(game.snapshot())));
  assert.deepEqual(restored.hostView().prizes, ['Trophy', '£20 bar tab', '']);
  restored.dispose();
  game.setPrizes(['', '', '']);
  assert.equal(game.hostView().prizes, undefined, 'none set: nothing to show');
  game.dispose();
  assert.throws(() => parseQuiz(QUIZ.replace('readOut: true', 'readOut: true\nprizes: [a, b, c, d]')), /prizes/);
});

test('"close early" waits briefly for a phone that just dropped, then stops waiting', () => {
  let clock = 9_000_000;
  const game = new Game(parseQuiz(QUIZ.replace('readOut: true', 'readOut: false')), { now: () => clock });
  const [a, b] = ['A', 'B'].map((n) => {
    const r = game.join(n);
    assert.ok(r.ok);
    return r.value;
  });
  game.advance();
  game.disconnect(b!.id); // B's signal blips
  clock += 300;
  game.answer(a!.id, 1);
  assert.equal(game.phase, 'open', 'still waiting for B, who has only just dropped');
  game.rejoin({ token: b!.token });
  game.answer(b!.id, 1);
  assert.equal(game.phase, 'closed', 'B came back and answered: done');
  game.dispose();

  let later = 9_000_000;
  const g2 = new Game(parseQuiz(QUIZ.replace('readOut: true', 'readOut: false')), { now: () => later });
  const [x, y] = ['X', 'Y'].map((n) => {
    const r = g2.join(n);
    assert.ok(r.ok);
    return r.value;
  });
  g2.advance();
  g2.disconnect(y!.id);
  later += 7_000; // gone for longer than the grace period
  g2.answer(x!.id, 1);
  assert.equal(g2.phase, 'closed', 'a phone that has been gone a while no longer holds the question up');
  g2.dispose();
});

test('picture questions can be revealed slowly behind tiles; only the host decides, and other types refuse the option', () => {
  const quiz = parseQuiz(`
title: Uncover
rounds:
  - name: R
    questions:
      - { type: picture, text: Who?, image: "https://example.com/a.png", accept: [x], uncover: true }
      - { type: picture, text: Who?, image: "https://example.com/a.png", accept: [x] }
`);
  const game = new Game(quiz);
  game.join('A');
  game.advance();
  assert.equal(game.hostView().question!.uncover, true);
  game.dispose();
  const plain = new Game(quiz);
  plain.join('A');
  plain.advance();
  plain.skip();
  assert.equal(plain.hostView().question!.uncover, undefined);
  plain.dispose();
  assert.throws(() => parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: A, uncover: true }\n'), /uncover/);
});
