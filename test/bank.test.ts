// M8e: the question bank: checking files, searching, random picks, the API, and that every bank question works in a quiz.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { bundledBankFiles } from '../server/assets.ts';
import { buildEntries, checkBank, filterEntries, questionIdentity, sample, summarise } from '../server/bank.ts';
import { Library } from '../server/library.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';

const FILE = `
category: Test
region: uk
questions:
  - { type: multiple-choice, text: "Which planet is closest to the Sun?", options: [Venus, Mercury, Mars], answer: 1, difficulty: easy, tags: [space] }
  - { type: number, text: "Year the Wall fell?", answer: 1989, difficulty: medium }
  - { type: nearest, text: "Height of Everest (m)?", answer: 8849, difficulty: hard, info: "Agreed in 2020." }
`;

test('checkBank reports every format problem with its question number', () => {
  assert.deepEqual(checkBank(FILE).problems, []);
  const bad = `category: X\nquestions:
  - { type: multiple-choice, text: "A?", options: [a, a], answer: 0, difficulty: easy }
  - { type: multiple-choice, text: "B?", options: [a, b], answer: 5, difficulty: easy }
  - { type: ordering, text: "C?", items: [a, b, c], difficulty: easy }
  - { type: picture, text: "E?", answer: x, difficulty: easy }
  - { type: number, text: "F?", answer: 1 }
`;
  const messages = checkBank(bad).problems.map((p) => `${p.question}: ${p.message}`).join('\n');
  assert.match(messages, /1: options: must all be different/);
  assert.match(messages, /2: answer: must be the position of an option/);
  assert.match(messages, /3: items: .*exactly 5 items/);
  assert.match(messages, /4: type:/);
  assert.match(messages, /5: difficulty:/);
  assert.match(checkBank('category: [x').problems[0]!.message, /Not valid YAML/);
});

test('checkBank also catches repeats, bad letter answers and "none of the above"', () => {
  const file = `category: X\nquestions:
  - { type: letter, text: "D?", answer: "1984", difficulty: easy }
  - { type: letter, text: "d?!", answer: "Abba", difficulty: easy }
  - { type: multiple-choice, text: "G?", options: [x, "None of the above"], answer: 0, difficulty: easy }
`;
  const messages = checkBank(file).problems.map((p) => `${p.question}: ${p.message}`).join('\n');
  assert.match(messages, /1: letter answers must start with a letter/);
  assert.match(messages, /2: repeats question 1/);
  assert.match(messages, /3: avoid "all\/none of the above"/);
});

test('searching and filtering', () => {
  const { entries } = buildEntries(new Map([['test.yaml', FILE]]), 'built-in');
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0]!.question.options, ['Venus', 'Mercury', 'Mars']);
  assert.equal('difficulty' in entries[0]!.question, false, 'bank-only fields are not copied into a quiz');
  assert.equal('tags' in entries[0]!.question, false);
  assert.equal(entries[2]!.question.info, 'Agreed in 2020.');
  const texts = (f: Parameters<typeof filterEntries>[1]) => filterEntries(entries, f).map((e) => e.text);
  assert.deepEqual(texts({ difficulty: 'hard' }), ['Height of Everest (m)?']);
  assert.deepEqual(texts({ type: 'number' }), ['Year the Wall fell?']);
  assert.deepEqual(texts({ search: 'SUN' }).length, 1);
  assert.deepEqual(texts({ search: 'space' }).length, 1, 'tags are searched too');
  assert.deepEqual(texts({ search: 'everest', category: 'Nope' }), []);
  assert.deepEqual(texts({ region: 'us' }), [], 'a UK-only file is not offered for US');
  assert.equal(summarise(entries).types['number'], 1);
});

test('a broken file is skipped, not fatal, and sampling never repeats', () => {
  const { entries, skipped } = buildEntries(new Map([['good.yaml', FILE], ['bad.yaml', 'category: [x']]), 'built-in');
  assert.equal(entries.length, 3);
  assert.deepEqual(skipped, ['bad.yaml']);
  const picked = sample([1, 2, 3, 4, 5], 3);
  assert.equal(new Set(picked).size, 3);
  assert.deepEqual(sample([1, 2], 5).sort(), [1, 2]);
  let n = 0;
  assert.deepEqual(sample([1, 2, 3], 3, () => (n++ === 0 ? 0 : 0.99)), [1, 3, 2]);
});

test('every question in the built-in bank is a valid quiz question once copied into a quiz', async () => {
  const { entries, skipped } = buildEntries(await bundledBankFiles(), 'built-in');
  assert.deepEqual(skipped, [], 'every bank file loads');
  assert.ok(entries.length > 500, `the bank has ${entries.length} questions`);
  // One round per category, as the editor would build it.
  const rounds = [...new Set(entries.map((e) => e.category))].map((category) => ({
    name: category,
    questions: entries.filter((e) => e.category === category).map((e) => e.question),
  }));
  const quiz = parseQuiz(stringify({ title: 'Everything', rounds }));
  assert.equal(quiz.questions.length, entries.length);
  const seen = new Set<string>();
  for (const e of entries) {
    const key = questionIdentity(e.question as never);
    assert.ok(!seen.has(key), `no question appears twice: ${e.text}`);
    seen.add(key);
  }
});

test('the bank API: summary, filters, paging, random picks, your own bank folder, host key required', async () => {
  const library = new Library(await mkdtemp(join(tmpdir(), 'pubquiz-bank-')));
  await mkdir(join(library.dir, 'bank'), { recursive: true });
  await writeFile(join(library.dir, 'bank', 'pub-regulars.yaml'), FILE.replace('Test', 'Pub Regulars'));
  const server = await createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, allowEmptyStart: true, library, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/bank${path}`, { headers: { 'x-host-key': server.hostKey } });
    assert.equal(res.status, 200);
    return (await res.json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/bank/summary`)).status, 401);

  const summary = await get('/summary');
  assert.ok(summary.total > 500);
  assert.ok(summary.categories.some((c: { category: string; source: string }) => c.category === 'Pub Regulars' && c.source === 'mine'));
  assert.ok(summary.types['nearest'] > 0 && summary.difficulties['hard'] > 0);

  const mine = await get('?source=mine');
  assert.equal(mine.total, 3);
  assert.equal(mine.questions[0].source, 'mine');
  assert.match(mine.questions[0].id, /^mine:pub-regulars\.yaml#0$/);

  const page1 = await get('?type=number&limit=5');
  const page2 = await get('?type=number&limit=5&offset=5');
  assert.equal(page1.questions.length, 5);
  assert.ok(page1.total > 10);
  assert.notDeepEqual(page1.questions.map((e: { id: string }) => e.id), page2.questions.map((e: { id: string }) => e.id));
  assert.ok(page1.questions.every((e: { type: string }) => e.type === 'number'));

  const random = await get('/random?difficulty=easy&type=multiple-choice&limit=7');
  assert.equal(random.questions.length, 7);
  assert.equal(new Set(random.questions.map((e: { id: string }) => e.id)).size, 7);
  assert.ok(random.questions.every((e: { difficulty: string }) => e.difficulty === 'easy'));

  assert.equal((await get('?search=zzzz-no-such-thing')).total, 0);
  assert.ok((await get('?limit=100000')).questions.length <= 200, 'pages are capped');
  await server.close();
});
