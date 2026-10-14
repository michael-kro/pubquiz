import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game, type Team } from '../server/game.ts';
import { editDistance, matchAnswer, normalise } from '../server/matching.ts';
import { firstLetter, parseQuiz } from '../server/quiz.ts';

const quiz = parseQuiz(`
title: Types
rounds:
  - name: Mixed
    questions:
      - type: picture
        text: Which landmark?
        image: https://example.com/eiffel.jpg
        accept: [Eiffel Tower]
      - type: music
        text: Name the band
        accept: [Queen]
      - type: ordering
        text: Smallest first
        items: ["1", "2", "3", "4", "5"]
        seconds: 20
        points: 1000
      - type: letter
        text: Who sang Imagine?
        answer: John Lennon
`);

function setup() {
  let now = 0;
  const game = new Game(quiz, { now: () => now });
  return { game, tick: (ms: number) => (now += ms) };
}

function join(game: Game, name: string): Team {
  const result = game.join(name);
  assert.ok(result.ok);
  return result.value;
}

/** Moves from an open question to the next one, via closed, reveal and leaderboard. */
function finishQuestion(game: Game): void {
  while (game.phase !== 'leaderboard') game.advance();
}

test('normalise ignores case, accents, punctuation, "&" and a leading article', () => {
  assert.equal(normalise('  The Beatles! '), 'beatles');
  assert.equal(normalise('Beyoncé'), 'beyonce');
  assert.equal(normalise('Simon & Garfunkel'), 'simon and garfunkel');
  assert.equal(normalise('A-ha'), 'aha');
  assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('matchAnswer: exact, close (small typos) and none', () => {
  assert.equal(matchAnswer('the eiffel tower', ['Eiffel Tower']), 'exact');
  assert.equal(matchAnswer('Eifel Towr', ['Eiffel Tower']), 'close');
  assert.equal(matchAnswer('Quen', ['Queen']), 'close');
  assert.equal(matchAnswer('Abba', ['Queen']), 'none');
  assert.equal(matchAnswer('Cat', ['Car']), 'none', 'short answers need to be exact');
  assert.equal(matchAnswer('!!!', ['Queen']), 'none');
});

test('first letter: skips "The", uses first names, and can be overridden', () => {
  assert.equal(firstLetter('John Lennon'), 'J');
  assert.equal(firstLetter('The Lion King'), 'L');
  assert.equal(firstLetter('Émile Zola'), 'E');
  assert.equal(firstLetter('101 Dalmatians', 'O'), 'O');
});

test('picture: typed answers are auto-marked, grouped for the host, and the host can override', () => {
  const { game, tick } = setup();
  const exact = join(game, 'Exact');
  const typo = join(game, 'Typo');
  const sameTypo = join(game, 'Same Typo');
  const wrong = join(game, 'Wrong');
  game.advance();
  assert.equal(game.teamView(exact.id)!.question!.image, 'https://example.com/eiffel.jpg');

  assert.equal(game.answer(exact.id, 3).ok, false, 'typed questions need text');
  assert.equal(game.answer(exact.id, '   ').ok, false);
  assert.equal(game.answer(exact.id, 'x'.repeat(101)).ok, false);
  tick(1000);
  game.answer(exact.id, 'The  Eiffel Tower');
  game.answer(typo.id, 'eifel tower');
  game.answer(sameTypo.id, 'Eifel Tower!');
  game.answer(wrong.id, 'Big Ben');
  assert.equal(game.phase, 'closed');

  const review = game.hostView().review!;
  assert.deepEqual(
    review.map((g) => [g.text, g.match, g.correct, g.teams]),
    [
      ['The Eiffel Tower', 'exact', true, ['Exact']],
      ['eifel tower', 'close', true, ['Typo', 'Same Typo']],
      ['Big Ben', 'none', false, ['Wrong']],
    ],
  );

  // The host decides the typo doesn't count, and is generous to Big Ben.
  assert.ok(game.mark('eifel tower', false).ok);
  assert.ok(game.mark('big ben', true).ok);
  assert.equal(game.mark('nobody said this', true).ok, false);
  game.advance();
  assert.equal(game.teamView(typo.id)!.result!.correct, false);
  assert.equal(game.teamView(sameTypo.id)!.result!.points, 0);
  assert.equal(game.teamView(wrong.id)!.result!.correct, true);
  assert.equal(game.teamView(wrong.id)!.result!.answerText, 'Eiffel Tower');
  assert.equal(game.teamView(wrong.id)!.myAnswerText, 'Big Ben');

  // Marks can still be fixed after the reveal, and scores follow.
  game.mark('eifel tower', true);
  assert.ok(game.teamView(typo.id)!.score > 0);
  game.dispose();
});

test('music: no speed bonus by default', () => {
  const { game, tick } = setup();
  const fast = join(game, 'Fast');
  const slow = join(game, 'Slow');
  game.advance();
  finishQuestion(game);
  game.advance();
  assert.equal(game.currentQuestion!.type, 'music');
  tick(1000);
  game.answer(fast.id, 'queen');
  tick(15_000);
  game.answer(slow.id, 'Queen');
  game.advance();
  assert.equal(game.teamView(fast.id)!.result!.points, 1000);
  assert.equal(game.teamView(slow.id)!.result!.points, 1000);
  game.dispose();
});

test('ordering: shuffled for display, points per item in place plus a speed bonus for the full order', () => {
  const { game, tick } = setup();
  const perfect = join(game, 'Perfect');
  const partial = join(game, 'Partial');
  const bad = join(game, 'Bad');
  for (let i = 0; i < 2; i++) {
    game.advance();
    finishQuestion(game);
  }
  game.advance();
  const view = game.teamView(perfect.id)!.question!;
  assert.equal(view.type, 'ordering');
  assert.notDeepEqual(view.items, ['1', '2', '3', '4', '5'], 'never shown already in order');
  assert.deepEqual([...view.items!].sort(), ['1', '2', '3', '4', '5']);

  // Teams answer with displayed positions; work out which positions give each order.
  const positionsFor = (order: string[]) => order.map((item) => view.items!.indexOf(item));

  assert.equal(game.answer(perfect.id, [0, 1, 2, 3]).ok, false, 'must place all 5');
  assert.equal(game.answer(perfect.id, [0, 0, 1, 2, 3]).ok, false, 'no repeats');
  assert.equal(game.answer(perfect.id, [0, 1, 2, 3, 9]).ok, false);
  game.answer(perfect.id, positionsFor(['1', '2', '3', '4', '5']));
  tick(10_000);
  game.answer(partial.id, positionsFor(['1', '2', '3', '5', '4']));
  game.answer(bad.id, positionsFor(['5', '4', '3', '2', '1']));
  assert.equal(game.hostView().summary, '1 of 3 teams got the order exactly right');
  game.advance();

  assert.deepEqual(game.teamView(perfect.id)!.result, {
    correct: true,
    points: 1000,
    answerText: '1 → 2 → 3 → 4 → 5',
    detail: '5 of 5 in the right place',
    correctIndex: undefined,
    info: undefined,
  });
  assert.equal(game.teamView(partial.id)!.result!.points, 300);
  assert.equal(game.teamView(bad.id)!.result!.points, 100);
  assert.equal(game.teamView(bad.id)!.myAnswerText, '5 → 4 → 3 → 2 → 1');
  game.dispose();
});

test('letter: one tap, case-insensitive, speed scored, letter tally for the host', () => {
  const { game, tick } = setup();
  const right = join(game, 'Right');
  const wrong = join(game, 'Wrong');
  const lower = join(game, 'Lower');
  for (let i = 0; i < 3; i++) {
    game.advance();
    finishQuestion(game);
  }
  game.advance();
  assert.equal(game.currentQuestion!.type, 'letter');
  assert.equal(game.answer(right.id, 'JL').ok, false);
  assert.equal(game.answer(right.id, '1').ok, false);
  game.answer(right.id, 'J');
  tick(10_000);
  game.answer(lower.id, 'j');
  game.answer(wrong.id, 'P');
  assert.equal(game.hostView().summary, 'J ×2   P ×1');
  game.advance();
  assert.equal(game.teamView(right.id)!.result!.points, 1000);
  assert.equal(game.teamView(lower.id)!.result!.points, 750);
  assert.equal(game.teamView(wrong.id)!.result!.correct, false);
  assert.equal(game.teamView(wrong.id)!.result!.answerText, 'J: John Lennon');
  game.dispose();
});
