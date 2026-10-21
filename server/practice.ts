// Practice mode: one learner works through a quiz at their own pace, with no host, no teams and no clock that
// stops anything. The server owns the session (which question is next, what was answered, what was right) and
// saves it per learner in the library folder, so a session survives a closed tab or a restart. Nothing leaves the
// machine. Marking is the same code the live game uses (marking.ts); points, speed and wagers do not exist here.
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { answerText, isRight, itemsInPlace, validateAnswer } from './marking.ts';
import type { AnswerValue } from './protocol.ts';
import { ORDERING_ITEMS, type Question, type Quiz } from './quiz.ts';

export class PracticeError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type PracticeMode = 'learn' | 'test';

export interface PracticeOptions {
  /** Learn: the answer and explanation straight after each question. Test: marked at the end. */
  mode: PracticeMode;
  /** How many questions (left out: all of them). */
  count?: number;
  shuffle?: boolean;
  /** Only these questions (by index in the quiz), for "retry the ones I missed" and review sessions. */
  only?: number[];
  /** Exam simulation: the whole paper has this long, then it is marked whatever state it is in. */
  timeLimitMinutes?: number;
  /** What kind of session this is, for the history. */
  kind?: 'review' | 'exam';
}

/** What a finished attempt came to, kept with it so progress needs no quiz files later. */
export interface SessionSummary {
  right: number;
  total: number;
  byRound: { round: string; right: number; total: number }[];
  missed: { index: number; text: string; round: string }[];
}

/**
 * A question the learner has got wrong at least once, and when to ask it again. Leitner boxes: a right answer moves
 * it up a box and further into the future; a wrong one puts it back in box 0, due straight away; five rights in a
 * row and it graduates (is forgotten about).
 */
export interface ReviewItem {
  quizId: string;
  quizTitle: string;
  index: number;
  text: string;
  round: string;
  box: number;
  due: string;
  misses: number;
  rights: number;
  lastAt: string;
}

export const REVIEW_DELAYS_MS = [0, 24 * 3_600_000, 3 * 24 * 3_600_000, 7 * 24 * 3_600_000, 14 * 24 * 3_600_000];
const GRADUATE_BOX = REVIEW_DELAYS_MS.length;

export interface PracticeAnswer {
  value: AnswerValue;
  correct: boolean;
  at: string;
}

export interface PracticeSession {
  id: string;
  quizId: string;
  quizTitle: string;
  /** The quiz file as it was; if it changes, an unfinished session cannot carry on. */
  quizHash: string;
  mode: PracticeMode;
  startedAt: string;
  finishedAt?: string;
  /** Question indices in the order they are asked. */
  order: number[];
  /** Where the learner is in `order`. */
  position: number;
  /** By question index. */
  answers: Record<string, PracticeAnswer>;
  flagged: number[];
  skipped: number[];
  /** Ordering questions: the shuffled order the items were shown in, by question index. */
  displays: Record<string, number[]>;
  /** Time spent, not counting long gaps. */
  elapsedMs: number;
  lastActionAt: string;
  /** Exam simulation: when the paper is taken in, whatever state it is in. */
  deadline?: string;
  kind?: 'review' | 'exam';
  summary?: SessionSummary;
}

export interface Learner {
  name: string;
  sessions: PracticeSession[];
  /** Questions to ask again, by "quizId:index". */
  review?: Record<string, ReviewItem>;
}

export interface DueGroup {
  quizId: string;
  quizTitle: string;
  indices: number[];
}

export interface Progress {
  attempts: { id: string; quizId: string; quizTitle: string; mode: PracticeMode; kind?: 'review' | 'exam'; finishedAt: string; right: number; total: number; percent: number; elapsedMs: number }[];
  /** Every round the learner has met, weakest first. */
  topics: { round: string; right: number; total: number; percent: number }[];
  /** The questions missed most often that are still in the boxes. */
  hardest: { quizTitle: string; text: string; round: string; misses: number; box: number; due: string }[];
  due: DueGroup[];
  reviewing: number;
  answered: number;
  right: number;
  percent: number;
}

