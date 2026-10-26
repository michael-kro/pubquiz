// The release helper: versions and the changelog cut.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { bumpVersion, cutChangelog, notesFor, unreleasedLines } from '../scripts/release.ts';

const LOG = `# Changelog

## Unreleased

- **A feature:** does things.
- A fix.

## 0.1.5 — 2026-10-21

- The last release.
`;

test('bumpVersion', () => {
  assert.equal(bumpVersion('0.1.5', 'minor'), '0.2.0');
  assert.equal(bumpVersion('0.1.5', 'patch'), '0.1.6');
  assert.equal(bumpVersion('0.9.3', 'major'), '1.0.0');
  assert.throws(() => bumpVersion('1.2', 'minor'), /Not a version/);
});

test('the changelog is cut into a dated section with a fresh Unreleased above it, and the notes are the section', () => {
  assert.deepEqual(unreleasedLines(LOG), ['- **A feature:** does things.', '- A fix.']);
  const { changelog, notes } = cutChangelog(LOG, '0.2.0', '2026-10-23');
  assert.equal(notes, '- **A feature:** does things.\n- A fix.');
  assert.equal(changelog, `# Changelog

## Unreleased

## 0.2.0 — 2026-10-23

- **A feature:** does things.
- A fix.

## 0.1.5 — 2026-10-21

- The last release.
`);
  assert.deepEqual(unreleasedLines(changelog), [], 'nothing unreleased afterwards');
  assert.equal(notesFor(changelog, '0.2.0'), '- **A feature:** does things.\n- A fix.');
  assert.equal(notesFor(changelog, '0.1.5'), '- The last release.');
  assert.throws(() => cutChangelog(changelog, '0.3.0', '2026-10-30'), /nothing to release/);
  assert.throws(() => notesFor(changelog, '9.9.9'), /No "## v9.9.9"/);
  // An Unreleased section at the very end of the file (no older releases yet) works too.
  const fresh = '# Changelog\n\n## Unreleased\n\n- First thing.\n';
  assert.equal(cutChangelog(fresh, '0.1.0', '2026-01-01').changelog, '# Changelog\n\n## Unreleased\n\n## 0.1.0 — 2026-01-01\n\n- First thing.\n');
});

test('the command line: next, unreleased, prepare --dry-run, notes', () => {
  const run = (...args: string[]) => execFileSync(process.execPath, ['scripts/release.ts', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.match(run('next'), /^\d+\.\d+\.0$/);
  assert.match(run('next', 'patch'), /^\d+\.\d+\.\d+$/);
  // On a release commit there is nothing unreleased; on any other, there is. Either way the commands agree with the file.
  const pending = unreleasedLines(readFileSync('CHANGELOG.md', 'utf8'));
  if (pending.length) {
    assert.equal(run('unreleased'), pending.join('\n'));
    assert.match(run('prepare', '--dry-run'), /^Would release v\d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2}\) with:\n- /);
  } else {
    assert.throws(() => run('unreleased'), /Command failed/, 'exit 1 when there is nothing to release');
    assert.throws(() => run('prepare', '--dry-run'), /nothing to release/);
  }
  assert.ok(run('notes', 'v0.1.5').length > 0);
  assert.throws(() => run('next', 'huge'), /Unknown bump/);
});

test('prepare prints only the tag on standard output, because cut uses it as a branch name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-prepare-'));
  try {
    for (const file of ['package.json', 'package-lock.json']) copyFileSync(file, join(dir, file));
    writeFileSync(join(dir, 'CHANGELOG.md'), LOG);
    const out = execFileSync(process.execPath, [resolve('scripts/release.ts'), 'prepare', 'minor'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(out, /^v\d+\.\d+\.\d+\n$/, `standard output was ${JSON.stringify(out)}`);
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, out.trim().slice(1), 'the version in package.json is the one printed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
