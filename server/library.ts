// The host's quiz library: one folder per quiz (quiz.yaml plus images/), which is also the zip export format.
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { checkQuiz, IMAGE_TYPES, type QuizIssue } from './quiz.ts';
import { readSession } from './session.ts';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;
export const MAX_IMAGE_UPLOAD = 10 * 1024 * 1024;
export const MAX_IMPORT = 60 * 1024 * 1024;
const QUIZ_FILE = 'quiz.yaml';
const SESSION_FILE = 'quiz.session.json';

export class LibraryError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface QuizSummary {
  id: string;
  title: string;
  rounds: number;
  questions: number;
  problems: number;
  updatedAt: string;
  /** An unfinished game that can be resumed. */
  unfinished?: { question: number; total: number };
}

export interface QuizDraft {
  title?: unknown;
  rounds?: unknown;
  [key: string]: unknown;
}

const BLANK: QuizDraft = {
  title: 'New quiz',
  rounds: [
    {
      name: 'Round 1',
      questions: [{ type: 'multiple-choice', text: '', options: ['', '', '', ''], answer: 0 }],
    },
  ],
};

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'quiz'
  );
}

/** Image paths a draft refers to, relative to its folder. */
function referencedImages(draft: QuizDraft): string[] {
  const images = new Set<string>();
  for (const round of Array.isArray(draft.rounds) ? draft.rounds : []) {
    for (const q of Array.isArray(round?.questions) ? round.questions : []) {
      if (typeof q?.image === 'string' && q.image.startsWith('images/')) images.add(q.image);
    }
  }
  return [...images];
}

export class Library {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private folder(id: string): string {
    if (!ID.test(id)) throw new LibraryError('No such quiz.', 404);
    return join(this.dir, id);
  }

  quizPath(id: string): string {
    return join(this.folder(id), QUIZ_FILE);
  }

  sessionPath(id: string): string {
    return join(this.folder(id), SESSION_FILE);
  }

  private async exists(id: string): Promise<boolean> {
    return stat(this.quizPath(id)).then(
      () => true,
      () => false,
    );
  }

  private async newId(title: string): Promise<string> {
    const base = slugify(title);
    for (;;) {
      const id = `${base}-${randomBytes(2).toString('hex')}`;
      if (!(await this.exists(id))) return id;
    }
  }

