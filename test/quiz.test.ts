import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hintsOf, loadQuizFile, parseQuiz, QuizError } from '../server/quiz.ts';

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
  assert.equal(quiz.questions.length, 22);
});

test('reports an answer outside the options with its location', () => {
  const issues = issuesOf(VALID.replace('answer: 2', 'answer: 3'));
  assert.deepEqual(issues, ['Round 1, question 1, answer: must be the position of one of the options, counting from 0']);
});

test('rejects too many options, unknown fields and bad YAML', () => {
  assert.match(issuesOf(VALID.replace('[a, b, c]', '[a, b, c, d, e, f, g]'))[0]!, /^Round 1, question 1, options:/);
  assert.match(issuesOf(VALID.replace('seconds: 10', 'secs: 10'))[0]!, /^Round 2, question 1: .*secs/);
  assert.match(issuesOf('title: [unclosed')[0]!, /^Not valid YAML/);
  assert.match(issuesOf('title: Empty\nrounds: []')[0]!, /^rounds:/);
});

const ONE = (question: string) => `title: T\nrounds:\n  - name: R\n    questions:\n      - ${question}\n`;

test('validates the other question types', () => {
  assert.match(issuesOf(ONE('{ type: ordering, text: Q, items: [a, b, c, d] }'))[0]!, /items: needs exactly 5 items/);
  assert.match(issuesOf(ONE('{ type: ordering, text: Q, items: [a, b, c, d, A] }'))[0]!, /items must all be different/);
  assert.match(issuesOf(ONE('{ type: picture, text: Q, accept: [x] }'))[0]!, /image/);
  assert.match(issuesOf(ONE('{ type: music, text: Q, accept: [] }'))[0]!, /accept/);
  assert.match(issuesOf(ONE('{ type: music, text: Q, accept: ["?!"] }'))[0]!, /letter or number/);
  assert.match(issuesOf(ONE('{ type: letter, text: Q, answer: "101 Dalmatians" }'))[0]!, /add letter:/);
  assert.match(issuesOf(ONE('{ type: letter, text: Q, answer: X, letter: XY }'))[0]!, /single letter/);
  assert.match(issuesOf(ONE('{ type: essay, text: Q }'))[0]!, /^Round 1, question 1/);
  const letter = parseQuiz(ONE('{ type: letter, text: Q, answer: "101 Dalmatians", letter: o }')).questions[0]!;
  assert.equal(letter.type === 'letter' && letter.letter, 'O');
});

test('loads images next to the quiz file and reports missing ones', async () => {
  const quiz = await loadQuizFile(fileURLToPath(new URL('fixtures/all-types.yaml', import.meta.url)));
  assert.equal(quiz.questions[1]!.imageUrl, '/media/q2.svg');
  assert.equal(quiz.media.get('q2.svg')!.contentType, 'image/svg+xml');

  const dir = await mkdtemp(join(tmpdir(), 'pubquiz-'));
  await writeFile(join(dir, 'quiz.yaml'), ONE('{ type: picture, text: Q, image: nope.png, accept: [x] }'));
  await writeFile(join(dir, 'notes.txt'), 'hi');
  await assert.rejects(loadQuizFile(join(dir, 'quiz.yaml')), (e: QuizError) => /can't find nope.png/.test(e.issues[0]!));
  await writeFile(join(dir, 'quiz.yaml'), ONE('{ type: picture, text: Q, image: notes.txt, accept: [x] }'));
  await assert.rejects(loadQuizFile(join(dir, 'quiz.yaml')), (e: QuizError) => /use a .jpg/.test(e.issues[0]!));
});

test('true/false questions are played as two-option multiple choice; practice fields are accepted and checked', () => {
  const quiz = parseQuiz(ONE('{ type: true-false, text: "The Sun is a star.", answer: true, topic: Space, explain: "It is a ball of hot gas that makes its own light.", hint: ["Think about what makes light.", "Planets only reflect light."] }'));
  const q = quiz.questions[0]!;
  assert.equal(q.type, 'multiple-choice');
  assert.deepEqual((q as { options: string[] }).options, ['True', 'False']);
  assert.equal((q as { answer: number }).answer, 0);
  assert.equal(q.topic, 'Space');
  assert.match(q.explain!, /hot gas/);
  assert.deepEqual(hintsOf(q), ['Think about what makes light.', 'Planets only reflect light.']);
  assert.equal((parseQuiz(ONE('{ type: true-false, text: Q, answer: false }')).questions[0] as { answer: number }).answer, 1);
  assert.deepEqual(hintsOf(parseQuiz(ONE('{ type: number, text: Q, answer: 1, hint: "Count them." }')).questions[0]!), ['Count them.']);
  assert.deepEqual(hintsOf(parseQuiz(ONE('{ type: number, text: Q, answer: 1 }')).questions[0]!), []);
  assert.match(issuesOf(ONE('{ type: true-false, text: Q, answer: yes please }'))[0]!, /answer: must be true or false/);
  assert.match(issuesOf(ONE('{ type: number, text: Q, answer: 1, hint: [a, b, c, d] }'))[0]!, /hint/);
  assert.match(issuesOf(ONE('{ type: number, text: Q, answer: 1, explain: "" }'))[0]!, /explain/);
});
