// The browser pages, the sample quiz, the question bank and the fun facts, read from the app's own folders.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const EXAMPLES_DIR = join(ROOT, 'examples');
const BANK_DIR = join(ROOT, 'bank');
const FACTS_DIR = join(ROOT, 'facts');

/** A file under public/, or undefined if there's no such file (or it tries to escape the folder). */
export async function readPublicFile(path: string): Promise<Buffer | undefined> {
  const file = resolve(PUBLIC_DIR, path);
  if (!file.startsWith(PUBLIC_DIR + sep)) return undefined;
  return readFile(file).catch(() => undefined);
}

/** The files of the sample quiz, with paths relative to the quiz folder (quiz.yaml, images/…). */
export async function sampleQuizFiles(): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  files.set('quiz.yaml', await readFile(join(EXAMPLES_DIR, 'sample-quiz.yaml')));
  for (const name of await readdir(join(EXAMPLES_DIR, 'images')).catch(() => [] as string[])) {
    files.set(`images/${name}`, await readFile(join(EXAMPLES_DIR, 'images', name)));
  }
  return files;
}

/** The built-in question bank: file name → YAML text. */
export async function bundledBankFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of await readdir(BANK_DIR).catch(() => [] as string[])) {
    if (/\.ya?ml$/i.test(name) && name !== 'example.yaml') files.set(name, await readFile(join(BANK_DIR, name), 'utf8'));
  }
  return files;
}

/** The built-in fun facts: file name → YAML text. */
export async function bundledFactFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of await readdir(FACTS_DIR).catch(() => [] as string[])) {
    if (/\.ya?ml$/i.test(name)) files.set(name, await readFile(join(FACTS_DIR, name), 'utf8'));
  }
  return files;
}
