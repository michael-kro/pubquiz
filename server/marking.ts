// Marking that does not depend on who else is playing: is this answer right for this question, and what was the
// answer? Shared by the live game (which adds points, speed and the host's overrides on top) and practice mode.
import { matchAnswer } from './matching.ts';
import type { AnswerValue } from './protocol.ts';
import { LETTER_GROUPS, ORDERING_ITEMS, type Question } from './quiz.ts';

export const MAX_TEXT_ANSWER = 100;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/**
 * Cleans up and checks the shape of an answer for a question. Ordering answers arrive as positions in the shuffled
 * list the player saw (`display`), and come back as item indices in the player's order.
 */
export function validateAnswer(question: Question, value: AnswerValue, display?: number[]): Checked<AnswerValue> {
  switch (question.type) {
    case 'multiple-choice':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= question.options.length) {
        return fail('That is not one of the options.');
      }
      return { ok: true, value };
    case 'text':
    case 'picture':
    case 'music': {
      if (typeof value !== 'string') return fail('Type an answer.');
      const text = value.trim().replace(/\s+/g, ' ');
      if (!text) return fail('Type an answer.');
      if (text.length > MAX_TEXT_ANSWER) return fail(`Answers can be at most ${MAX_TEXT_ANSWER} characters.`);
      return { ok: true, value: text };
    }
    case 'letter': {
      const key = typeof value === 'string' ? value.toUpperCase() : '';
      if (!/^[A-Z]$/.test(key) && !LETTER_GROUPS.includes(key)) return fail('Tap a key.');
      return { ok: true, value: key };
    }
    case 'number':
    case 'nearest':
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) return fail('Type a number.');
      return { ok: true, value };
    case 'buzzer':
      return fail('Press the buzzer.');
    case 'ordering': {
      const valid =
        Array.isArray(value) &&
        value.length === ORDERING_ITEMS &&
        new Set(value).size === ORDERING_ITEMS &&
        value.every((v) => Number.isInteger(v) && v >= 0 && v < ORDERING_ITEMS);
      if (!valid) return fail(`Put all ${ORDERING_ITEMS} items in order.`);
      const order = display ?? Array.from({ length: ORDERING_ITEMS }, (_, i) => i);
      return { ok: true, value: value.map((d) => order[d]!) };
    }
  }
}

/**
 * Whether a validated answer is right, for the question types that have a right answer of their own. "Nearest" and
 * buzzer questions are judged against the other players or by the host, so they are not decided here. Typed answers
 * take `textOverride` when the host has marked that exact answer by hand.
 */
export function isRight(question: Question, value: AnswerValue, textOverride?: boolean): boolean {
  switch (question.type) {
    case 'multiple-choice':
      return value === question.answer;
    case 'text':
    case 'picture':
    case 'music':
      return textOverride ?? matchAnswer(value as string, question.accept) !== 'none';
    case 'letter':
      return (value as string).includes(question.letter ?? '');
    case 'number':
      return Math.abs((value as number) - question.answer) <= question.tolerance + 1e-9;
    case 'ordering':
      return (value as number[]).every((item, position) => item === position);
    case 'nearest':
      return (value as number) === question.answer;
    case 'buzzer':
      return value === 'right';
  }
}

/** How many of an ordering answer's items are in the right place. */
export function itemsInPlace(value: number[]): number {
  return value.filter((item, position) => item === position).length;
}

/** The answer, as shown at the reveal. */
export function answerText(q: Question): string {
  switch (q.type) {
    case 'multiple-choice':
      return q.options[q.answer]!;
    case 'text':
    case 'picture':
    case 'music':
      return q.accept.join(' / ');
    case 'ordering':
      return q.items.join(' → ');
    case 'letter':
      return `${q.letter}: ${q.answer}`;
    case 'number':
      return q.tolerance > 0 ? `${q.answer} (give or take ${q.tolerance})` : String(q.answer);
    case 'nearest':
      return String(q.answer);
    case 'buzzer':
      return q.answer;
  }
}
