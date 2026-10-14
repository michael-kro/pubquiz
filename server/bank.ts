// The question bank: ready-made questions, grouped by category, that can be picked into any quiz.
// One YAML file per category in bank/. Each question has the usual fields plus a difficulty.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { normalise } from './matching.ts';

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

const text = z.string().trim().min(1);
const common = {
  text: text.max(300),
  difficulty: z.enum(DIFFICULTIES),
  tags: z.array(text.max(30)).max(6).optional(),
  /** Shown after the answer is revealed: a fun fact or where it comes from. */
  info: text.max(300).optional(),
};

const BankQuestion = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('multiple-choice'),
      ...common,
      options: z.array(text.max(80)).min(2).max(6),
      answer: z.number().int().min(0),
    })
    .strict()
    .refine((q) => q.answer < q.options.length, { message: 'must be the position of an option, counting from 0', path: ['answer'] })
    .refine((q) => new Set(q.options.map((o) => normalise(o))).size === q.options.length, { message: 'must all be different', path: ['options'] }),
  z.object({ type: z.literal('letter'), ...common, answer: text.max(80) }).strict(),
  z.object({ type: z.literal('number'), ...common, answer: z.number().finite() }).strict(),
  z.object({ type: z.literal('nearest'), ...common, answer: z.number().finite() }).strict(),
  z
    .object({ type: z.literal('ordering'), ...common, items: z.array(text.max(60)).length(5) })
    .strict()
    .refine((q) => new Set(q.items.map((i) => normalise(i))).size === 5, { message: 'must all be different', path: ['items'] }),
]);

export const BankFile = z
  .object({
    category: text.max(60),
    /** Spelling and references: UK, US, or neutral. */
    region: z.enum(['uk', 'us', 'universal']).default('universal'),
    questions: z.array(BankQuestion).min(1),
  })
  .strict();

export type BankQuestion = z.infer<typeof BankQuestion>;
export type BankData = z.infer<typeof BankFile>;

export interface BankProblem {
  question?: number;
  message: string;
}

/** Checks one bank file's text. Returns the data, and everything wrong with it (so an author can fix it all at once). */
export function checkBank(source: string): { data?: BankData; problems: BankProblem[] } {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    return { problems: [{ message: `Not valid YAML: ${(error as Error).message}` }] };
  }
  const result = BankFile.safeParse(raw);
  if (!result.success) {
    return {
      problems: result.error.issues.map((issue) => {
        const index = issue.path[0] === 'questions' && typeof issue.path[1] === 'number' ? issue.path[1] + 1 : undefined;
        const field = issue.path.slice(index === undefined ? 0 : 2).join('.');
        return { question: index, message: `${field ? `${field}: ` : ''}${issue.message}` };
      }),
    };
  }
  const problems: BankProblem[] = [];
  const seen = new Map<string, number>();
  result.data.questions.forEach((q, i) => {
    const key = questionIdentity(q);
    const earlier = seen.get(key);
    if (earlier !== undefined) problems.push({ question: i + 1, message: `repeats question ${earlier}` });
    seen.set(key, i + 1);
    if (q.type === 'letter' && !/^[a-z]/.test(normalise(q.answer))) problems.push({ question: i + 1, message: 'letter answers must start with a letter A–Z' });
    if (q.type === 'multiple-choice' && /\b(all|none) of the above\b/i.test(q.options.join(' '))) problems.push({ question: i + 1, message: 'avoid "all/none of the above": options get shuffled' });
  });
  return { data: result.data, problems };
}

/** What makes a question "the same" as another: its text, and for ordering questions (whose text is often a stock "put these in order"), its items too. */
export function questionIdentity(q: BankQuestion): string {
  return q.type === 'ordering' ? `${normalise(q.text)}|${q.items.map(normalise).sort().join('|')}` : normalise(q.text);
}

export async function loadBank(dir: string): Promise<{ file: string; data?: BankData; problems: BankProblem[] }[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /\.ya?ml$/i.test(f)).sort();
  return Promise.all(files.map(async (file) => ({ file, ...checkBank(await readFile(join(dir, file), 'utf8')) })));
}

// Searching the bank

export interface BankEntry {
  /** Stable while the files don't change: "<file>#<position>". */
  id: string;
  category: string;
  region: string;
  /** The question as it goes into a quiz (without the bank-only fields). */
  question: Record<string, unknown>;
  type: string;
  text: string;
  difficulty: Difficulty;
  tags: string[];
  source: 'built-in' | 'mine';
}

export interface BankFilter {
  category?: string;
  type?: string;
  difficulty?: string;
  region?: string;
  search?: string;
  source?: string;
}

/** Turns bank files into one flat list. Files with problems are skipped, and reported. */
export function buildEntries(files: Map<string, string>, source: BankEntry['source']): { entries: BankEntry[]; skipped: string[] } {
  const entries: BankEntry[] = [];
  const skipped: string[] = [];
  for (const [file, text] of [...files].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { data, problems } = checkBank(text);
    if (!data || problems.some((p) => p.question === undefined)) {
      skipped.push(file);
      continue;
    }
    data.questions.forEach((q, i) => {
      const { difficulty, tags, ...question } = q;
      entries.push({
        id: `${source === 'mine' ? 'mine:' : ''}${file}#${i}`,
        category: data.category,
        region: data.region,
        question,
        type: q.type,
        text: q.text,
        difficulty,
        tags: tags ?? [],
        source,
      });
    });
  }
  return { entries, skipped };
}

export function filterEntries(entries: BankEntry[], f: BankFilter): BankEntry[] {
  const needle = f.search ? normalise(f.search) : '';
  return entries.filter(
    (e) =>
      (!f.category || e.category === f.category) &&
      (!f.type || e.type === f.type) &&
      (!f.difficulty || e.difficulty === f.difficulty) &&
      (!f.region || e.region === f.region || e.region === 'universal') &&
      (!f.source || e.source === f.source) &&
      (!needle || normalise(e.text).includes(needle) || e.tags.some((t) => normalise(t).includes(needle))),
  );
}

/** `count` entries chosen at random, without repeats. */
export function sample<T>(items: T[], count: number, random: () => number = Math.random): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
  return out;
}

export function summarise(entries: BankEntry[]) {
  const categories = new Map<string, { category: string; count: number; source: string }>();
  for (const e of entries) {
    const key = `${e.source}:${e.category}`;
    const c = categories.get(key) ?? { category: e.category, count: 0, source: e.source };
    c.count++;
    categories.set(key, c);
  }
  const count = (key: 'type' | 'difficulty') => Object.fromEntries([...new Set(entries.map((e) => e[key]))].map((v) => [v, entries.filter((e) => e[key] === v).length]));
  return { total: entries.length, categories: [...categories.values()], types: count('type'), difficulties: count('difficulty') };
}