  async list(): Promise<QuizSummary[]> {
    await mkdir(this.dir, { recursive: true });
    const summaries: QuizSummary[] = [];
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue;
      try {
        const { draft, issues } = await this.read(entry.name);
        const rounds = Array.isArray(draft.rounds) ? draft.rounds : [];
        const session = await readSession(this.sessionPath(entry.name));
        const total = rounds.reduce((n, r) => n + (Array.isArray(r?.questions) ? r.questions.length : 0), 0);
        summaries.push({
          id: entry.name,
          title: typeof draft.title === 'string' && draft.title.trim() ? draft.title : 'Untitled quiz',
          rounds: rounds.length,
          questions: total,
          problems: issues.length,
          updatedAt: (await stat(this.quizPath(entry.name))).mtime.toISOString(),
          unfinished:
            session && session.game.phase !== 'finished' && session.game.phase !== 'lobby'
              ? { question: session.game.questionIndex + 1, total }
              : undefined,
        });
      } catch {
        // Not a quiz folder.
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(): Promise<string> {
    return this.write(await this.newId('new quiz'), structuredClone(BLANK));
  }

  async read(id: string): Promise<{ draft: QuizDraft; issues: QuizIssue[]; images: string[] }> {
    let source: string;
    try {
      source = await readFile(this.quizPath(id), 'utf8');
    } catch {
      throw new LibraryError('No such quiz.', 404);
    }
    let draft: QuizDraft;
    try {
      const parsed = parseYaml(source);
      draft = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      return { draft: {}, issues: [{ path: [], message: `Not valid YAML: ${(error as Error).message}` }], images: [] };
    }
    const images = await readdir(join(this.folder(id), 'images')).catch(() => [] as string[]);
    return { draft, issues: checkQuiz(draft).issues, images: images.filter((n) => IMAGE_NAME.test(n)).map((n) => `images/${n}`) };
  }

  /** Saves a draft even if it has problems (the editor autosaves work in progress) and returns them. */
  async save(id: string, draft: QuizDraft): Promise<QuizIssue[]> {
    if (!(await this.exists(id))) throw new LibraryError('No such quiz.', 404);
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new LibraryError('That is not a quiz.');
    await this.write(id, draft);
    return checkQuiz(draft).issues;
  }

  private async write(id: string, draft: QuizDraft): Promise<string> {
    await mkdir(this.folder(id), { recursive: true });
    const path = this.quizPath(id);
    await writeFile(`${path}.tmp`, stringifyYaml(draft, { lineWidth: 0 }));
    await rename(`${path}.tmp`, path);
    return id;
  }

  async duplicate(id: string): Promise<string> {
    const { draft } = await this.read(id);
    const title = typeof draft.title === 'string' ? draft.title : 'quiz';
    const copy = await this.newId(title);
    await this.write(copy, { ...draft, title: `${title} (copy)` });
    for (const image of referencedImages(draft)) {
      const data = await readFile(join(this.folder(id), image)).catch(() => undefined);
      if (data) await this.putFile(copy, image, data);
    }
    return copy;
  }

  /** Deleted quizzes go to a .trash folder rather than vanishing. */
  async remove(id: string): Promise<void> {
    if (!(await this.exists(id))) throw new LibraryError('No such quiz.', 404);
    const trash = join(this.dir, '.trash');
    await mkdir(trash, { recursive: true });
    await rename(this.folder(id), join(trash, `${id}-${Date.now()}`));
  }

  private async putFile(id: string, relative: string, data: Uint8Array): Promise<void> {
    const dir = join(this.folder(id), 'images');
    await mkdir(dir, { recursive: true });
    await writeFile(join(this.folder(id), relative), data);
  }

  async addImage(id: string, filename: string, data: Uint8Array): Promise<string> {
    if (!(await this.exists(id))) throw new LibraryError('No such quiz.', 404);
    const ext = extname(filename).toLowerCase();
    if (!IMAGE_TYPES[ext]) throw new LibraryError(`Use a ${Object.keys(IMAGE_TYPES).join(', ')} image.`);
    if (data.length > MAX_IMAGE_UPLOAD) throw new LibraryError('Images can be at most 10 MB.');
    const stem = slugify(filename.slice(0, -ext.length)).slice(0, 40) || 'image';
    const existing = new Set(await readdir(join(this.folder(id), 'images')).catch(() => [] as string[]));
    let name = `${stem}${ext}`;
    for (let n = 2; existing.has(name); n++) name = `${stem}-${n}${ext}`;
    await this.putFile(id, `images/${name}`, data);
    return `images/${name}`;
  }

  async image(id: string, name: string): Promise<{ data: Buffer; contentType: string }> {
    const contentType = IMAGE_TYPES[extname(name).toLowerCase()];
    if (!IMAGE_NAME.test(name) || !contentType) throw new LibraryError('No such image.', 404);
    try {
      return { data: await readFile(join(this.folder(id), 'images', name)), contentType };
    } catch {
      throw new LibraryError('No such image.', 404);
    }
  }

  async exportYaml(id: string): Promise<string> {
    return readFile(this.quizPath(id), 'utf8').catch(() => {
      throw new LibraryError('No such quiz.', 404);
    });
  }

  /** quiz.yaml plus the images it uses. */
  async exportZip(id: string): Promise<Uint8Array> {
    const source = await this.exportYaml(id);
    const { draft } = await this.read(id);
    const files: Record<string, Uint8Array> = { [QUIZ_FILE]: new TextEncoder().encode(source) };
    for (const image of referencedImages(draft)) {
      const data = await readFile(join(this.folder(id), image)).catch(() => undefined);
      if (data) files[image] = data;
    }
    return zipSync(files, { level: 6 });
  }

  /** Adds a quiz from a .yaml file, or a .zip of quiz.yaml plus images/. Returns its id and any problems. */
  async importFile(filename: string, data: Uint8Array): Promise<{ id: string; issues: QuizIssue[] }> {
    if (data.length > MAX_IMPORT) throw new LibraryError('That file is too big (60 MB at most).');
    const lower = filename.toLowerCase();
    let source: string;
    const images: [string, Uint8Array][] = [];

    if (lower.endsWith('.zip')) {
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(data, {
          // Only take the files a quiz bundle can contain; nothing else is extracted.
          filter: (file) => file.originalSize <= MAX_IMAGE_UPLOAD && this.bundlePath(file.name) !== undefined,
        });
      } catch {
        throw new LibraryError("That zip file couldn't be read.");
      }
      let yamlEntry: Uint8Array | undefined;
      for (const [name, content] of Object.entries(entries)) {
        const path = this.bundlePath(name);
        if (path === QUIZ_FILE) yamlEntry = content;
        else if (path) images.push([path, content]);
      }
      if (!yamlEntry) throw new LibraryError('The zip file needs a quiz.yaml.');
      source = strFromU8(yamlEntry);
    } else if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
      source = new TextDecoder().decode(data);
    } else {
      throw new LibraryError('Import a .yaml file or a .zip with quiz.yaml and images.');
    }

    let draft: QuizDraft;
    try {
      const parsed = parseYaml(source);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a quiz');
      draft = parsed;
    } catch (error) {
      throw new LibraryError(`That file isn't a valid quiz: ${(error as Error).message}`);
    }

    const id = await this.newId(typeof draft.title === 'string' ? draft.title : 'imported quiz');
    await mkdir(this.folder(id), { recursive: true });
    // Keep the original text (and its comments) rather than re-writing it.
    await writeFile(this.quizPath(id), source);
    for (const [path, content] of images) await this.putFile(id, path, content);
    return { id, issues: checkQuiz(draft).issues };
  }

  /**
   * Maps a zip entry to where it goes in a quiz folder, or undefined to skip it. Accepts files at the
   * top level or inside one wrapping folder (as zipping a folder produces), and never anything outside.
   */
  private bundlePath(name: string): string | undefined {
    const parts = name.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.some((p) => p === '..' || p.startsWith('.'))) return undefined;
    const rest = parts.length >= 2 && parts[0] !== 'images' ? parts.slice(1) : parts;
    if (rest.length === 1 && rest[0] === QUIZ_FILE) return QUIZ_FILE;
    if (rest.length === 2 && rest[0] === 'images') {
      // Keep the name exactly as quiz.yaml refers to it.
      const file = rest[1]!;
      if (IMAGE_NAME.test(file) && IMAGE_TYPES[extname(file).toLowerCase()]) return `images/${file}`;
    }
    return undefined;
  }
}
