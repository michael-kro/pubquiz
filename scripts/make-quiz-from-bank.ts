#!/usr/bin/env node
// Builds a quiz folder from bank questions, e.g. for a venue's first night:
//   node scripts/make-quiz-from-bank.ts <out-folder> "<title>"
// Rounds are defined below; edit them and re-run for a different mix.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { bundledBankFiles } from '../server/assets.ts';
import { buildEntries, filterEntries, sample, type BankEntry } from '../server/bank.ts';
import { parseQuiz } from '../server/quiz.ts';

const [outDir, title = 'Quiz Night'] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node scripts/make-quiz-from-bank.ts <out-folder> "<title>"');
  process.exit(1);
}

const { entries } = buildEntries(await bundledBankFiles(), 'built-in');
const used = new Set<string>();

/** n questions from a category, easy and medium mostly, with a spread of types, not used before. */
function pick(category: string, n: number, filter: { type?: string; difficulty?: string } = {}): BankEntry[] {
  const pool = filterEntries(entries, { category, ...filter }).filter((e) => !used.has(e.id) && e.difficulty !== 'hard');
  const picked = sample(pool, n);
  for (const e of picked) used.add(e.id);
  return picked;
}

const rounds = [
  {
    name: 'General Knowledge',
    questions: [...pick('General Knowledge', 3), ...pick('Science & Nature', 2), ...pick('Geography', 2), ...pick('History', 2), ...pick('General Knowledge', 1, { type: 'ordering' })],
  },
  {
    name: 'Screen and Sound',
    questions: [...pick('Film', 3), ...pick('Television', 3), ...pick('Music', 3), ...pick('Music', 1, { type: 'ordering' })],
  },
  {
    name: 'Pub Life',
    questions: [...pick('Food & Drink', 3), ...pick('Sport', 3), ...pick('Animals', 2), ...pick('Words & Language', 1), ...pick('Sport', 1, { type: 'number' })],
  },
  {
    name: 'Bonus: Nearest Wins',
    questions: pick('Geography', 1, { type: 'nearest' }),
  },
];

const draft = {
  title,
  scoring: { mode: 'speed', speedFactor: 0.5, fastBonus: 250, fastPlaces: 3, leaderboard: 'round' },
  rounds: rounds.map((r) => ({ name: r.name, questions: r.questions.map((e) => ({ ...e.question })) })),
};
parseQuiz(stringify(draft)); // Fails loudly if anything picked isn't a valid quiz question.

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'quiz.yaml'), `# Built from the question bank. Open it in the editor to change anything.\n${stringify(draft, { lineWidth: 0 })}`);
console.log(`${title}: ${draft.rounds.map((r) => `${r.name} (${r.questions.length})`).join(', ')}`);
for (const r of rounds) {
  console.log(`\n== ${r.name}`);
  for (const e of r.questions) {
    const q = e.question as Record<string, unknown> & { options?: string[]; answer?: number | string; items?: string[] };
    const a = q.options ? `${q.options[q.answer as number]}` : q.items ? q.items.join(' > ') : q.answer;
    console.log(`  [${e.type}/${e.difficulty}] ${e.text}  =>  ${a}`);
  }
}
