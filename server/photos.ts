// Team photos: kept in memory and in a file beside the saved game, separate from it so the game
// file stays small and rewriting it after every answer never means rewriting every photo.
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createSaver } from './session.ts';

export const MAX_PHOTO_BYTES = 150 * 1024;

/** What kind of image these bytes really are, judged by their first bytes (never by what the uploader claims). */
export function sniffImage(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  const b = bytes;
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' && String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WEBP') return 'image/webp';
  return undefined;
}

interface Photo {
  data: Buffer;
  contentType: string;
  version: number;
}

export class PhotoStore {
  private readonly photos = new Map<string, Photo>();
  private readonly saver?: ReturnType<typeof createSaver>;
  private counter = 0;

  /** With a path, photos are saved there as they change. */
  constructor(path?: string) {
    if (path) {
      this.saver = createSaver(async () => {
        const json = JSON.stringify(Object.fromEntries([...this.photos].map(([id, p]) => [id, { v: p.version, t: p.contentType, d: p.data.toString('base64') }])));
        await writeFile(`${path}.tmp`, json);
        await rename(`${path}.tmp`, path);
      }, 500);
    }
  }

  static async load(path: string): Promise<PhotoStore> {
    const store = new PhotoStore(path);
    try {
      const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, { v: number; t: string; d: string }>;
      for (const [id, p] of Object.entries(saved)) {
        const data = Buffer.from(p.d, 'base64');
        const contentType = sniffImage(data);
        if (contentType && data.length <= MAX_PHOTO_BYTES) {
          store.photos.set(id, { data, contentType, version: p.v });
          store.counter = Math.max(store.counter, p.v);
        }
      }
    } catch {
      // No saved photos yet.
    }
    return store;
  }

  /** Stores a photo and returns its version (changes every time, so browsers fetch the new one). */
  set(teamId: string, data: Buffer, contentType: string): number {
    const version = ++this.counter;
    this.photos.set(teamId, { data, contentType, version });
    this.saver?.schedule();
    return version;
  }

  /** Forgets every photo (a new game) and overwrites any old file. */
  reset(): void {
    this.photos.clear();
    this.saver?.schedule();
  }

  remove(teamId: string): boolean {
    const had = this.photos.delete(teamId);
    if (had) this.saver?.schedule();
    return had;
  }

  get(teamId: string): Photo | undefined {
    return this.photos.get(teamId);
  }

  /** teamId → version, for restoring a game's view of who has a photo. */
  versions(): Map<string, number> {
    return new Map([...this.photos].map(([id, p]) => [id, p.version]));
  }

  flush(): Promise<void> {
    return this.saver?.flush() ?? Promise.resolve();
  }
}
