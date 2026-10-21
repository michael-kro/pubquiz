// Practice mode: one learner, their own key, sessions saved in the library.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Library } from '../server/library.ts';
import { cleanLearnerName, learnerId, startSession } from '../server/practice.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer, type QuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const QUIZ = `
title: Practice Test
rounds:
  - name: Facts
    questions:
      - { type: multiple-choice, text: Capital of France?, options: [Paris, Rome, Oslo], answer: 0, info: Paris has been the capital since 987. }
      - { type: number, text: Legs on a spider?, answer: 8 }
      - { type: letter, text: Largest planet?, answer: Jupiter }
      - { type: picture, text: Which country's flag?, image: images/flag-japan.svg, accept: [Japan, Nippon] }
  - name: Harder
    questions:
      - { type: ordering, text: Smallest first, items: [One, Two, Three, Four, Five] }
      - { type: buzzer, text: The answer to everything?, answer: Forty-two, info: Douglas Adams. }
      - { type: nearest, text: Height of Everest in metres?, answer: 8849 }
      - { type: music, text: Name the band, accept: [Queen] }
`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'pubquiz-practice-'));
  await mkdir(join(dir, 'facts', 'images'), { recursive: true });
  await writeFile(join(dir, 'facts', 'quiz.yaml'), QUIZ);
  await cp(join(import.meta.dirname, '..', 'examples', 'images', 'flag-japan.svg'), join(dir, 'facts', 'images', 'flag-japan.svg'));
  const server = await open(dir);
  return { dir, server };
}

const open = (dir: string): Promise<QuizServer> =>
  createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, allowEmptyStart: true, library: new Library(dir), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });

type Json = any;
async function call(server: QuizServer, method: string, path: string, body?: unknown, key: string | undefined = server.practiceKey, header = 'x-practice-key'): Promise<{ status: number; json: Json; res: Response }> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { ...(key ? { [header]: key } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text, res };
}

test('the practice key (or the host key) opens the practice API; the page, link and QR code are where the host expects', async () => {
  const { server } = await setup();
  const base = `http://127.0.0.1:${server.port}`;
  assert.equal((await call(server, 'GET', '/api/practice/quizzes')).status, 200);
  assert.equal((await call(server, 'GET', '/api/practice/quizzes', undefined, server.hostKey, 'x-host-key')).status, 200, 'the host may look too');
  assert.equal((await call(server, 'GET', '/api/practice/quizzes', undefined, '')).status, 401);
  assert.equal((await call(server, 'GET', '/api/practice/quizzes', undefined, server.screenKey)).status, 401, 'the TV key is not the practice key');
  assert.equal((await call(server, 'GET', '/api/practice/quizzes', undefined, server.hostKey)).status, 401, 'the host key in the wrong header is not accepted');
  assert.equal((await call(server, 'GET', `/api/practice/quizzes?key=${server.practiceKey}`, undefined, '')).status, 401, 'never in the address');

  const page = await fetch(`${base}/practice`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /practice\.js/);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);

  const link = await call(server, 'GET', '/api/practice/link', undefined, server.hostKey, 'x-host-key');
  assert.equal(link.json.url, `http://127.0.0.1:${server.port}/practice#key=${server.practiceKey}`);
  assert.equal((await call(server, 'GET', '/api/practice/link')).status, 401, 'only the host gets the link');
  const qr = await fetch(`${base}/practice-qr.svg`, { headers: { 'x-host-key': server.hostKey } });
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
  assert.equal((await fetch(`${base}/practice-qr.svg`)).status, 401);

  const quizzes = (await call(server, 'GET', '/api/practice/quizzes')).json;
  assert.deepEqual(quizzes, [{ id: 'facts', title: 'Practice Test', rounds: 2, questions: 8 }]);
  await server.close();
});

