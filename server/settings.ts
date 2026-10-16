// Where the app keeps your quizzes, clips and branding, and the one setting you can change in the app: that folder.
import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type FolderSource = 'option' | 'environment' | 'saved' | 'default';

export interface FolderChoice {
  dir: string;
  source: FolderSource;
}

/** The app's own little folder (settings, the internet-link helper). Not where quizzes live. */
export function appHome(): string {
  return process.env['PUBQUIZ_CONFIG_DIR'] || join(homedir(), '.pubquiz');
}

export const defaultLibraryDir = () => join(homedir(), 'PubQuiz');

const configPath = () => join(appHome(), 'config.json');

export async function readSavedLibraryDir(): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), 'utf8')) as { libraryDir?: unknown };
    return typeof parsed.libraryDir === 'string' && isAbsolute(parsed.libraryDir) ? parsed.libraryDir : undefined;
  } catch {
    return undefined;
  }
}

async function writeSavedLibraryDir(dir: string): Promise<void> {
  await mkdir(appHome(), { recursive: true });
  const tmp = `${configPath()}.tmp`;
  await writeFile(tmp, JSON.stringify({ libraryDir: dir }, null, 1));
  await rename(tmp, configPath());
}

/** The command line wins, then PUBQUIZ_HOME, then the folder chosen in the app, then ~/PubQuiz. */
export async function chooseLibraryDir(option: string | undefined): Promise<FolderChoice> {
  if (option) return { dir: resolve(option), source: 'option' };
  const env = process.env['PUBQUIZ_HOME'];
  if (env) return { dir: resolve(env), source: 'environment' };
  const saved = await readSavedLibraryDir();
  if (saved) return { dir: saved, source: 'saved' };
  return { dir: defaultLibraryDir(), source: 'default' };
}

export class SettingsError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const SKIP = new Set(['.trash']);

/** Copies a library's contents (quizzes, pictures, clips, branding, the host key, saved games) without overwriting. */
async function copyLibrary(from: string, to: string): Promise<number> {
  let copied = 0;
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    if (SKIP.has(name)) continue;
    const target = join(to, name);
    if (await stat(target).then(() => true, () => false)) continue; // never overwrite what is already there
    await cp(join(from, name), target, { recursive: true, errorOnExist: false, force: false });
    copied++;
  }
  return copied;
}

/**
 * Saves a new library folder for next time. With `copy`, the current library's contents are copied there first,
 * so the move is safe. The change takes effect when the program is next started.
 */
export async function changeLibraryDir(current: string, requested: string, copy: boolean): Promise<{ dir: string; copied: number }> {
  const text = requested.trim();
  if (!text) throw new SettingsError('Type the folder to use.');
  const expanded = text === '~' ? homedir() : text.startsWith('~/') ? join(homedir(), text.slice(2)) : text;
  if (!isAbsolute(expanded)) throw new SettingsError('Use a full folder path, for example /Users/you/PubQuiz.');
  const dir = resolve(expanded);
  if (dir === resolve('/') || dir === homedir()) throw new SettingsError('Pick a folder just for the quizzes, not your whole home folder.');
  if (dir === current) throw new SettingsError('That is the folder already in use.');
  const inside = (a: string, b: string) => {
    const r = relative(a, b);
    return r !== '' && !r.startsWith('..') && !isAbsolute(r);
  };
  if (inside(current, dir) || inside(dir, current) || dir.startsWith(current + sep)) {
    throw new SettingsError('The new folder cannot be inside the current one, or the other way round.');
  }
  try {
    await mkdir(dir, { recursive: true });
    const info = await stat(dir);
    if (!info.isDirectory()) throw new Error('not a folder');
    const probe = join(dir, '.write-test');
    await writeFile(probe, '');
    await (await import('node:fs/promises')).rm(probe);
  } catch {
    throw new SettingsError("That folder can't be created or written to. Check the path and permissions.");
  }
  const copied = copy ? await copyLibrary(current, dir) : 0;
  await writeSavedLibraryDir(dir);
  return { dir, copied };
}
