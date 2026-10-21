// Practice mode: one learner, their own key, sessions saved in the library.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Library } from '../server/library.ts';
import { cleanLearnerName, dueReview, learnerId, startSession, timeUp, updateReview } from '../server/practice.ts';
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

// Stage 2: review boxes, progress, exam simulation, export.

test('a wrong answer comes back for another look straight away; right answers push it further out until it graduates', async () => {
  const { server } = await setup();
  const act = async (action: string, body?: unknown) => (await call(server, 'POST', `/api/practice/learners/Fay/current/${action}`, body ?? {})).json;
  await call(server, 'POST', '/api/practice/learners/Fay/sessions', { quizId: 'facts', mode: 'test', count: 3 });
  await act('answer', { value: 1 }); // wrong
  await act('answer', { value: 8 }); // right
  await act('skip'); // skipped counts as missed
  const r = await act('finish');
  assert.deepEqual(r.missed, [0, 2]);

  const overview = (await call(server, 'GET', '/api/practice/learners/Fay')).json;
  assert.deepEqual(overview.due, [{ quizId: 'facts', quizTitle: 'Practice Test', indices: [0, 2] }], 'both are due now');
  assert.deepEqual(overview.history[0].right, 1);
  const progress = (await call(server, 'GET', '/api/practice/learners/Fay/progress')).json;
  assert.equal(progress.reviewing, 2);
  assert.equal(progress.attempts.length, 1);
  assert.deepEqual(progress.topics, [{ round: 'Facts', right: 1, total: 3, percent: 33 }]);
  assert.equal(progress.hardest[0].misses, 1);

  // A review session is just those questions, in learn mode.
  const review = (await call(server, 'POST', '/api/practice/learners/Fay/sessions', { quizId: 'facts', mode: 'learn', review: true })).json.current;
  assert.equal(review.kind, 'review');
  assert.equal(review.total, 2);
  assert.equal(review.question.index, 0);
  await act('answer', { value: 0 }); // right this time
  await act('next');
  await act('answer', { value: 'X' }); // wrong again
  await act('finish');
  const after = (await call(server, 'GET', '/api/practice/learners/Fay/progress')).json;
  assert.deepEqual(after.due.map((g: { indices: number[] }) => g.indices), [[2]], 'the one got right is not due for a day; the other is back');
  assert.equal(after.reviewing, 2);
  assert.equal(after.hardest[0].misses, 2);
  assert.equal((await call(server, 'POST', '/api/practice/learners/Fay/sessions', { quizId: 'facts', mode: 'learn', review: true })).json.current.total, 1);
  await server.close();

  // Time travel through the boxes with the engine itself.
  const quiz = parseQuiz(QUIZ.replace('image: images/flag-japan.svg', 'image: https://example.com/flag.svg'));
  const learner = { name: 'T', sessions: [], review: {} as Record<string, import('../server/practice.ts').ReviewItem> };
  const day = 24 * 3_600_000;
  let now = Date.parse('2026-10-21T10:00:00Z');
  const attempt = (correct: boolean) => {
    const s = startSession(quiz, 'facts', 'h', { mode: 'learn', only: [1] });
    s.answers['1'] = { value: correct ? 8 : 7, correct, at: new Date(now).toISOString() };
    updateReview(learner, s, quiz, now);
  };
  attempt(false);
  assert.equal(learner.review['facts:1']!.box, 0);
  assert.equal(dueReview(learner, now).length, 1, 'due at once');
  const expectedDays = [1, 3, 7, 14];
  for (const days of expectedDays) {
    attempt(true);
    assert.equal(dueReview(learner, now).length, 0, 'not due yet');
    assert.equal(dueReview(learner, now + days * day - 1).length, 0);
    assert.equal(dueReview(learner, now + days * day).length, 1, `due after ${days} day(s)`);
    now += days * day;
  }
  attempt(true);
  assert.deepEqual(learner.review, {}, 'five rights in a row: graduated');
  attempt(true);
  assert.deepEqual(learner.review, {}, 'a right answer to something never missed is not tracked');
});