test('learn mode: every question type, the answer and explanation straight after each, then the results', async () => {
  const { server } = await setup();
  const start = await call(server, 'POST', '/api/practice/learners/Ada/sessions', { quizId: 'facts', mode: 'learn' });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  let view = start.json.current;
  assert.equal(view.total, 8);
  assert.equal(view.position, 0);
  assert.equal(view.question.type, 'multiple-choice');
  assert.deepEqual(view.question.options, ['Paris', 'Rome', 'Oslo']);
  assert.equal(view.question.feedback, undefined, 'no answer given away yet');

  const act = async (action: string, body?: unknown) => {
    const r = await call(server, 'POST', `/api/practice/learners/Ada/current/${action}`, body ?? {});
    assert.equal(r.status, 200, `${action}: ${JSON.stringify(r.json)}`);
    return r.json;
  };
  // Multiple choice, wrong: the feedback says so, with the right answer and the explanation.
  view = (await act('answer', { value: 1 })).current;
  assert.equal(view.position, 0, 'learn mode waits for Next');
  assert.deepEqual(view.question.given, { value: 1, label: 'Rome' });
  assert.deepEqual(view.question.feedback, { correct: false, answer: 'Paris', info: 'Paris has been the capital since 987.' });
  assert.equal((await call(server, 'POST', '/api/practice/learners/Ada/current/answer', { value: 0 })).status, 400, 'no second go in learn mode');
  view = (await act('next')).current;
  assert.equal(view.question.type, 'number');
  view = (await act('answer', { value: 8 })).current;
  assert.equal(view.question.feedback.correct, true);
  view = (await act('next')).current;
  assert.equal(view.question.type, 'letter');
  assert.equal(view.question.keypad, 'grouped');
  view = (await act('answer', { value: 'j' })).current;
  assert.deepEqual(view.question.feedback, { correct: true, answer: 'J: Jupiter' });
  view = (await act('next')).current;
  assert.equal(view.question.type, 'picture');
  assert.match(view.question.imageUrl, /^\/api\/practice\/quizzes\/facts\/media\//);
  // The picture comes through the practice API, with the key only.
  const image = await fetch(`http://127.0.0.1:${server.port}${view.question.imageUrl}`, { headers: { 'x-practice-key': server.practiceKey } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/svg+xml');
  assert.match(image.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}${view.question.imageUrl}`)).status, 401);
  view = (await act('answer', { value: 'nipon' })).current;
  assert.equal(view.question.feedback.correct, true, 'a typo is forgiven, as in the live game');
  view = (await act('next')).current;
  assert.equal(view.question.type, 'ordering');
  assert.equal(view.question.items.length, 5);
  assert.notDeepEqual(view.question.items, ['One', 'Two', 'Three', 'Four', 'Five'], 'shown shuffled');
  const positions = ['One', 'Two', 'Three', 'Four', 'Five'].map((t) => view.question.items.indexOf(t));
  view = (await act('answer', { value: positions })).current;
  assert.deepEqual(view.question.feedback, { correct: true, answer: 'One → Two → Three → Four → Five', detail: '5 of 5 in the right place' });
  assert.equal(view.question.given.label, 'One → Two → Three → Four → Five');
  view = (await act('next')).current;
  assert.equal(view.question.type, 'buzzer');
  const reveal = await act('reveal');
  assert.deepEqual(reveal, { answer: 'Forty-two', info: 'Douglas Adams.' });
  assert.equal((await call(server, 'POST', '/api/practice/learners/Ada/current/answer', { value: 'maybe' })).status, 400);
  view = (await act('answer', { value: 'right' })).current;
  assert.equal(view.question.feedback.correct, true);
  assert.equal(view.question.given.label, 'I got it');
  view = (await act('next')).current;
  assert.equal(view.question.type, 'nearest');
  view = (await act('answer', { value: 8800 })).current;
  assert.deepEqual(view.question.feedback, { correct: false, answer: '8849', detail: 'Off by 49' });
  view = (await act('next')).current;
  assert.equal(view.question.type, 'music');
  view = (await act('answer', { value: 'Queen' })).current;
  assert.equal(view.answered, 8);
  assert.equal((await call(server, 'POST', '/api/practice/learners/Ada/current/next', {})).status, 400, 'that was the last one');

  const results = (await act('finish')) as Json;
  assert.equal(results.right, 6);
  assert.equal(results.total, 8);
  assert.equal(results.percent, 75);
  assert.deepEqual(results.byRound, [{ round: 'Facts', right: 3, total: 4 }, { round: 'Harder', right: 3, total: 4 }]);
  assert.deepEqual(results.missed, [0, 6]);
  assert.equal(results.review.length, 8);
  assert.deepEqual(results.review[0], { index: 0, round: 'Facts', text: 'Capital of France?', type: 'multiple-choice', given: 'Rome', answer: 'Paris', info: 'Paris has been the capital since 987.', correct: false, skipped: false, flagged: false });
  assert.ok(results.elapsedMs >= 0);

  const overview = (await call(server, 'GET', '/api/practice/learners/Ada')).json;
  assert.equal(overview.current, null);
  assert.equal(overview.history.length, 1);
  assert.equal(overview.history[0].right, 6);
  const again = await call(server, 'GET', `/api/practice/learners/Ada/sessions/${results.id}/results`);
  assert.equal(again.json.percent, 75, 'results can be looked at later');

  // Retry only the ones missed.
  const retry = (await call(server, 'POST', '/api/practice/learners/Ada/sessions', { quizId: 'facts', mode: 'learn', only: results.missed })).json.current;
  assert.equal(retry.total, 2);
  assert.equal(retry.question.type, 'multiple-choice');
  await server.close();
});

test('test mode: no feedback until the end, straight on to the next question; back, skip and flag', async () => {
  const { server } = await setup();
  const act = async (action: string, body?: unknown) => (await call(server, 'POST', `/api/practice/learners/Bo/current/${action}`, body ?? {})).json;
  let view = (await call(server, 'POST', '/api/practice/learners/Bo/sessions', { quizId: 'facts', mode: 'test', count: 3 })).json.current;
  assert.equal(view.total, 3);
  view = (await act('answer', { value: 1 })).current;
  assert.equal(view.position, 1, 'moved on by itself');
  view = (await act('back')).current;
  assert.equal(view.position, 0);
  assert.deepEqual(view.question.given, { value: 1, label: 'Rome' });
  assert.equal(view.question.feedback, undefined, 'nothing is marked until the end');
  view = (await act('answer', { value: 0 })).current;
  assert.equal(view.position, 1, 'a test answer can be changed');
  view = (await act('flag')).current;
  assert.equal(view.question.flagged, true);
  view = (await act('skip')).current;
  assert.equal(view.position, 2);
  view = (await act('back')).current;
  assert.equal(view.question.skipped, true);
  view = (await act('next')).current;
  view = (await act('answer', { value: 'J' })).current;
  assert.equal(view.position, 2, 'the last question stays put');
  assert.equal(view.answered, 2);
  const results = await act('finish');
  assert.equal(results.right, 2);
  assert.deepEqual(results.missed, [1]);
  assert.equal(results.review[1].skipped, true);
  assert.equal(results.review[1].flagged, true);
  assert.equal(results.review[1].given, undefined);
  await server.close();
});

test('a session survives a restart and is picked up where it was; a changed quiz ends it', async () => {
  const { dir, server } = await setup();
  await call(server, 'POST', '/api/practice/learners/Cy/sessions', { quizId: 'facts', mode: 'learn' });
  await call(server, 'POST', '/api/practice/learners/Cy/current/answer', { value: 0 });
  await call(server, 'POST', '/api/practice/learners/Cy/current/next', {});
  await server.close();
  assert.deepEqual(await readdir(join(dir, 'practice')), ['cy.json'], 'one file per learner, in the library');

  const again = await open(dir);
  const overview = (await call(again, 'GET', '/api/practice/learners/Cy')).json;
  assert.equal(overview.current.position, 1);
  assert.equal(overview.current.answered, 1);
  assert.deepEqual((await call(again, 'GET', '/api/practice/learners')).json.map((l: { name: string }) => l.name), ['Cy']);

  await writeFile(join(dir, 'facts', 'quiz.yaml'), QUIZ.replace('Legs on a spider?', 'Legs on an ant?'));
  const after = (await call(again, 'GET', '/api/practice/learners/Cy')).json;
  assert.equal(after.current, null, 'the quiz changed under it');
  assert.equal(after.history.length, 1, 'what was done is kept');
  assert.equal(after.history[0].right, 1);
  await again.close();
});

test('learner names are cleaned, kept apart and checked', async () => {
  assert.equal(learnerId('  Zoë  O’Brien '), 'zoe-o-brien');
  assert.equal(cleanLearnerName('  Zoë   O’Brien '), 'Zoë O’Brien');
  assert.throws(() => cleanLearnerName(''), /Type a name/);
  assert.throws(() => cleanLearnerName('!!!'), /Type a name/);
  assert.throws(() => cleanLearnerName(42), /Type a name/);
  const { server } = await setup();
  assert.equal((await call(server, 'GET', '/api/practice/learners/%20%20')).status, 400);
  assert.equal((await call(server, 'POST', '/api/practice/learners/Dee/sessions', { quizId: '../facts', mode: 'learn' })).status, 404);
  assert.equal((await call(server, 'POST', '/api/practice/learners/Dee/sessions', { quizId: 'nope', mode: 'learn' })).status, 404);
  assert.equal((await call(server, 'POST', '/api/practice/learners/Dee/current/answer', { value: 0 })).status, 404, 'nothing in progress');
  await server.close();
});

test('the practice key changes with the host key', async () => {
  const { server } = await setup();
  const before = server.practiceKey;
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  host.send({ t: 'rotate-key' });
  await host.waitFor((m) => m.t === 'host-key');
  assert.notEqual(server.practiceKey, before);
  assert.equal((await call(server, 'GET', '/api/practice/quizzes', undefined, before)).status, 401);
  assert.equal((await call(server, 'GET', '/api/practice/quizzes')).status, 200);
  await host.close();
  await server.close();
});

test('startSession: how many, shuffled, only some', () => {
  const quiz = parseQuiz(QUIZ.replace('image: images/flag-japan.svg', 'image: https://example.com/flag.svg'));
  assert.deepEqual(startSession(quiz, 'q', 'h', { mode: 'learn' }).order, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(startSession(quiz, 'q', 'h', { mode: 'learn', count: 3 }).order.length, 3);
  assert.deepEqual(startSession(quiz, 'q', 'h', { mode: 'learn', only: [6, 2] }).order, [2, 6]);
  const orders = new Set(Array.from({ length: 12 }, () => startSession(quiz, 'q', 'h', { mode: 'test', shuffle: true }).order.join(',')));
  assert.ok(orders.size > 1, 'shuffling shuffles');
  const session = startSession(quiz, 'q', 'h', { mode: 'test' });
  assert.deepEqual(Object.keys(session.displays), ['4'], 'only the ordering question has a display order');
  assert.notDeepEqual(session.displays['4'], [0, 1, 2, 3, 4]);
  assert.throws(() => startSession(quiz, 'q', 'h', { mode: 'learn', only: [99] }), /no questions/);
});

test('a learner file is written whole, never half', async () => {
  const { dir, server } = await setup();
  await Promise.all(Array.from({ length: 5 }, (_, i) => call(server, 'POST', `/api/practice/learners/Eve/sessions`, { quizId: 'facts', mode: 'learn', count: i + 1 })));
  const saved = JSON.parse(await readFile(join(dir, 'practice', 'eve.json'), 'utf8'));
  assert.equal(saved.name, 'Eve');
  assert.ok(saved.sessions.length >= 1);
  assert.equal(saved.sessions.filter((s: { finishedAt?: string }) => !s.finishedAt).length, 1, 'one session in progress at a time');
  await server.close();
});