/** What the page shows for the current question. The answer is included only once it may be seen. */
export interface PracticeView {
  id: string;
  quizId: string;
  quizTitle: string;
  mode: PracticeMode;
  position: number;
  total: number;
  answered: number;
  finished: boolean;
  elapsedMs: number;
  deadline?: string;
  kind?: 'review' | 'exam';
  question?: {
    index: number;
    type: Question['type'];
    text: string;
    round: string;
    options?: string[];
    /** Ordering: the items as shown, shuffled. */
    items?: string[];
    keypad?: 'grouped' | 'single';
    imageUrl?: string;
    audioUrl?: string;
    flagged: boolean;
    skipped: boolean;
    /** What the learner answered, as shown back to them. */
    given?: { value: AnswerValue; label: string };
    /** In learn mode, once answered: was it right, the answer and the explanation. */
    feedback?: { correct: boolean; answer: string; info?: string; detail?: string };
  };
}

export interface PracticeResults {
  id: string;
  quizId: string;
  quizTitle: string;
  mode: PracticeMode;
  kind?: 'review' | 'exam';
  /** Exam simulation: the clock ran out before the learner finished. */
  timedOut?: boolean;
  startedAt: string;
  finishedAt: string;
  right: number;
  total: number;
  percent: number;
  elapsedMs: number;
  byRound: { round: string; right: number; total: number }[];
  /** Every question, in the order asked, for review. */
  review: { index: number; round: string; text: string; type: Question['type']; given?: string; answer: string; info?: string; correct: boolean; skipped: boolean; flagged: boolean }[];
  /** Question indices that were wrong or skipped, for "retry the ones I missed". */
  missed: number[];
}

const MAX_GAP_MS = 5 * 60_000;
const MAX_NAME = 40;
const MAX_SESSIONS_KEPT = 200;