test('exam simulation: a time limit, and the paper is taken in when it runs out', async () => {
  const { dir, server } = await setup();
  assert.equal((await call(server, 'POST', '/api/practice/learners/Gus/sessions', { quizId: 'facts', mode: 'test', timeLimitMinutes: 999 })).status, 400);
  const start = (await call(server, 'POST', '/api/practice/learners/Gus/sessions', { quizId: 'facts', mode: 'learn', timeLimitMinutes: 2 })).json.current;
  assert.equal(start.mode, 'test', 'an exam is always marked at the end');
  assert.equal(start.kind, 'exam');
  const left = Date.parse(start.deadline) - Date.now();
  assert.ok(left > 110_000 && left <= 120_000, `about two minutes: ${left}`);
  await call(server, 'POST', '/api/practice/learners/Gus/current/answer', { value: 0 });

  // The clock runs out (the file is the truth, so wind it back there).
  const path = join(dir, 'practice', 'gus.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.sessions[0].deadline = new Date(Date.now() - 1000).toISOString();
  await writeFile(path, JSON.stringify(saved));
  const late = (await call(server, 'POST', '/api/practice/learners/Gus/current/answer', { value: 8 })).json;
  assert.equal(late.timeUp, true);
  assert.equal(late.results.timedOut, true);
  assert.equal(late.results.right, 1, 'the late answer did not count');
  assert.equal(late.results.kind, 'exam');
  assert.equal((await call(server, 'GET', '/api/practice/learners/Gus')).json.current, null);
  assert.equal(timeUp({ deadline: new Date(Date.now() + 1000).toISOString() } as never), false);
  await server.close();
});

test('CSV exports for an attempt and for a learner, and the host can read progress for a parent or teacher', async () => {
  const { server } = await setup();
  await call(server, 'POST', '/api/practice/learners/Ida/sessions', { quizId: 'facts', mode: 'test', count: 2 });
  await call(server, 'POST', '/api/practice/learners/Ida/current/answer', { value: 0 });
  await call(server, 'POST', '/api/practice/learners/Ida/current/answer', { value: 'eight, "roughly"' });
  const r = (await call(server, 'POST', '/api/practice/learners/Ida/current/finish', {})).json;
  const attempt = await call(server, 'GET', `/api/practice/learners/Ida/sessions/${r.id}/export.csv`);
  assert.equal(attempt.status, 200);
  assert.match(attempt.res.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(attempt.res.headers.get('content-disposition') ?? '', /attachment; filename="Ida - Practice Test.csv"/);
  const lines = (attempt.json as string).replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'Learner,Quiz,Finished,Round,Question,Your answer,Answer,Right,Skipped,Flagged,Info');
  assert.match(lines[1]!, /^Ida,Practice Test,.*,Facts,Capital of France\?,Paris,Paris,yes,,,Paris has been the capital since 987\.$/);
  assert.match(lines[2]!, /"Type a number\."|,no,/, 'the typed text was not a number, so it was refused and the question is unanswered');
  const all = await call(server, 'GET', '/api/practice/learners/Ida/export.csv');
  assert.match(all.res.headers.get('content-disposition') ?? '', /filename="Ida practice.csv"/);
  const rows = (all.json as string).replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(rows[0], 'Learner,Finished,Quiz,Mode,Kind,Right,Total,Percent,Minutes');
  assert.match(rows[1]!, /^Ida,.*,Practice Test,test,,1,2,50,/);

  const asHost = await call(server, 'GET', '/api/practice/learners/Ida/progress', undefined, server.hostKey, 'x-host-key');
  assert.equal(asHost.status, 200);
  assert.equal(asHost.json.name, 'Ida');
  assert.equal(asHost.json.percent, 50);
  assert.equal((await call(server, 'GET', '/api/practice/learners/Ida/progress', undefined, '')).status, 401);
  await server.close();
});

// Stage 3: hints, explanations and topics.

test('hints come one at a time and are counted; explain beats info; progress is by topic when a question has one', async () => {
  const { dir, server } = await setup();
  await mkdir(join(dir, 'revise'), { recursive: true });
  await writeFile(
    join(dir, 'revise', 'quiz.yaml'),
    `title: Revision
rounds:
  - name: Maths
    questions:
      - { type: multiple-choice, text: "3/4 of 20?", options: ["12", "15", "16"], answer: 1, topic: Fractions, hint: ["Find a quarter first.", "A quarter of 20 is 5."], explain: "A quarter of 20 is 5; three of those is 15.", info: "Fun fact." }
      - { type: true-false, text: "7 is prime.", answer: true, topic: Primes }
      - { type: number, text: "9 x 9?", answer: 81 }
`,
  );
  const act = async (action: string, body?: unknown) => (await call(server, 'POST', `/api/practice/learners/Kit/current/${action}`, body ?? {})).json;
  let view = (await call(server, 'POST', '/api/practice/learners/Kit/sessions', { quizId: 'revise', mode: 'learn' })).json.current;
  assert.equal(view.question.hints, 2);
  assert.deepEqual(view.question.hintsShown, []);
  view = (await act('hint')).current;
  assert.deepEqual(view.question.hintsShown, ['Find a quarter first.']);
  view = (await act('hint')).current;
  assert.deepEqual(view.question.hintsShown, ['Find a quarter first.', 'A quarter of 20 is 5.']);
  assert.equal((await call(server, 'POST', '/api/practice/learners/Kit/current/hint', {})).status, 400, 'no more hints');
  view = (await act('answer', { value: 1 })).current;
  assert.equal(view.question.feedback.info, 'A quarter of 20 is 5; three of those is 15.', 'explain, not the fun fact');
  view = (await act('next')).current;
  assert.deepEqual(view.question.options, ['True', 'False'], 'true/false is played as multiple choice');
  assert.equal(view.question.hints, 0);
  assert.equal((await call(server, 'POST', '/api/practice/learners/Kit/current/hint', {})).status, 400, 'no hint on this one');
  view = (await act('answer', { value: 1 })).current; // false: wrong
  await act('next');
  await act('answer', { value: 81 });
  const r = await act('finish');
  assert.deepEqual(r.byRound, [{ round: 'Fractions', right: 1, total: 1 }, { round: 'Primes', right: 0, total: 1 }, { round: 'Maths', right: 1, total: 1 }], 'topics where given, the round otherwise');
  assert.equal(r.review[0].hintsUsed, 2);
  assert.equal(r.review[1].hintsUsed, undefined);
  const progress = (await call(server, 'GET', '/api/practice/learners/Kit/progress')).json;
  assert.equal(progress.topics[0].round, 'Primes');
  assert.equal(progress.hardest[0].round, 'Primes');
  await server.close();
});
