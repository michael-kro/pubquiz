#!/usr/bin/env node
// Checks question bank files and prints a summary:   node scripts/validate-bank.ts [file.yaml …]   (default: every file in bank/)
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { checkBank, loadBank } from '../server/bank.ts';

const files = process.argv.slice(2);
const results = files.length
  ? await Promise.all(files.map(async (f) => ({ file: basename(f), ...checkBank(await readFile(f, 'utf8')) })))
  : await loadBank(new URL('../bank/', import.meta.url).pathname);

let bad = 0;
const totals: Record<string, number> = {};
for (const { file, data, problems } of results) {
  const counts: Record<string, number> = {};
  for (const q of data?.questions ?? []) {
    counts[q.type] = (counts[q.type] ?? 0) + 1;
    counts[q.difficulty] = (counts[q.difficulty] ?? 0) + 1;
    totals[q.type] = (totals[q.type] ?? 0) + 1;
  }
  console.log(`${problems.length ? '✖' : '✔'} ${file}: ${data?.questions.length ?? 0} questions ${JSON.stringify(counts)}`);
  for (const p of problems) console.log(`    ${p.question ? `question ${p.question}: ` : ''}${p.message}`);
  bad += problems.length;
}
console.log(`\n${results.length} files, ${Object.values(totals).reduce((a, b) => a + b, 0)} questions ${JSON.stringify(totals)}, ${bad} problems`);
process.exit(bad ? 1 : 0);