/** Shuffles indices; an ordering question is never shown already in the right order. */
function shuffled(length: number, neverSorted = false): number[] {
  for (;;) {
    const order = Array.from({ length }, (_, i) => i);
    for (let i = length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    if (!neverSorted || length < 2 || order.some((v, i) => v !== i)) return order;
  }
}

/** "Ada Lovelace" → "ada-lovelace": the file name a learner's history is kept under. */
export function learnerId(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function cleanLearnerName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
  if (!name || !learnerId(name)) throw new PracticeError('Type a name (letters or numbers).');
  return name;
}

export function startSession(quiz: Quiz, quizId: string, quizHash: string, options: PracticeOptions): PracticeSession {
  let indices = quiz.questions.map((_, i) => i);
  if (options.only) {
    const wanted = new Set(options.only);
    indices = indices.filter((i) => wanted.has(i));
  }
  if (!indices.length) throw new PracticeError('There are no questions to practise.');
  if (options.shuffle) indices = shuffled(indices.length).map((i) => indices[i]!);
  if (options.count && options.count > 0 && options.count < indices.length) indices = indices.slice(0, options.count);
  const displays: Record<string, number[]> = {};
  for (const i of indices) if (quiz.questions[i]!.type === 'ordering') displays[i] = shuffled(ORDERING_ITEMS, true);
  const startedAt = Date.now();
  const now = new Date(startedAt).toISOString();
  const minutes = options.timeLimitMinutes;
  if (minutes !== undefined && !(Number.isFinite(minutes) && minutes >= 1 && minutes <= 180)) throw new PracticeError('A time limit is between 1 and 180 minutes.');
  const kind = options.kind ?? (minutes ? 'exam' : undefined);
  return {
    id: randomUUID(), quizId, quizTitle: quiz.title, quizHash, mode: minutes ? 'test' : options.mode, startedAt: now, order: indices, position: 0, answers: {}, flagged: [], skipped: [], displays, elapsedMs: 0, lastActionAt: now,
    ...(minutes ? { deadline: new Date(startedAt + minutes * 60_000).toISOString() } : {}),
    ...(kind ? { kind } : {}),
  };
}

/** Exam simulation: the time is up. */
export function timeUp(session: PracticeSession, now = Date.now()): boolean {
  return Boolean(session.deadline && !session.finishedAt && Date.parse(session.deadline) <= now);
}

/** Adds the time since the last action to the clock, unless the learner was clearly away. */
function touch(session: PracticeSession): void {
  const now = Date.now();
  const gap = now - Date.parse(session.lastActionAt);
  if (gap > 0 && gap <= MAX_GAP_MS) session.elapsedMs += gap;
  session.lastActionAt = new Date(now).toISOString();
}

function current(session: PracticeSession): number | undefined {
  return session.order[session.position];
}

/** The answer as the learner sees it written back: the option text, the items in their order, the letter… */
function givenLabel(q: Question, value: AnswerValue): string {
  switch (q.type) {
    case 'multiple-choice':
      return q.options[value as number] ?? String(value);
    case 'ordering':
      return (value as number[]).map((i) => q.items[i]).join(' → ');
    case 'buzzer':
      return value === 'right' ? 'I got it' : 'I did not get it';
    default:
      return String(value);
  }
}

function detailFor(q: Question, value: AnswerValue, correct: boolean): string | undefined {
  if (q.type === 'ordering') return `${itemsInPlace(value as number[])} of ${ORDERING_ITEMS} in the right place`;
  if (q.type === 'nearest' && !correct) return `Off by ${Math.abs((value as number) - q.answer)}`;
  if (q.type === 'number' && !correct && q.tolerance > 0) return `Give or take ${q.tolerance}`;
  return undefined;
}

/** Media is served under the practice API, with the practice key, rather than from the live game's /media/. */
const mediaUrl = (quizId: string, url: string | undefined) => (url?.startsWith('/media/') ? `/api/practice/quizzes/${encodeURIComponent(quizId)}/media/${url.slice('/media/'.length)}` : url);

export function view(session: PracticeSession, quiz: Quiz): PracticeView {
  const index = current(session);
  const q = index === undefined ? undefined : quiz.questions[index];
  const base: PracticeView = {
    id: session.id,
    quizId: session.quizId,
    quizTitle: session.quizTitle,
    mode: session.mode,
    position: session.position,
    total: session.order.length,
    answered: Object.keys(session.answers).length,
    finished: Boolean(session.finishedAt),
    elapsedMs: session.elapsedMs,
    ...(session.deadline ? { deadline: session.deadline } : {}),
    ...(session.kind ? { kind: session.kind } : {}),
  };
  if (!q || index === undefined || session.finishedAt) return base;
  const answer = session.answers[index];
  const qq = q as Question & { imageUrl?: string; audioUrl?: string };
  return {
    ...base,
    question: {
      index,
      type: q.type,
      text: q.text,
      round: q.round,
      ...(q.type === 'multiple-choice' ? { options: q.options } : {}),
      ...(q.type === 'ordering' ? { items: (session.displays[index] ?? q.items.map((_, i) => i)).map((i) => q.items[i]!) } : {}),
      ...(q.type === 'letter' ? { keypad: q.keypad ?? 'grouped' } : {}),
      ...(qq.imageUrl ? { imageUrl: mediaUrl(session.quizId, qq.imageUrl) } : {}),
      ...(qq.audioUrl ? { audioUrl: mediaUrl(session.quizId, qq.audioUrl) } : {}),
      flagged: session.flagged.includes(index),
      skipped: session.skipped.includes(index),
      ...(answer ? { given: { value: answer.value, label: givenLabel(q, answer.value) } } : {}),
      ...(answer && session.mode === 'learn'
        ? { feedback: { correct: answer.correct, answer: answerText(q), ...(q.info ? { info: q.info } : {}), ...(detailFor(q, answer.value, answer.correct) ? { detail: detailFor(q, answer.value, answer.correct) } : {}) } }
        : {}),
    },
  };
}

export function answer(session: PracticeSession, quiz: Quiz, value: AnswerValue): void {
  if (session.finishedAt) throw new PracticeError('This session is finished.');
  const index = current(session);
  const q = index === undefined ? undefined : quiz.questions[index];
  if (!q || index === undefined) throw new PracticeError('There is no question to answer.');
  if (session.answers[index] && session.mode === 'learn') throw new PracticeError('You have answered this one; press Next.');
  touch(session);
  let stored: AnswerValue;
  if (q.type === 'buzzer') {
    // Nobody to buzz against: the learner reads the answer and says whether they had it.
    if (value !== 'right' && value !== 'wrong') throw new PracticeError('Say whether you got it.');
    stored = value;
  } else {
    const checked = validateAnswer(q, value, session.displays[index]);
    if (!checked.ok) throw new PracticeError(checked.error);
    stored = checked.value;
  }
  session.answers[index] = { value: stored, correct: isRight(q, stored), at: new Date().toISOString() };
  session.skipped = session.skipped.filter((i) => i !== index);
  // In test mode there is nothing to look at, so move straight on.
  if (session.mode === 'test' && session.position < session.order.length - 1) session.position++;
}

/** The answer of a buzzer question, which the learner needs before they can judge themselves. */
export function revealForSelfMarking(session: PracticeSession, quiz: Quiz): { answer: string; info?: string } {
  const index = current(session);
  const q = index === undefined ? undefined : quiz.questions[index];
  if (!q || q.type !== 'buzzer') throw new PracticeError('Only a buzzer question is marked by you.');
  return { answer: q.answer, ...(q.info ? { info: q.info } : {}) };
}

export function move(session: PracticeSession, delta: 1 | -1): void {
  if (session.finishedAt) throw new PracticeError('This session is finished.');
  touch(session);
  const next = session.position + delta;
  if (next < 0 || next >= session.order.length) throw new PracticeError(delta > 0 ? 'That was the last question.' : 'This is the first question.');
  session.position = next;
}

export function skip(session: PracticeSession): void {
  if (session.finishedAt) throw new PracticeError('This session is finished.');
  const index = current(session);
  if (index === undefined) return;
  touch(session);
  if (!session.answers[index] && !session.skipped.includes(index)) session.skipped.push(index);
  if (session.position < session.order.length - 1) session.position++;
}

export function toggleFlag(session: PracticeSession): void {
  const index = current(session);
  if (index === undefined) return;
  session.flagged = session.flagged.includes(index) ? session.flagged.filter((i) => i !== index) : [...session.flagged, index];
}

/** Ends the session. With the quiz to hand, what it came to is kept with it (for progress later, without the quiz). */
export function finish(session: PracticeSession, quiz?: Quiz): void {
  if (session.finishedAt) return;
  touch(session);
  session.finishedAt = new Date().toISOString();
  if (quiz) {
    const r = results(session, quiz);
    session.summary = { right: r.right, total: r.total, byRound: r.byRound, missed: r.review.filter((x) => !x.correct).map((x) => ({ index: x.index, text: x.text, round: x.round })) };
  }
}

/**
 * Moves the learner's review boxes on from a finished attempt: a wrong or skipped question goes to (or back to) box 0,
 * due now; a right answer to a question already in the boxes moves it up a box, or out altogether. Questions never
 * missed are not tracked: the boxes hold only what needs another look.
 */
export function updateReview(learner: Learner, session: PracticeSession, quiz: Quiz, now = Date.now()): void {
  const review = (learner.review ??= {});
  const at = new Date(now).toISOString();
  for (const index of session.order) {
    const q = quiz.questions[index];
    if (!q) continue;
    const a = session.answers[index];
    if (!a && !session.skipped.includes(index)) continue; // never reached: says nothing
    const key = `${session.quizId}:${index}`;
    const item = review[key];
    if (a?.correct) {
      if (!item) continue;
      item.rights++;
      item.box++;
      item.lastAt = at;
      if (item.box >= GRADUATE_BOX) delete review[key];
      else item.due = new Date(now + REVIEW_DELAYS_MS[item.box]!).toISOString();
    } else {
      review[key] = { quizId: session.quizId, quizTitle: quiz.title, index, text: q.text, round: q.round, box: 0, due: at, misses: (item?.misses ?? 0) + 1, rights: item?.rights ?? 0, lastAt: at };
    }
  }
}

/** What is due for another look, by quiz. */
export function dueReview(learner: Learner, now = Date.now()): DueGroup[] {
  const groups = new Map<string, DueGroup>();
  for (const item of Object.values(learner.review ?? {})) {
    if (Date.parse(item.due) > now) continue;
    const g = groups.get(item.quizId) ?? { quizId: item.quizId, quizTitle: item.quizTitle, indices: [] };
    g.indices.push(item.index);
    groups.set(item.quizId, g);
  }
  return [...groups.values()].map((g) => ({ ...g, indices: g.indices.sort((a, b) => a - b) }));
}

/** Drops review items for a quiz that has changed or gone, since their question numbers may no longer mean the same. */
export function forgetReview(learner: Learner, quizId: string): void {
  for (const [key, item] of Object.entries(learner.review ?? {})) if (item.quizId === quizId) delete learner.review![key];
}

/** Everything the learner (or a parent or teacher) might want to know about how it is going. */
export function progress(learner: Learner, now = Date.now()): Progress {
  const attempts: Progress['attempts'] = [];
  const topics = new Map<string, { right: number; total: number }>();
  let answered = 0;
  let right = 0;
  for (const s of learner.sessions) {
    if (!s.finishedAt) continue;
    const r = s.summary?.right ?? Object.values(s.answers).filter((a) => a.correct).length;
    const total = s.summary?.total ?? s.order.length;
    attempts.push({ id: s.id, quizId: s.quizId, quizTitle: s.quizTitle, mode: s.mode, ...(s.kind ? { kind: s.kind } : {}), finishedAt: s.finishedAt, right: r, total, percent: total ? Math.round((100 * r) / total) : 0, elapsedMs: s.elapsedMs });
    answered += total;
    right += r;
    for (const b of s.summary?.byRound ?? []) {
      const t = topics.get(b.round) ?? { right: 0, total: 0 };
      t.right += b.right;
      t.total += b.total;
      topics.set(b.round, t);
    }
  }
  const items = Object.values(learner.review ?? {});
  return {
    attempts: attempts.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt)),
    topics: [...topics].map(([round, t]) => ({ round, ...t, percent: t.total ? Math.round((100 * t.right) / t.total) : 0 })).sort((a, b) => a.percent - b.percent || b.total - a.total),
    hardest: items.sort((a, b) => b.misses - a.misses || a.due.localeCompare(b.due)).slice(0, 10).map((i) => ({ quizTitle: i.quizTitle, text: i.text, round: i.round, misses: i.misses, box: i.box, due: i.due })),
    due: dueReview(learner, now),
    reviewing: items.length,
    answered,
    right,
    percent: answered ? Math.round((100 * right) / answered) : 0,
  };
}

