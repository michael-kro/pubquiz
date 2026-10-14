import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { normalise } from './matching.ts';

export const ORDERING_ITEMS = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const text = z.string().trim().min(1);

const common = {
  text,
  seconds: z.number().int().min(5).max(300).default(20),
  points: z.number().int().min(0).max(10_000).default(1000),
  /** A file path relative to the quiz file, or an http(s) URL. */
  image: text.optional(),
  /** Faster correct answers earn more. Defaults to on, except for music. */
  speedBonus: z.boolean().optional(),
};

const accept = z
  .array(text)
  .min(1)
  .refine((answers) => answers.every((a) => normalise(a)), {
    message: 'each accepted answer needs at least one letter or number',
  });

const QuestionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('multiple-choice'),
      ...common,
      options: z.array(text).min(2).max(4),
      answer: z.number().int().min(0),
    })
    .strict()
    .refine((q) => q.answer < q.options.length, {
      message: 'must be the position of one of the options, counting from 0',
      path: ['answer'],
    }),
  z.object({ type: z.literal('picture'), ...common, image: text, accept }).strict(),
  z.object({ type: z.literal('music'), ...common, accept }).strict(),
  // classic style: teams tap the first letter of the answer.
  z
    .object({
      type: z.literal('letter'),
      ...common,
      /** The full answer, shown at the reveal. */
      answer: text,
      /** Only needed when the first letter can't be worked out, e.g. the answer starts with a number. */
      letter: z.string().regex(/^[A-Za-z]$/, 'must be a single letter A–Z').optional(),
    })
    .strict()
    .refine((q) => q.letter || /^[a-z]/.test(normalise(q.answer)), {
      message: "doesn't start with a letter A–Z, so add letter: with the letter teams should tap",
      path: ['answer'],
    }),
  z
    .object({
      type: z.literal('ordering'),
      ...common,
      /** Listed in the correct order. */
      items: z.array(text).length(ORDERING_ITEMS, `needs exactly ${ORDERING_ITEMS} items`),
    })
    .strict()
    .refine((q) => new Set(q.items.map((i) => i.toLowerCase())).size === q.items.length, {
      message: 'items must all be different',
      path: ['items'],
    }),
]);

const QuizFile = z
  .object({
    title: text,
    scoring: z
      .object({
        // Share of a correct answer's points lost by answering at the very last moment.
        speedFactor: z.number().min(0).max(1).default(0.5),
      })
      .strict()
      .default({ speedFactor: 0.5 }),
    rounds: z
      .array(z.object({ name: text, questions: z.array(QuestionSchema).min(1) }).strict())
      .min(1),
  })
  .strict();

export type Question = z.infer<typeof QuestionSchema> & {
  round: string;
  /** Where browsers load the image from, once resolved. */
  imageUrl?: string;
};
export type QuestionType = Question['type'];

export interface Media {
  data: Buffer;
  contentType: string;
}

export interface Quiz {
  title: string;
  speedFactor: number;
  questions: Question[];
  /** Images served at /media/<key>. */
  media: Map<string, Media>;
}

export function isTextAnswer(q: Question): q is Extract<Question, { type: 'picture' | 'music' }> {
  return q.type === 'picture' || q.type === 'music';
}

export class QuizError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid quiz:\n  ${issues.join('\n  ')}`);
    this.name = 'QuizError';
    this.issues = issues;
  }
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

/** "The Lion King" → L, "Paul McCartney" → P (people go by first name, so write them first name first). */
export function firstLetter(answer: string, override?: string): string {
  return (override ?? normalise(answer)[0] ?? '').toUpperCase();
}

/** Parses and validates a quiz. Local image files are not read here; see loadQuizFile. */
export function parseQuiz(source: string): Quiz {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw new QuizError([`Not valid YAML: ${(error as Error).message}`]);
  }

  const result = QuizFile.safeParse(raw);
  if (!result.success) {
    throw new QuizError(result.error.issues.map((issue) => `${describePath(issue.path)}: ${issue.message}`));
  }

  const file = result.data;
  return {
    title: file.title,
    speedFactor: file.scoring.speedFactor,
    questions: file.rounds.flatMap((round) =>
      round.questions.map((q) => ({
        ...q,
        ...(q.type === 'letter' ? { letter: firstLetter(q.answer, q.letter) } : {}),
        round: round.name,
        imageUrl: q.image && isUrl(q.image) ? q.image : undefined,
      })),
    ),
    media: new Map(),
  };
}

/** Reads the images a quiz refers to, relative to `baseDir`, so the server can hand them to phones. */
export async function loadMedia(quiz: Quiz, baseDir: string): Promise<void> {
  const issues: string[] = [];
  for (const [index, q] of quiz.questions.entries()) {
    if (!q.image || isUrl(q.image)) continue;
    const label = `Question ${index + 1} ("${q.text}"), image`;
    const ext = extname(q.image).toLowerCase();
    const contentType = IMAGE_TYPES[ext];
    if (!contentType) {
      issues.push(`${label}: use a ${Object.keys(IMAGE_TYPES).join(', ')} file`);
      continue;
    }
    const path = resolve(baseDir, q.image);
    try {
      const size = (await stat(path)).size;
      if (size > MAX_IMAGE_BYTES) {
        issues.push(`${label}: ${q.image} is over 10 MB. Shrink it so phones can load it quickly.`);
        continue;
      }
      const key = `q${index + 1}${ext}`;
      quiz.media.set(key, { data: await readFile(path), contentType });
      q.imageUrl = `/media/${key}`;
    } catch {
      issues.push(`${label}: can't find ${q.image} (looked in ${baseDir})`);
    }
  }
  if (issues.length) throw new QuizError(issues);
}

export async function loadQuizFile(path: string): Promise<Quiz> {
  const quiz = parseQuiz(await readFile(path, 'utf8'));
  await loadMedia(quiz, dirname(resolve(path)));
  return quiz;
}

// Turns ['rounds', 0, 'questions', 2, 'answer'] into "Round 1, question 3, answer".
function describePath(path: PropertyKey[]): string {
  if (path.length === 0) return 'Quiz';
  const names: Record<string, string> = { rounds: 'Round', questions: 'question', options: 'option', items: 'item', accept: 'accepted answer' };
  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const next = path[i + 1];
    const name = typeof key === 'string' ? names[key] : undefined;
    if (name && typeof next === 'number') {
      parts.push(`${name} ${next + 1}`);
      i++;
    } else {
      parts.push(String(key));
    }
  }
  return parts.join(', ');
}
