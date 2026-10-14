import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseQuiz, QuizError } from '../server/quiz.ts';

const VALID = `
title: Test
rounds:
  - name: One
    questions:
      - type: multiple-choice
        text: Q1
        options: [a, b, c]
        answer: 2
  - name: Two
    questions:
      - type: multiple-choice
        text: Q2
        options: [x, y]
        answer: 0
        seconds: 10
        points: 500
`;

function issuesOf(yaml: string): string[] {
  try {
    parseQuiz(yaml);
  } catch (error) {
    assert.ok(error instanceof QuizError);
    return error.issues;
  }
  assert.fail('expected the quiz to be rejected');
}

test('parses a valid quiz, flattening rounds and applying defaults', () => {
  const quiz = parseQuiz(VALID);
  assert.equal(quiz.title, 'Test');
  assert.equal(quiz.speedFactor, 0.5);
  assert.equal(quiz.questions.length, 2);
  assert.deepEqual(
    quiz.questions.map((q) => [q.round, q.seconds, q.points]),
    [
      ['One', 20, 1000],
      ['Two', 10, 500],
    ],
  );
});

test('the bundled sample quiz is valid', async () => {
  const quiz = parseQuiz(await readFile(new URL('../examples/sample-quiz.yaml', import.meta.url), 'utf8'));
  assert.equal(quiz.questions.length, 10);
});

test('reports an answer outside the options with its location', () => {
  const issues = issuesOf(VALID.replace('answer: 2', 'answer: 3'));
  assert.deepEqual(issues, ['Round 1, question 1, answer: must be the position of one of the options, counting from 0']);
});

test('rejects too many options, unknown fields and bad YAML', () => {
  assert.match(issuesOf(VALID.replace('[a, b, c]', '[a, b, c, d, e]'))[0]!, /^Round 1, question 1, options:/);
  assert.match(issuesOf(VALID.replace('seconds: 10', 'secs: 10'))[0]!, /^Round 2, question 1: .*secs/);
  assert.match(issuesOf('title: [unclosed')[0]!, /^Not valid YAML/);
  assert.match(issuesOf('title: Empty\nrounds: []')[0]!, /^rounds:/);
});