const csvCell = (value: unknown) => {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csvLine = (cells: unknown[]) => cells.map(csvCell).join(',') + '\r\n';

/** One row per finished attempt. */
export function learnerCsv(learner: Learner): string {
  const p = progress(learner);
  return csvLine(['Learner', 'Finished', 'Quiz', 'Mode', 'Kind', 'Right', 'Total', 'Percent', 'Minutes']) + p.attempts.map((a) => csvLine([learner.name, a.finishedAt, a.quizTitle, a.mode, a.kind ?? '', a.right, a.total, a.percent, Math.round(a.elapsedMs / 6000) / 10])).join('');
}

/** One row per question of an attempt. */
export function resultsCsv(learner: Learner, r: PracticeResults): string {
  return csvLine(['Learner', 'Quiz', 'Finished', 'Round', 'Question', 'Your answer', 'Answer', 'Right', 'Skipped', 'Flagged', 'Info']) + r.review.map((x) => csvLine([learner.name, r.quizTitle, r.finishedAt, x.round, x.text, x.given ?? '', x.answer, x.correct ? 'yes' : 'no', x.skipped ? 'yes' : '', x.flagged ? 'yes' : '', x.info ?? ''])).join('');
}

export function results(session: PracticeSession, quiz: Quiz): PracticeResults {
  if (!session.finishedAt) throw new PracticeError('Finish the session first.');
  const rounds = new Map<string, { right: number; total: number }>();
  const review: PracticeResults['review'] = [];
  const missed: number[] = [];
  let right = 0;
  for (const index of session.order) {
    const q = quiz.questions[index]!;
    const a = session.answers[index];
    const correct = a?.correct ?? false;
    if (correct) right++;
    else missed.push(index);
    const r = rounds.get(q.round) ?? { right: 0, total: 0 };
    r.total++;
    if (correct) r.right++;
    rounds.set(q.round, r);
    review.push({
      index,
      round: q.round,
      text: q.text,
      type: q.type,
      ...(a ? { given: givenLabel(q, a.value) } : {}),
      answer: answerText(q),
      ...(q.info ? { info: q.info } : {}),
      correct,
      skipped: !a,
      flagged: session.flagged.includes(index),
    });
  }
  const total = session.order.length;
  return {
    id: session.id,
    quizId: session.quizId,
    quizTitle: session.quizTitle,
    mode: session.mode,
    ...(session.kind ? { kind: session.kind } : {}),
    ...(session.deadline && Date.parse(session.finishedAt) >= Date.parse(session.deadline) ? { timedOut: true } : {}),
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    right,
    total,
    percent: total ? Math.round((100 * right) / total) : 0,
    elapsedMs: session.elapsedMs,
    byRound: [...rounds].map(([round, r]) => ({ round, ...r })),
    review,
    missed,
  };
}

/** Learners' histories: one JSON file each under practice/ in the library. */
export class PracticeStore {
  readonly dir: string;
  private readonly writing = new Map<string, Promise<void>>();

  constructor(libraryDir: string) {
    this.dir = join(libraryDir, 'practice');
  }

  private path(name: string): string {
    return join(this.dir, `${learnerId(name)}.json`);
  }

  async learners(): Promise<{ name: string; sessions: number; lastAt?: string }[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));
    const all = await Promise.all(
      files.map(async (f) => {
        try {
          const learner = JSON.parse(await readFile(join(this.dir, f), 'utf8')) as Learner;
          if (typeof learner.name !== 'string' || !Array.isArray(learner.sessions)) return undefined;
          const lastAt = learner.sessions.map((s) => s.lastActionAt).sort().at(-1);
          return { name: learner.name, sessions: learner.sessions.length, ...(lastAt ? { lastAt } : {}) };
        } catch {
          return undefined;
        }
      }),
    );
    return all.filter((l): l is NonNullable<typeof l> => Boolean(l)).sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
  }

  async load(name: string): Promise<Learner> {
    try {
      const learner = JSON.parse(await readFile(this.path(name), 'utf8')) as Learner;
      if (typeof learner.name === 'string' && Array.isArray(learner.sessions)) return learner;
    } catch {
      // New learner.
    }
    return { name, sessions: [] };
  }

  /** Writes whole, never half: a crash mid-write leaves the old file. One write at a time per learner. */
  async save(learner: Learner): Promise<void> {
    const path = this.path(learner.name);
    if (learner.sessions.length > MAX_SESSIONS_KEPT) learner.sessions = learner.sessions.slice(-MAX_SESSIONS_KEPT);
    const previous = this.writing.get(path) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify(learner, null, 1));
      await rename(`${path}.tmp`, path);
    });
    this.writing.set(path, next.catch(() => {}));
    await next;
  }
}

/** The learner's unfinished session, if any. */
export function currentSession(learner: Learner): PracticeSession | undefined {
  return learner.sessions.find((s) => !s.finishedAt);
}
