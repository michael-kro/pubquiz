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

/** Anything the pages and the editor can read branding from and (maybe) change: one folder, or the active profile. */
export interface BrandingSource {
  readonly editable: boolean;
  config(): Promise<BrandingConfig>;
  logo(): Promise<{ data: Buffer; contentType: string; version: string } | undefined>;
  info(): Promise<BrandingInfo>;
  save(input: unknown): Promise<BrandingConfig>;
  setLogo(filename: string, data: Uint8Array): Promise<void>;
  removeLogo(): Promise<void>;
}

export interface BrandingProfileSummary {
  id: string;
  /** The venue's name as set in the profile (the folder name if it has none yet). */
  label: string;
}

const PROFILES_FILE = 'profiles.json';
const DEFAULT_PROFILE = 'default';
const MAX_PROFILES = 30;

/** "The Thirsty Bear, Warwick" → "the-thirsty-bear-warwick" */
export function profileId(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Several branding setups ("profiles", one per venue) kept side by side in one folder, one of them active.
 * Each profile is an ordinary branding folder (branding.json and a logo) inside <root>/<id>/. The active
 * profile is what every page shows; switching is one click. It looks like a single BrandingStore to the rest of the program.
 */
export class BrandingProfiles implements BrandingSource {
  readonly root: string;
  private activeId = DEFAULT_PROFILE;
  private ready: Promise<void> | undefined;

  constructor(root: string) {
    this.root = root;
  }

  /** Reads the profile list, and on first use moves a plain single branding setup into a profile called "default". */
  init(): Promise<void> {
    this.ready ??= this.load();
    return this.ready;
  }

  private async load(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const profiles = entries.filter((e) => e.isDirectory() && /^[a-z0-9-]+$/.test(e.name) && e.name !== 'original');
    const legacy = entries.some((e) => e.isFile() && (e.name === CONFIG_FILE || /^logo\.\w+$/.test(e.name)));
    if (legacy) {
      // The old layout: branding.json and the logo straight in the folder. They become the "default" profile.
      const target = join(this.root, DEFAULT_PROFILE);
      await mkdir(target, { recursive: true });
      for (const e of entries) {
        const isLegacyFile = e.isFile() && (e.name === CONFIG_FILE || /^logo\.\w+$/.test(e.name));
        const isOriginal = e.isDirectory() && e.name === 'original';
        if (isLegacyFile || isOriginal) await rename(join(this.root, e.name), join(target, e.name));
      }
    } else if (profiles.length === 0) {
      await mkdir(join(this.root, DEFAULT_PROFILE), { recursive: true });
    }
    let saved: string | undefined;
    try {
      saved = (JSON.parse(await readFile(join(this.root, PROFILES_FILE), 'utf8')) as { active?: unknown }).active as string | undefined;
    } catch {
      saved = undefined;
    }
    const ids = await this.ids();
    this.activeId = saved && ids.includes(saved) ? saved : ids.includes(DEFAULT_PROFILE) ? DEFAULT_PROFILE : ids[0]!;
    await this.writeActive();
  }

  private async ids(): Promise<string[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory() && /^[a-z0-9-]+$/.test(e.name) && e.name !== 'original').map((e) => e.name).sort();
  }

  private async writeActive(): Promise<void> {
    const path = join(this.root, PROFILES_FILE);
    await writeFile(`${path}.tmp`, JSON.stringify({ active: this.activeId }, null, 2));
    await rename(`${path}.tmp`, path);
  }

  private store(id = this.activeId): BrandingStore {
    return new BrandingStore(join(this.root, id));
  }

  get active(): string {
    return this.activeId;
  }

  get editable(): boolean {
    return true;
  }

  async list(): Promise<BrandingProfileSummary[]> {
    await this.init();
    const ids = await this.ids();
    return Promise.all(ids.map(async (id) => ({ id, label: (await this.store(id).config()).name || id })));
  }

  private async existing(id: unknown): Promise<string> {
    await this.init();
    if (typeof id !== 'string' || !(await this.ids()).includes(id)) throw new BrandingError('There is no branding profile like that.', 404);
    return id;
  }

  async activate(id: unknown): Promise<void> {
    this.activeId = await this.existing(id);
    await this.writeActive();
  }

  /** Makes a profile for a venue, empty or copied from another, and returns its id. It does not become active by itself. */
  async create(name: unknown, copyFrom?: unknown): Promise<string> {
    await this.init();
    const venue = tidy(name, MAX_NAME, 'The name');
    const base = profileId(venue);
    if (!base) throw new BrandingError('Give the profile a name.');
    const ids = await this.ids();
    if (ids.length >= MAX_PROFILES) throw new BrandingError(`There can be at most ${MAX_PROFILES} profiles.`);
    let id = base;
    for (let n = 2; ids.includes(id); n++) id = `${base}-${n}`;
    const from = copyFrom ? await this.existing(copyFrom) : undefined;
    const target = this.store(id);
    if (from) {
      await mkdir(target.dir, { recursive: true });
      const source = this.store(from);
      const logo = await source.logo();
      await target.save({ ...(await source.config()), name: venue });
      if (logo) {
        const ext = (await readdir(source.dir)).find((f) => /^logo\.\w+$/.test(f));
        if (ext) await writeFile(join(target.dir, ext), logo.data);
      }
    } else {
      await target.save({ ...DEFAULT_BRANDING, name: venue });
    }
    return id;
  }

  /** Deletes a profile. The last one cannot go; deleting the active one switches to another. */
  async remove(id: unknown): Promise<void> {
    const target = await this.existing(id);
    const ids = await this.ids();
    if (ids.length <= 1) throw new BrandingError('That is the only profile, so it cannot be deleted.');
    await rm(join(this.root, target), { recursive: true, force: true });
    if (this.activeId === target) {
      this.activeId = ids.find((other) => other !== target)!;
      await this.writeActive();
    }
  }

  async config(): Promise<BrandingConfig> {
    await this.init();
    return this.store().config();
  }
  async logo() {
    await this.init();
    return this.store().logo();
  }
  async info(): Promise<BrandingInfo> {
    await this.init();
    return this.store().info();
  }
  async save(input: unknown): Promise<BrandingConfig> {
    await this.init();
    return this.store().save(input);
  }
  async setLogo(filename: string, data: Uint8Array): Promise<void> {
    await this.init();
    return this.store().setLogo(filename, data);
  }
  async removeLogo(): Promise<void> {
    await this.init();
    return this.store().removeLogo();
  }
}
