// The host can put the join QR code up on the screens after the quiz has started.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';

const QUIZ = `
title: Join
rounds:
  - name: R
    questions:
      - { type: multiple-choice, text: Q1, options: [a, b], answer: 0 }
`;

test('the join QR code is off until the host asks for it, and can be taken down again', () => {
  const game = new Game(parseQuiz(QUIZ));
  assert.equal(game.hostView().showJoin, false);
  game.setShowJoin(true);
  assert.equal(game.hostView().showJoin, true);
  game.setShowJoin(false);
  assert.equal(game.hostView().showJoin, false);
});
