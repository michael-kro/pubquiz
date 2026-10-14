// M8c: Buzzin' questions: the first to buzz answers out loud and the host judges.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { BUZZ_WINDOW_MS, Game, type Team } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';

const BUZZ = '{ type: buzzer, text: "Capital of Australia?", answer: Canberra, seconds: 30, points: 1000 }';
const yaml = (extra = '') => `title: T\nrounds:\n  - name: R\n    questions: [${BUZZ.replace('}', `${extra} }`)}, { type: letter, text: Next, answer: Abba }]\n`;

function play(run: (game: Game, join: (...names: string[]) => Team[]) => void, extra = ''): void {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const game = new Game(parseQuiz(yaml(extra)));
    const join = (...names: string[]): Team[] => names.map((n) => {
      const r = game.join(n);
      assert.ok(r.ok);
      return r.value;
    });
    run(game, join);
    game.dispose();
  } finally {
    mock.timers.reset();
  }
}

const settle = () => mock.timers.tick(BUZZ_WINDOW_MS + 1);
const status = (game: Game) => game.hostView().buzzers!.map((b) => `${b.name}:${b.status}`);

test('the format: penalty defaults to 0, and an answer is needed', () => {
  const q = parseQuiz(yaml()).questions[0]!;
  assert.equal(q.type, 'buzzer');
  assert.equal('penalty' in q && q.penalty, 0);
  assert.throws(() => parseQuiz('title: T\nrounds:\n  - name: R\n    questions: [{ type: buzzer, text: Q }]\n'), /answer/);
});

test('the first to buzz answers; others queue behind; the clock holds while they answer', () => {
  play((game, join) => {
    const [a, b, c] = join('A', 'B', 'C');
    game.advance();
    mock.timers.tick(2_000);
    assert.ok(game.buzz(a!.id).ok);
    assert.deepEqual(status(game), ['A:queued'], 'not decided until the short window passes');
    mock.timers.tick(30);
    assert.ok(game.buzz(b!.id).ok);
    settle();
    assert.deepEqual(status(game), ['A:answering', 'B:queued']);
    assert.equal(game.paused, true, 'the clock is held while a team answers');
    assert.deepEqual(game.teamView(a!.id)!.question!.buzz, { state: 'answering', answering: 'A' });
    assert.deepEqual(game.teamView(b!.id)!.question!.buzz, { state: 'queued', answering: 'A', position: 2 });
    assert.deepEqual(game.teamView(c!.id)!.question!.buzz, { state: 'ready', answering: 'A' });
    // Late buzzers join the queue behind.
    mock.timers.tick(5_000);
    assert.ok(game.buzz(c!.id).ok);
    assert.deepEqual(game.teamView(c!.id)!.question!.buzz, { state: 'queued', answering: 'A', position: 3 });
    assert.equal(game.buzz(a!.id).ok, false, 'no second buzz');
    assert.equal(game.buzz(b!.id).ok, false);
  });
});

test('buzzes within the window are ordered by their real time, not by arrival', () => {
  play((game, join) => {
    const [slowLink, fastLink] = join('SlowLink', 'FastLink');
    game.advance();
    mock.timers.tick(3_000);
    // SlowLink pressed first (100 ms round trip), but FastLink's message arrived a moment before theirs.
    assert.ok(game.buzz(fastLink!.id, 0).ok);
    mock.timers.tick(60);
    assert.ok(game.buzz(slowLink!.id, 100).ok); // 60 ms later, minus 100 ms of delay: earlier in truth
    settle();
    assert.deepEqual(status(game), ['SlowLink:answering', 'FastLink:queued']);
  });
});

test('right answer: the team scores the points, the question closes, nobody else scores', () => {
  play((game, join) => {
    const [a, b] = join('A', 'B');
    game.advance();
    game.buzz(a!.id);
    game.buzz(b!.id);
    settle();
    assert.equal(game.judge(true).ok, true);
    assert.equal(game.phase, 'closed');
    assert.equal(game.paused, false);
    assert.deepEqual(status(game), ['A:right', 'B:queued'].filter((x) => x.startsWith('A')), 'the queue is cleared once it is over');
    game.advance();
    assert.deepEqual(game.teamView(a!.id)!.result, { correct: true, points: 1000, answerText: 'Canberra', detail: undefined, correctIndex: undefined, info: undefined });
    assert.equal(game.teamView(b!.id)!.result!.points, 0);
    assert.equal(game.teamView(b!.id)!.result!.detail, 'Buzzed, but did not get to answer');
    assert.equal(game.teamView(b!.id)!.question!.buzz!.state, 'over');
    assert.equal(game.teamView(a!.id)!.question!.buzz!.state, 'won');
    assert.equal(game.standings()[0]!.name, 'A');
  });
});

test('wrong answer: that team is out, the next in line answers, then the clock resumes for the rest', () => {
  play((game, join) => {
    const [a, b, c] = join('A', 'B', 'C');
    game.advance();
    mock.timers.tick(1_000);
    game.buzz(a!.id);
    mock.timers.tick(20);
    game.buzz(b!.id);
    settle();
    assert.equal(game.judge(false).ok, true);
    assert.deepEqual(status(game), ['B:answering', 'A:wrong']);
    assert.equal(game.teamView(a!.id)!.question!.buzz!.state, 'locked');
    assert.equal(game.buzz(a!.id).ok, false, 'a team that was wrong cannot buzz again');
    mock.timers.tick(10_000);
    assert.equal(game.judge(false).ok, true);
    assert.equal(game.paused, false, 'nobody is answering: the clock is running again');
    assert.deepEqual(status(game), ['A:wrong', 'B:wrong']);
    assert.ok(game.buzz(c!.id).ok, 'the team that never buzzed can still go');
    settle();
    assert.equal(game.judge(true).ok, true);
    assert.equal(game.phase, 'closed');
    game.advance();
    assert.equal(game.teamView(c!.id)!.result!.points, 1000);
    assert.equal(game.teamView(a!.id)!.result!.detail, 'Wrong answer');
    assert.equal(game.teamView(a!.id)!.result!.points, 0, 'no penalty unless the quiz sets one');
  });
});

