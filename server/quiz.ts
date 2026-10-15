import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { normalise } from './matching.ts';

export const ORDERING_ITEMS = 5;
export const SCORING_MODES = ['speed', 'flat', 'first'] as const;
export type ScoringMode = (typeof SCORING_MODES)[number];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/** Clips are played by the host or TV screen, so any format a browser can play will do. */
export const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
};
export const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const text = z.string({ error: 'needs some text' }).trim().min(1, 'is empty');

const common = {
  text,
  seconds: z.number({ error: 'must be a number' }).int('must be a whole number').min(5, 'must be at least 5 seconds').max(300, 'can be at most 300 seconds').default(20),
  points: z.number({ error: 'must be a number' }).int('must be a whole number').min(0, "can't be negative").max(10_000, 'can be at most 10,000').default(1000),
  /** A file path relative to the quiz file, or an http(s) URL. */
  image: text.optional(),
  /** A sound clip, played on the host or TV screen (never on phones): a file path or an http(s) URL. */
  audio: text.optional(),
  /** A fun clip (for example a film quote) the host or TV plays after the answer is revealed. */
  revealAudio: text.optional(),
  /** What to show beside the reveal clip, such as the film and the line. */
  revealCaption: text.max(160).optional(),
  /** Faster correct answers earn more. Defaults to on, except for music. */
  speedBonus: z.boolean().optional(),
  /** In a wager round: the category teams see while they bet, before the question appears. */
  category: text.max(60).optional(),
  /** Shown with the answer once it's revealed: a fun fact, or where it comes from. */
  info: z.string().trim().min(1).max(300).optional(),
};

const number = z.number({ error: 'must be a number' }).finite('must be a number').refine((n) => Math.abs(n) <= 1e12, 'is too big');

const accept = z
  .array(text, { error: 'needs a list of accepted answers' })
  .min(1, 'needs at least one accepted answer')
  .refine((answers) => answers.every((a) => normalise(a)), {
    message: 'each accepted answer needs at least one letter or number',
  });

const QuestionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('multiple-choice'),
      ...common,
      options: z.array(text, { error: 'needs a list of options' }).min(2, 'needs at least 2 options').max(6, 'can have at most 6 options'),
      answer: z.number({ error: 'must say which option is right (0 for the first)' }).int().min(0, 'must be 0 or more'),
    })
    .strict()
    .refine((q) => q.answer < q.options.length, {
      message: 'must be the position of one of the options, counting from 0',
      path: ['answer'],
    }),
  z.object({ type: z.literal('picture'), ...common, image: text, accept }).strict(),
  z.object({ type: z.literal('music'), ...common, accept }).strict(),
  // Teams type a number. Right if it matches, give or take `tolerance`.
  z.object({ type: z.literal('number'), ...common, answer: number, tolerance: z.number().min(0).max(1e12).default(0) }).strict(),
  // Buzzin': teams race to buzz, the first answers out loud, and the host judges. A wrong answer locks that team out.
  z
    .object({
      type: z.literal('buzzer'),
      ...common,
      /** What the host is looking for. Shown only to the host, until the reveal. */
      answer: text,
      /** Points taken off a team that buzzes and gets it wrong. */
      penalty: z.number().int().min(0).max(10_000).default(0),
    })
    .strict(),
  // Teams type a number; whoever is closest wins the points.
  z.object({ type: z.literal('nearest'), ...common, answer: number }).strict(),
  // classic style: teams tap the first letter of the answer.
  z
    .object({
      type: z.literal('letter'),
      ...common,
      /** The full answer, shown at the reveal. */
      answer: text,
      /** Only needed when the first letter can't be worked out, e.g. the answer starts with a number. */
      letter: z.string().regex(/^[A-Za-z]$/, 'must be a single letter A–Z').optional(),
      /** 'grouped' (default): a 4×6 keypad like the usual, with the rare letters paired (QV, XZ) with Q/V and X/Z sharing a key. 'single': all 26 letters. */
      keypad: z.enum(['grouped', 'single']).optional(),
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
      items: z.array(text, { error: 'needs a list of items' }).length(ORDERING_ITEMS, `needs exactly ${ORDERING_ITEMS} items`),
    })
    .strict()
    .refine((q) => new Set(q.items.map((i) => i.toLowerCase())).size === q.items.length, {
      message: 'items must all be different',
      path: ['items'],
    }),
], { error: 'type must be one of: multiple-choice, picture, music, ordering, letter' });

