// The host's soundboard: audio clips kept in a folder, to play whenever the host likes (not tied to a question).
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { AUDIO_TYPES } from './quiz.ts';

export const MAX_CLIP_BYTES = 20 * 1024 * 1024;
const MAX_CLIPS = 300;
const NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/;

export interface Clip {
  name: string;
  title: string;
  size: number;
}

export class ClipError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const slug = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Tidy a file name into a readable title: "the-big-one_v2.mp3" becomes "The big one v2". */
function titleFromName(filename: string): string {
  // Only the last part of a path: a title never shows folders, however the file was named.
  const bare = filename.split(/[\\/]/).pop() ?? filename;
  const stem = bare.slice(0, bare.length - extname(bare).length).replace(/[-_]+/g, ' ').trim();
  return (stem.charAt(0).toUpperCase() + stem.slice(1)).slice(0, 80) || 'Clip';
}

export class ClipStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  private async titles(): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await readFile(join(this.dir, 'clips.json'), 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private async saveTitles(titles: Record<string, string>): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, 'clips.json'), JSON.stringify(titles, null, 1));
  }

  async list(): Promise<Clip[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => NAME.test(f) && AUDIO_TYPES[extname(f).toLowerCase()]);
    const titles = await this.titles();
    const clips = await Promise.all(
      files.map(async (name) => ({ name, title: typeof titles[name] === 'string' ? titles[name]! : titleFromName(name), size: (await stat(join(this.dir, name))).size })),
    );
    return clips.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
  }

  async add(filename: string, data: Uint8Array, title?: string): Promise<Clip> {
    const ext = extname(filename).toLowerCase();
    if (!AUDIO_TYPES[ext]) throw new ClipError(`Use a ${Object.keys(AUDIO_TYPES).join(', ')} file.`);
    if (data.length === 0) throw new ClipError('That file is empty.');
    if (data.length > MAX_CLIP_BYTES) throw new ClipError('Clips can be at most 20 MB.', 413);
    const existing = new Set(await readdir(this.dir).catch(() => [] as string[]));
    if ([...existing].filter((f) => AUDIO_TYPES[extname(f).toLowerCase()]).length >= MAX_CLIPS) throw new ClipError(`That is the most clips there is room for (${MAX_CLIPS}).`);
    const stem = slug(filename.slice(0, filename.length - ext.length)).slice(0, 60) || 'clip';
    let name = `${stem}${ext}`;
    for (let n = 2; existing.has(name); n++) name = `${stem}-${n}${ext}`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, name), data);
    const cleanTitle = (title ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 80) || titleFromName(filename);
    const titles = await this.titles();
    titles[name] = cleanTitle;
    await this.saveTitles(titles);
    return { name, title: cleanTitle, size: data.length };
  }

  async remove(name: string): Promise<void> {
    if (!NAME.test(name) || !AUDIO_TYPES[extname(name).toLowerCase()]) throw new ClipError('No such clip.', 404);
    try {
      await rm(join(this.dir, name));
    } catch {
      throw new ClipError('No such clip.', 404);
    }
    const titles = await this.titles();
    delete titles[name];
    await this.saveTitles(titles);
  }

  async read(name: string): Promise<{ data: Buffer; contentType: string }> {
    const contentType = AUDIO_TYPES[extname(name).toLowerCase()];
    if (!NAME.test(name) || !contentType) throw new ClipError('No such clip.', 404);
    try {
      return { data: await readFile(join(this.dir, name)), contentType };
    } catch {
      throw new ClipError('No such clip.', 404);
    }
  }

  async has(name: string): Promise<boolean> {
    return NAME.test(name) && (await stat(join(this.dir, name)).then(() => true, () => false));
  }
}
