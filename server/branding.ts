// Branding: a name, tagline, two colours and a logo that the team, host and TV pages all pick up.
// Stored as branding.json plus an optional logo file in one folder, so it can be copied between machines.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { IMAGE_TYPES } from './quiz.ts';

export interface BrandingConfig {
  /** Shown beside the logo, and as the page title. */
  name: string;
  tagline: string;
  /** Buttons and highlights, as #rgb or #rrggbb. */
  accent: string;
  /** Page background, as #rgb or #rrggbb. */
  background: string;
  /** Write the name out under the logo. Turn off if the logo already has the name in it. */
  showName: boolean;
}

/** What pages are told: the config plus where the logo is (if there is one). */
export interface BrandingInfo extends BrandingConfig {
  logo?: string;
}

export const DEFAULT_BRANDING: BrandingConfig = { name: '', tagline: '', accent: '#f5b83d', background: '#14161f', showName: true };

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MAX_NAME = 40;
const MAX_TAGLINE = 80;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const CONFIG_FILE = 'branding.json';

export class BrandingError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function bad(message: string): never {
  throw new BrandingError(message);
}

/** Tidies text for display: no control or invisible characters, single spaces. */
function tidy(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new BrandingError(`${label} must be text.`);
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim();
  if ([...text].length > max) throw new BrandingError(`${label} can be at most ${max} characters.`);
  return text;
}

function colour(value: unknown, fallback: string, label: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !HEX.test(value.trim())) throw new BrandingError(`${label} must be a colour like #f5b83d.`);
  const hex = value.trim().toLowerCase();
  // Always the long form, so pages can parse it simply.
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

/** Checks branding sent by the editor (or read from disk) and fills in defaults. Throws a BrandingError with a plain-English reason. */
export function validateBranding(input: unknown): BrandingConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BrandingError('That is not a branding setup.');
  const raw = input as Record<string, unknown>;
  return {
    name: tidy(raw.name, MAX_NAME, 'The name'),
    tagline: tidy(raw.tagline, MAX_TAGLINE, 'The tagline'),
    accent: colour(raw.accent, DEFAULT_BRANDING.accent, 'The accent colour'),
    background: colour(raw.background, DEFAULT_BRANDING.background, 'The background colour'),
    showName: raw.showName === undefined || raw.showName === null ? true : typeof raw.showName === 'boolean' ? raw.showName : bad('showName must be true or false.'),
  };
}

export class BrandingStore {
  readonly dir: string;
  private readOnly: boolean;

  constructor(dir: string, { readOnly = false } = {}) {
    this.dir = dir;
    this.readOnly = readOnly;
  }

  get editable(): boolean {
    return !this.readOnly;
  }

  async config(): Promise<BrandingConfig> {
    try {
      return validateBranding(JSON.parse(await readFile(join(this.dir, CONFIG_FILE), 'utf8')));
    } catch {
      return { ...DEFAULT_BRANDING };
    }
  }

  /** The logo file, if there is one, with a version that changes when it does (so browsers refresh it). */
  async logo(): Promise<{ data: Buffer; contentType: string; version: string } | undefined> {
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const ext = extname(name).toLowerCase();
      if (name !== `logo${ext}` || !IMAGE_TYPES[ext]) continue;
      const path = join(this.dir, name);
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      return { data: await readFile(path), contentType: IMAGE_TYPES[ext]!, version: `${Math.round(info.mtimeMs)}-${info.size}` };
    }
    return undefined;
  }

  async info(): Promise<BrandingInfo> {
    const [config, logo] = await Promise.all([this.config(), this.logo()]);
    return { ...config, ...(logo ? { logo: `/branding/logo?v=${logo.version}` } : {}) };
  }

  private check(): void {
    if (this.readOnly) throw new BrandingError('This branding folder is read-only. Edit its files directly.', 403);
  }

  async save(input: unknown): Promise<BrandingConfig> {
    this.check();
    const config = validateBranding(input);
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, CONFIG_FILE);
    await writeFile(`${path}.tmp`, JSON.stringify(config, null, 2));
    await rename(`${path}.tmp`, path);
    return config;
  }

  async setLogo(filename: string, data: Uint8Array): Promise<void> {
    this.check();
    const ext = extname(filename).toLowerCase();
    if (!IMAGE_TYPES[ext]) throw new BrandingError(`Use a ${Object.keys(IMAGE_TYPES).join(', ')} image.`);
    if (data.length === 0) throw new BrandingError('That file is empty.');
    if (data.length > MAX_LOGO_BYTES) throw new BrandingError('The logo can be at most 2 MB.', 413);
    await mkdir(this.dir, { recursive: true });
    await this.removeLogo();
    await writeFile(join(this.dir, `logo${ext}`), data);
  }

  async removeLogo(): Promise<void> {
    this.check();
    for (const ext of Object.keys(IMAGE_TYPES)) await rm(join(this.dir, `logo${ext}`), { force: true });
  }
}