/** The keys of the grouped letter keypad: single letters, except the rare ones: QV and XZ. */
export const LETTER_GROUPS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'R', 'S', 'T', 'U', 'QV', 'W', 'Y', 'XZ'];

export const QuizFile = z
  .object({
    title: text,
    /** Fun facts for the break screen. Without any, the built-in facts are used. */
    facts: z.array(z.string().trim().min(1).max(200)).max(300).optional(),
    /** The host asks each question (and reads out multiple-choice answers one at a time) before starting the timer. */
    readOut: z.boolean().optional(),
    scoring: z
      .object({
        // Share of a correct answer's points lost by answering at the very last moment.
        speedFactor: z.number().min(0).max(1).default(0.5),
        /** speed: faster scores more. flat: every correct answer scores the same. first: flat, plus a bonus for the first correct team. */
        mode: z.enum(SCORING_MODES, { error: `must be one of: ${SCORING_MODES.join(', ')}` }).default('speed'),
        /** Extra points for the first correct team in "first" mode. */
        bonus: z.number().int().min(0).max(10_000).default(500),
        /** Extra points for the quickest correct teams on every question (0 = off). First place gets all of it, second 60%, third 30%. */
        fastBonus: z.number().int().min(0).max(10_000).default(0),
        /** How many of the quickest correct teams earn it: 1, 2 or 3. */
        fastPlaces: z.number().int().min(1).max(3).default(1),
        /** Show the full leaderboard at the end of each round (default; mid-round the reveal shows the top five), or after every question. */
        leaderboard: z.enum(['question', 'round'], { error: 'must be question or round' }).default('round'),
      })
      .strict()
      .default({ speedFactor: 0.5, mode: 'speed', bonus: 500, fastBonus: 0, fastPlaces: 1, leaderboard: 'round' }),
    rounds: z
      .array(
        z.object({ name: text, wager: z.boolean().optional(), wagerCap: z.number().int().min(1).max(100_000).optional(), mode: z.enum(SCORING_MODES, { error: `must be one of: ${SCORING_MODES.join(', ')}` }).optional(), questions: z.array(QuestionSchema, { error: 'needs a list of questions' }).min(1, 'needs at least one question') }).strict(),
        { error: 'needs a list of rounds' },
      )
      .min(1, 'needs at least one round'),
  })
  .strict();

export type Question = z.infer<typeof QuestionSchema> & {
  round: string;
  /** Position of the question's round, from 0. */
  roundIndex: number;
  /** How this question is scored: its round's mode, or the quiz's. */
  mode: ScoringMode;
  /** The question is in a wager round: teams bet points before seeing it. */
  wager: boolean;
  /** The most a team may bet, if the round sets one (otherwise its score, with a small minimum). */
  wagerCap?: number;
  /** Where browsers load the image from, once resolved. */
  imageUrl?: string;
  /** Where the host and TV screens load the audio clip from, once resolved. */
  audioUrl?: string;
  /** Where the reveal clip is loaded from, once resolved. */
  revealAudioUrl?: string;
};
export type QuestionType = Question['type'];

export interface Media {
  data: Buffer;
  contentType: string;
}

export interface Quiz {
  title: string;
  /** Start multiple-choice questions in read-out mode (the host can switch it either way). */
  readOut?: boolean;
  /** The quiz's own fun facts for the break screen (empty: use the built-in ones). */
  facts: string[];
  speedFactor: number;
  /** Extra points for the first correct team, in "first" mode. */
  bonus: number;
  /** Extra points for the quickest correct teams, any mode but "first". */
  fastBonus: number;
  fastPlaces: number;
  /** When the leaderboard is shown. */
  leaderboard: 'question' | 'round';
  questions: Question[];
  /** Round names, in order. */
  rounds: string[];
  /** Images served at /media/<key>. */
  media: Map<string, Media>;
}

export function isTextAnswer(q: Question): q is Extract<Question, { type: 'picture' | 'music' }> {
  return q.type === 'picture' || q.type === 'music';
}

export interface QuizIssue {
  /** Where in the quiz file, e.g. ['rounds', 0, 'questions', 2, 'answer']. */
  path: (string | number)[];
  message: string;
}

