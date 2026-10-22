// The marking shared by the live game and practice mode: what counts as an answer, and whether it is right.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerText, isRight, itemsInPlace, validateAnswer } from '../server/marking.ts';
import { parseQuiz, type Question } from '../server/quiz.ts';

const quiz = parseQuiz(`
title: Marking
rounds:
  - name: R
    questions:
      - { type: multiple-choice, text: MC, options: [Paris, Rome, Oslo], answer: 0 }
      - { type: picture, text: Pic, image: https://example.com/x.png, accept: [Japan, Nippon] }
      - { type: number, text: Num, answer: 8, tolerance: 1 }
      - { type: letter, text: Let, answer: The Beatles }
      - { type: ordering, text: Ord, items: [One, Two, Three, Four, Five] }
      - { type: nearest, text: Near, answer: 100 }
      - { type: buzzer, text: Buzz, answer: Forty-two }
`);
const q = (type: Question['type']) => quiz.questions.find((x) => x.type === type)!;

test('validateAnswer accepts the right shapes and cleans them up', () => {
  assert.deepEqual(validateAnswer(q('multiple-choice'), 2), { ok: true, value: 2 });
  assert.equal(validateAnswer(q('multiple-choice'), 3).ok, false);
  assert.equal(validateAnswer(q('multiple-choice'), '0').ok, false);
  assert.deepEqual(validateAnswer(q('picture'), '  Nippon   please '), { ok: true, value: 'Nippon please' });
  assert.equal(validateAnswer(q('picture'), '   ').ok, false);
  assert.equal(validateAnswer(q('picture'), 'x'.repeat(101)).ok, false);
  assert.deepEqual(validateAnswer(q('letter'), 'b'), { ok: true, value: 'B' });
  assert.deepEqual(validateAnswer(q('letter'), 'QV'), { ok: true, value: 'QV' });
  assert.equal(validateAnswer(q('letter'), '7').ok, false);
  assert.deepEqual(validateAnswer(q('number'), 7.5), { ok: true, value: 7.5 });
  assert.equal(validateAnswer(q('number'), Infinity).ok, false);
  assert.equal(validateAnswer(q('number'), '8').ok, false);
  assert.equal(validateAnswer(q('buzzer'), 'right').ok, false, 'buzzers are judged, not answered');
  // Ordering: positions in the shuffled list the player saw come back as item indices in the player's order.
  assert.deepEqual(validateAnswer(q('ordering'), [0, 1, 2, 3, 4], [4, 3, 2, 1, 0]), { ok: true, value: [4, 3, 2, 1, 0] });
  assert.deepEqual(validateAnswer(q('ordering'), [4, 3, 2, 1, 0], [4, 3, 2, 1, 0]), { ok: true, value: [0, 1, 2, 3, 4] });
  assert.equal(validateAnswer(q('ordering'), [0, 0, 1, 2, 3]).ok, false, 'no repeats');
  assert.equal(validateAnswer(q('ordering'), [0, 1, 2, 3]).ok, false, 'all five');
});

test('isRight: each type against its own answer, typos allowed on typed answers, overrides win', () => {
  assert.equal(isRight(q('multiple-choice'), 0), true);
  assert.equal(isRight(q('multiple-choice'), 1), false);
  assert.equal(isRight(q('picture'), 'japan'), true);
  assert.equal(isRight(q('picture'), 'Japn'), true, 'one typo in a medium word');
  assert.equal(isRight(q('picture'), 'China'), false);
  assert.equal(isRight(q('picture'), 'China', true), true, 'the host said so');
  assert.equal(isRight(q('picture'), 'Japan', false), false, 'the host said not');
  assert.equal(isRight(q('number'), 9), true, 'within tolerance');
  assert.equal(isRight(q('number'), 9.5), false);
  assert.equal(isRight(q('letter'), 'B'), true, 'the Beatles: skip "the"');
  assert.equal(isRight(q('letter'), 'T'), false);
  assert.equal(isRight(q('ordering'), [0, 1, 2, 3, 4]), true);
  assert.equal(isRight(q('ordering'), [0, 1, 2, 4, 3]), false);
  assert.equal(itemsInPlace([0, 1, 2, 4, 3]), 3);
  assert.equal(isRight(q('nearest'), 100), true, 'alone, only spot on counts');
  assert.equal(isRight(q('nearest'), 99), false);
  assert.equal(isRight(q('buzzer'), 'right'), true);
  assert.equal(isRight(q('buzzer'), 'wrong'), false);
});

test('answerText shows the answer the way the reveal does', () => {
  assert.equal(answerText(q('multiple-choice')), 'Paris');
  assert.equal(answerText(q('picture')), 'Japan / Nippon');
  assert.equal(answerText(q('number')), '8 (give or take 1)');
  assert.equal(answerText(q('letter')), 'B: The Beatles');
  assert.equal(answerText(q('ordering')), 'One → Two → Three → Four → Five');
  assert.equal(answerText(q('nearest')), '100');
  assert.equal(answerText(q('buzzer')), 'Forty-two');
});
