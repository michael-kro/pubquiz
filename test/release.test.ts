// The release helper: versions and the changelog cut.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  const run = (...args: string[]) => execFileSync(process.execPath, ['scripts/release.ts', ...args], { encoding: 'utf8' }).trim();
  assert.match(run('next'), /^\d+\.\d+\.0$/);
  assert.match(run('next', 'patch'), /^\d+\.\d+\.[1-9]\d*$|^\d+\.\d+\.\d+$/);
  assert.ok(run('unreleased').length > 0, 'this checkout has unreleased changes');
  assert.match(run('prepare', '--dry-run'), /^Would release v\d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2}\) with:\n- /);
  assert.ok(run('notes', 'v0.1.5').length > 0);
  assert.throws(() => run('next', 'huge'), /Unknown bump/);
});