/** "Round 1, question 3, answer: must be …" */
export function describeIssue(issue: QuizIssue): string {
  return `${describePath(issue.path)}: ${issue.message}`;
}

export type QuizFileData = z.infer<typeof QuizFile>;

/** Validates quiz data (parsed YAML, or the editor's draft) without throwing. */
export function checkQuiz(raw: unknown): { data?: QuizFileData; issues: QuizIssue[] } {
  const result = QuizFile.safeParse(raw);
  if (result.success) return { data: result.data, issues: [] };
  return {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.filter((p): p is string | number => typeof p !== 'symbol'),
      message: issue.message,
    })),
  };
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

  return quizFromData(checkedOrThrow(raw));
}

function checkedOrThrow(raw: unknown): QuizFileData {
  const { data, issues } = checkQuiz(raw);
  if (!data) throw new QuizError(issues.map(describeIssue));
  return data;
}

function quizFromData(file: QuizFileData): Quiz {
  return {
    title: file.title,
    facts: file.facts ?? [],
    readOut: file.readOut,
    speedFactor: file.scoring.speedFactor,
    bonus: file.scoring.bonus,
    fastBonus: file.scoring.fastBonus,
    fastPlaces: file.scoring.fastPlaces,
    leaderboard: file.scoring.leaderboard,
    rounds: file.rounds.map((round) => round.name),
    questions: file.rounds.flatMap((round, roundIndex) =>
      round.questions.map((q) => ({
        ...q,
        ...(q.type === 'letter' ? { letter: firstLetter(q.answer, q.letter) } : {}),
        round: round.name,
        roundIndex,
        mode: round.mode ?? file.scoring.mode,
        wager: round.wager === true,
        wagerCap: round.wagerCap,
        imageUrl: q.image && isUrl(q.image) ? q.image : undefined,
        audioUrl: q.audio && isUrl(q.audio) ? q.audio : undefined,
        revealAudioUrl: q.revealAudio && isUrl(q.revealAudio) ? q.revealAudio : undefined,
      })),
    ),
    media: new Map(),
  };
}

/** Reads the images a quiz refers to, relative to `baseDir`, so the server can hand them to phones. */
export async function loadMedia(quiz: Quiz, baseDir: string): Promise<void> {
  const issues: string[] = [];
  for (const [index, q] of quiz.questions.entries()) {
    if (q.audio && !isUrl(q.audio)) {
      const label = `Question ${index + 1} ("${q.text}"), audio`;
      const ext = extname(q.audio).toLowerCase();
      const contentType = AUDIO_TYPES[ext];
      if (!contentType) issues.push(`${label}: use a ${Object.keys(AUDIO_TYPES).join(', ')} file`);
      else {
        try {
          if ((await stat(resolve(baseDir, q.audio))).size > MAX_AUDIO_BYTES) issues.push(`${label}: ${q.audio} is over 20 MB.`);
          else {
            const key = `q${index + 1}-audio${ext}`;
            quiz.media.set(key, { data: await readFile(resolve(baseDir, q.audio)), contentType });
            q.audioUrl = `/media/${key}`;
          }
        } catch {
          issues.push(`${label}: can't find ${q.audio} (looked in ${baseDir})`);
        }
      }
    }
    if (q.revealAudio && !isUrl(q.revealAudio)) {
      const label = `Question ${index + 1} ("${q.text}"), reveal clip`;
      const ext = extname(q.revealAudio).toLowerCase();
      const contentType = AUDIO_TYPES[ext];
      if (!contentType) issues.push(`${label}: use a ${Object.keys(AUDIO_TYPES).join(', ')} file`);
      else {
        try {
          if ((await stat(resolve(baseDir, q.revealAudio))).size > MAX_AUDIO_BYTES) issues.push(`${label}: ${q.revealAudio} is over 20 MB.`);
          else {
            const key = `q${index + 1}-reveal${ext}`;
            quiz.media.set(key, { data: await readFile(resolve(baseDir, q.revealAudio)), contentType });
            q.revealAudioUrl = `/media/${key}`;
          }
        } catch {
          issues.push(`${label}: can't find ${q.revealAudio} (looked in ${baseDir})`);
        }
      }
    }
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
