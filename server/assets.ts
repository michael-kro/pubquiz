// The browser pages and the sample quiz, read from disk when running from source, or from the copy
// baked into a single-file program.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMBEDDED } from './embedded.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const EXAMPLES_DIR = join(ROOT, 'examples');
const embedded = Object.keys(EMBEDDED).length > 0;

/** A file under public/, or undefined if there's no such file (or it tries to escape the folder). */
export async function readPublicFile(path: string): Promise<Buffer | undefined> {
  if (embedded) {
    const data = EMBEDDED[`public/${path}`];
    return data === undefined ? undefined : Buffer.from(data, 'base64');
  }
  const file = resolve(PUBLIC_DIR, path);
  if (!file.startsWith(PUBLIC_DIR + sep)) return undefined;
  return readFile(file).catch(() => undefined);
}

/** The files of the sample quiz, with paths relative to the quiz folder (quiz.yaml, images/…). */
export async function sampleQuizFiles(): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  if (embedded) {
    for (const [key, data] of Object.entries(EMBEDDED)) {
      if (!key.startsWith('examples/')) continue;
      const path = key.slice('examples/'.length);
      files.set(path === 'sample-quiz.yaml' ? 'quiz.yaml' : path, Buffer.from(data, 'base64'));
    }
    return files;
  }
  files.set('quiz.yaml', await readFile(join(EXAMPLES_DIR, 'sample-quiz.yaml')));
  for (const name of await readdir(join(EXAMPLES_DIR, 'images')).catch(() => [] as string[])) {
    files.set(`images/${name}`, await readFile(join(EXAMPLES_DIR, 'images', name)));
  }
  return files;
}

/** Every file to embed, as [key, absolute path]. Used by the build script. */
export async function listEmbeddable(): Promise<[string, string][]> {
  const found: [string, string][] = [];
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, prefix);
      else found.push([`${prefix}/${relative(prefix === 'public' ? PUBLIC_DIR : EXAMPLES_DIR, full).split(sep).join('/')}`, full]);
    }
  };
  await walk(PUBLIC_DIR, 'public');
  await walk(EXAMPLES_DIR, 'examples');
  return found.filter(([key]) => !key.endsWith('.session.json') && !key.includes('.results-'));
}
