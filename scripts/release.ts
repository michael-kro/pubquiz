// The release helper. `npm run release` cuts a release; .github/workflows/publish.yml publishes it once it is on main.
//   node scripts/release.ts cut [bump] [--dry-run]          from an up-to-date main: prepare, commit on release/vX.Y.Z, push, open the pull request
//   node scripts/release.ts next [minor|patch|major|auto]   the version a release now would get (auto: minor if anything is unreleased)
//   node scripts/release.ts unreleased                      the unreleased changelog lines (exit 1 if there are none)
//   node scripts/release.ts prepare [bump] [--dry-run]      cut the changelog section, set the version in package.json and the lock file
//   node scripts/release.ts notes <version>                 the changelog section for a version, as release notes
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Bump = 'minor' | 'patch' | 'major' | 'auto';

export function bumpVersion(current: string, bump: Exclude<Bump, 'auto'>): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current.trim());
  if (!m) throw new Error(`Not a version: ${current}`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The lines under "## Unreleased", without the heading or blank lines around it. */
export function unreleasedLines(changelog: string): string[] {
  const m = /^## Unreleased\s*\n([\s\S]*?)(?=^## |\Z)/m.exec(changelog) ?? /^## Unreleased\s*\n([\s\S]*)$/m.exec(changelog);
  return m ? m[1]!.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()) : [];
}

/** Renames "Unreleased" to the version and date, and starts a fresh empty "Unreleased" above it. */
export function cutChangelog(changelog: string, version: string, date: string): { changelog: string; notes: string } {
  const lines = unreleasedLines(changelog);
  if (!lines.length) throw new Error('Nothing under "Unreleased" in CHANGELOG.md: nothing to release.');
  const heading = `## ${version} — ${date}`;
  const body = lines.join('\n');
  const next = changelog.replace(/^## Unreleased\s*\n[\s\S]*?(?=^## |(?![\s\S]))/m, `## Unreleased\n\n${heading}\n\n${body}\n\n`);
  return { changelog: next.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n'), notes: body };
}

/** The changelog section for a released version. */
export function notesFor(changelog: string, version: string): string {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // "## v0.2.0 (2026-10-23)" as this script writes it, or "## 0.1.5 – 21 October" as older entries were written by hand.
  const m = new RegExp(`^## v?${escaped}(?![\\d.])[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(changelog);
  if (!m) throw new Error(`No "## v${version}" section in CHANGELOG.md.`);
  return m[1]!.trim();
}

/** Dates the changelog section and sets the version; returns the tag, or nothing on a dry run. */
function prepare(bump: string | undefined, dryRun: boolean): string | undefined {
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const version = resolveVersion(bump);
  const date = new Date().toISOString().slice(0, 10);
  const cut = cutChangelog(changelog, version, date);
  if (dryRun) {
    console.log(`Would release v${version} (${date}) with:\n${cut.notes}`);
    return undefined;
  }
  writeFileSync('CHANGELOG.md', cut.changelog);
  // npm prints the new version itself. Standard output is only the tag, so npm's goes to standard error.
  execFileSync('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts'], { stdio: ['ignore', process.stderr, 'inherit'] });
  writeFileSync('release-notes.md', `${cut.notes}\n`);
  console.log(`v${version}`);
  return `v${version}`;
}

function resolveVersion(bump: string | undefined): string {
  const current = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  const b = (bump ?? 'auto') as Bump;
  if (!['minor', 'patch', 'major', 'auto'].includes(b)) throw new Error(`Unknown bump "${bump}": use minor, patch, major or auto.`);
  return bumpVersion(current, b === 'auto' ? 'minor' : b);
}

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** The whole release from your machine: the pull request is opened as you, so its checks run and no extra token is needed. */
function cut(bump: string | undefined, dryRun: boolean): void {
  if (git('branch', '--show-current') !== 'main') throw new Error('Release from main: git switch main && git pull');
  if (git('status', '--porcelain')) throw new Error('The working tree has changes; commit or stash them first.');
  git('fetch', 'origin', 'main');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) throw new Error('main is not the same as origin/main: git pull first.');
  const tag = prepare(bump, dryRun);
  if (!tag) return;
  const branch = `release/${tag}`;
  git('switch', '-c', branch);
  git('add', 'CHANGELOG.md', 'package.json', 'package-lock.json');
  git('commit', '-m', `Release ${tag}`);
  git('push', '-u', 'origin', branch);
  const notes = readFileSync('release-notes.md', 'utf8');
  const body = `Release **${tag}**. Once this is merged, \`publish.yml\` tags it, creates the GitHub release and builds the image.\n\n${notes}`;
  execFileSync('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', `Release ${tag}`, '--body', body], { stdio: 'inherit' });
  execFileSync('gh', ['pr', 'merge', branch, '--auto', '--merge'], { stdio: 'inherit' });
  git('switch', 'main');
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');
  const args = rest.filter((a) => a !== '--dry-run');
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  switch (command) {
    case 'next':
      console.log(resolveVersion(args[0]));
      return;
    case 'unreleased': {
      const lines = unreleasedLines(changelog);
      console.log(lines.join('\n'));
      process.exitCode = lines.length ? 0 : 1;
      return;
    }
    case 'prepare':
      prepare(args[0], dryRun);
      return;
    case 'cut':
      cut(args[0], dryRun);
      return;
    case 'notes':
      if (!args[0]) throw new Error('Which version?');
      console.log(notesFor(changelog, args[0].replace(/^v/, '')));
      return;
    default:
      throw new Error('Usage: release.ts cut|next|unreleased|prepare|notes …');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
}
