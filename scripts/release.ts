// The release helper behind .github/workflows/release.yml and publish.yml; also fine by hand.
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

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');
  const args = rest.filter((a) => a !== '--dry-run');
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const current = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  const resolve = (bump: string | undefined): string => {
    const b = (bump ?? 'auto') as Bump;
    if (!['minor', 'patch', 'major', 'auto'].includes(b)) throw new Error(`Unknown bump "${bump}": use minor, patch, major or auto.`);
    return bumpVersion(current, b === 'auto' ? 'minor' : b);
  };
  switch (command) {
    case 'next':
      console.log(resolve(args[0]));
      return;
    case 'unreleased': {
      const lines = unreleasedLines(changelog);
      console.log(lines.join('\n'));
      process.exitCode = lines.length ? 0 : 1;
      return;
    }
    case 'prepare': {
      const version = resolve(args[0]);
      const date = new Date().toISOString().slice(0, 10);
      const cut = cutChangelog(changelog, version, date);
      if (dryRun) {
        console.log(`Would release v${version} (${date}) with:\n${cut.notes}`);
        return;
      }
      writeFileSync('CHANGELOG.md', cut.changelog);
      // npm prints the new version itself. Standard output is only the tag (the workflow uses it as a branch name), so npm's goes to standard error.
      execFileSync('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts'], { stdio: ['ignore', process.stderr, 'inherit'] });
      writeFileSync('release-notes.md', `${cut.notes}\n`);
      console.log(`v${version}`);
      return;
    }
    case 'notes':
      if (!args[0]) throw new Error('Which version?');
      console.log(notesFor(changelog, args[0].replace(/^v/, '')));
      return;
    default:
      throw new Error('Usage: release.ts next|unreleased|prepare|notes …');
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