test('the clock carries on from where it was after someone answers wrongly, and runs out as normal', () => {
  play((game, join) => {
    const [a] = join('A', 'B');
    game.advance();
    mock.timers.tick(10_000);
    game.buzz(a!.id);
    settle();
    mock.timers.tick(60_000); // a long answer
    assert.ok(game.hostView().question!.remainingMs! > 19_000 && game.hostView().question!.remainingMs! <= 20_000, 'the time spent answering was not taken off');
    game.judge(false);
    mock.timers.tick(19_000);
    assert.equal(game.phase, 'open');
    mock.timers.tick(1_000 + 1_500);
    assert.equal(game.phase, 'closed', 'time ran out with nobody right');
  });
});

test('everyone out ends the question; a penalty is taken off a wrong answer', () => {
  play((game, join) => {
    const [a, b] = join('A', 'B');
    game.advance();
    game.buzz(a!.id);
    game.buzz(b!.id);
    settle();
    game.judge(false);
    assert.equal(game.phase, 'open');
    game.judge(false);
    assert.equal(game.phase, 'closed', 'both teams are out');
    game.advance();
    assert.equal(game.teamView(a!.id)!.result!.points, -250);
    assert.equal(game.teamView(a!.id)!.result!.detail, 'Wrong answer: -250');
    game.advance();
    assert.deepEqual(game.standings().map((r) => r.score), [-250, -250]);
  }, ', penalty: 250');
});

test('the host cannot judge with nobody answering, pause someone mid-answer, or answer a buzzer by typing', () => {
  play((game, join) => {
    const [a] = join('A');
    assert.equal(game.judge(true).ok, false, 'not a buzzer question yet');
    game.advance();
    assert.deepEqual(game.judge(true), { ok: false, error: 'No team is answering right now.' });
    assert.equal(game.answer(a!.id, 'Canberra').ok, false);
    assert.deepEqual(game.answer(a!.id, 'Canberra'), { ok: false, error: 'Press the buzzer.' });
    game.buzz(a!.id);
    settle();
    assert.deepEqual(game.pause(), { ok: false, error: 'A team is answering. Judge them first.' });
    assert.deepEqual(game.resume(), { ok: false, error: 'A team is answering. Judge them first.' });
    game.judge(true);
    game.advance();
    game.advance();
    game.advance(); // Next (a letter question)
    assert.equal(game.buzz(a!.id).ok, false, 'nothing to buzz on a normal question');
  });
});

test('a paused quiz cannot be buzzed, and closing the question ends a turn without a verdict', () => {
  play((game, join) => {
    const [a, b] = join('A', 'B');
    game.advance();
    game.pause();
    assert.deepEqual(game.buzz(a!.id), { ok: false, error: 'The quiz master has paused the quiz.' });
    game.resume();
    game.buzz(a!.id);
    game.buzz(b!.id);
    settle();
    game.advance(); // host closes the question while A is mid-answer
    assert.equal(game.phase, 'closed');
    game.advance();
    assert.equal(game.teamView(a!.id)!.result!.points, 0);
    assert.equal(game.teamView(a!.id)!.result!.detail, 'Buzzed, but did not get to answer');
  });
});

test('removing the team that is answering hands the turn to the next, or frees the clock', () => {
  play((game, join) => {
    const [a, b] = join('A', 'B');
    game.advance();
    game.buzz(a!.id);
    game.buzz(b!.id);
    settle();
    assert.ok(game.kick(a!.id));
    assert.deepEqual(status(game), ['B:answering']);
    assert.ok(game.kick(b!.id));
    assert.equal(game.paused, false);
    assert.deepEqual(status(game), []);
  });
});

test('a game in the middle of a Buzzin\' question can be saved and carried on', () => {
  play((game, join) => {
    const [a, b] = join('A', 'B');
    game.advance();
    mock.timers.tick(1_000);
    game.buzz(a!.id);
    game.buzz(b!.id);
    settle();
    game.judge(false);
    const snapshot = JSON.parse(JSON.stringify(game.snapshot()));
    const restored = Game.restore(game.quiz, snapshot);
    assert.deepEqual(status(restored), ['B:answering', 'A:wrong']);
    assert.equal(restored.paused, true);
    assert.equal(restored.judge(true).ok, true);
    restored.advance();
    const rejoined = restored.rejoin({ token: b!.token });
    assert.equal(restored.teamView(rejoined!.id)!.result!.points, 1000);
    restored.dispose();
  });
});

test('a buzz still waiting out its window when the program stopped is settled on restart', () => {
  play((game, join) => {
    const [a] = join('A');
    game.advance();
    game.buzz(a!.id);
    const snapshot = JSON.parse(JSON.stringify(game.snapshot()));
    const restored = Game.restore(game.quiz, snapshot);
    assert.deepEqual(status(restored), ['A:answering']);
    restored.dispose();
  });
});
