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
  /** Only these questions (by index in the quiz), for "retry the ones I missed". */
  only?: number[];
}

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
}

export interface Learner {
  name: string;
  sessions: PracticeSession[];
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
  const now = new Date().toISOString();
  return { id: randomUUID(), quizId, quizTitle: quiz.title, quizHash, mode: options.mode, startedAt: now, order: indices, position: 0, answers: {}, flagged: [], skipped: [], displays, elapsedMs: 0, lastActionAt: now };
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

export function finish(session: PracticeSession): void {
  if (session.finishedAt) return;
  touch(session);
  session.finishedAt = new Date().toISOString();
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
