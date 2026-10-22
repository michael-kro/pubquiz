// The library folder: how it is chosen, and changing it from the app.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chooseLibraryDir, changeLibraryDir, defaultLibraryDir, readSavedTunnelHours, saveTunnelHours, SettingsError } from '../server/settings.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';

async function tempEnv(): Promise<string> {
  const config = await mkdtemp(join(tmpdir(), 'pubquiz-config-'));
  process.env['PUBQUIZ_CONFIG_DIR'] = config;
  delete process.env['PUBQUIZ_HOME'];
  return config;
}

async function library(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pubquiz-lib-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

test('the folder is chosen by the command line, then PUBQUIZ_HOME, then what was saved in the app, then ~/PubQuiz', async () => {
  const config = await tempEnv();
  assert.deepEqual(await chooseLibraryDir(undefined), { dir: defaultLibraryDir(), source: 'default' });
  await writeFile(join(config, 'config.json'), JSON.stringify({ libraryDir: '/data/saved' }));
  assert.deepEqual(await chooseLibraryDir(undefined), { dir: '/data/saved', source: 'saved' });
  process.env['PUBQUIZ_HOME'] = '/data/env';
  assert.deepEqual(await chooseLibraryDir(undefined), { dir: '/data/env', source: 'environment' });
  assert.deepEqual(await chooseLibraryDir('/data/flag'), { dir: '/data/flag', source: 'option' });
  delete process.env['PUBQUIZ_HOME'];
  await writeFile(join(config, 'config.json'), JSON.stringify({ libraryDir: 'relative/is/ignored' }));
  assert.equal((await chooseLibraryDir(undefined)).source, 'default', 'a damaged or relative saved path is ignored');
});

test('changing the folder checks the path, copies the library without overwriting or taking the trash, and saves it', async () => {
  const config = await tempEnv();
  const current = await library({ 'first-quiz/quiz.yaml': 'title: A', 'clips/boom.mp3': 'x', '.host-key': 'secret-key', '.trash/old/quiz.yaml': 'gone' });
  const target = join(await mkdtemp(join(tmpdir(), 'pubquiz-new-')), 'Quizzes');

  await assert.rejects(changeLibraryDir(current, '  ', true), SettingsError);
  await assert.rejects(changeLibraryDir(current, 'relative/path', true), /full folder path/);
  await assert.rejects(changeLibraryDir(current, current, true), /already in use/);
  await assert.rejects(changeLibraryDir(current, join(current, 'inside'), true), /inside/);
  await assert.rejects(changeLibraryDir(current, '/', true), /whole home|just for the quizzes/);

  const { dir, copied } = await changeLibraryDir(current, target, true);
  assert.equal(dir, target);
  assert.equal(copied, 3);
  assert.deepEqual((await readdir(target)).sort(), ['.host-key', 'clips', 'first-quiz'], 'the trash stays behind');
  assert.equal(await readFile(join(target, '.host-key'), 'utf8'), 'secret-key', 'the host link keeps working');
  assert.deepEqual(JSON.parse(await readFile(join(config, 'config.json'), 'utf8')), { libraryDir: target });
  assert.deepEqual(await chooseLibraryDir(undefined), { dir: target, source: 'saved' });

  // Choosing a folder that already has the same things in it never overwrites them.
  await writeFile(join(target, 'first-quiz', 'quiz.yaml'), 'title: Changed');
  const again = join(await mkdtemp(join(tmpdir(), 'pubquiz-new-')), 'Other');
  await mkdir(join(again, 'first-quiz'), { recursive: true });
  await writeFile(join(again, 'first-quiz', 'quiz.yaml'), 'title: Mine');
  await changeLibraryDir(target, again, true);
  assert.equal(await readFile(join(again, 'first-quiz', 'quiz.yaml'), 'utf8'), 'title: Mine');
  // Without copying, only the setting is saved.
  const bare = join(await mkdtemp(join(tmpdir(), 'pubquiz-new-')), 'Empty');
  assert.equal((await changeLibraryDir(again, bare, false)).copied, 0);
  assert.deepEqual(await readdir(bare), []);
});

test('over HTTP: host only, shows the folder and where it came from, and refuses when it was fixed at start-up', async () => {
  await tempEnv();
  const current = await library({ 'q/quiz.yaml': 'title: A' });
  const quiz = parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n');
  const server = await createQuizServer({ quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', libraryFolder: { dir: current, source: 'default' } });
  const url = `http://127.0.0.1:${server.port}/api/settings`;
  const auth = { 'x-host-key': server.hostKey, 'content-type': 'application/json' };

  assert.equal((await fetch(url)).status, 401);
  assert.deepEqual(await (await fetch(url, { headers: auth })).json(), { libraryDir: current, source: 'default', defaultDir: defaultLibraryDir() });
  const target = join(await mkdtemp(join(tmpdir(), 'pubquiz-new-')), 'Moved');
  const saved = await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify({ libraryDir: target, copy: true }) });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ok: true, dir: target, copied: 1, restart: true });
  assert.equal((await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify({ libraryDir: 'nope' }) })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  await server.close();

  const fixed = await createQuizServer({ quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', libraryFolder: { dir: current, source: 'option' } });
  const refused = await fetch(`http://127.0.0.1:${fixed.port}/api/settings`, { method: 'POST', headers: { 'x-host-key': fixed.hostKey, 'content-type': 'application/json' }, body: JSON.stringify({ libraryDir: target }) });
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /--quizzes/);
  await fixed.close();
});

test('the internet-link hours are remembered beside the library folder, and a bad value is ignored', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pubquiz-cfg-'));
  const before = process.env['PUBQUIZ_CONFIG_DIR'];
  process.env['PUBQUIZ_CONFIG_DIR'] = home;
  try {
    assert.equal(await readSavedTunnelHours(), undefined);
    await saveTunnelHours(6);
    assert.equal(await readSavedTunnelHours(), 6);
    await writeFile(join(home, 'config.json'), JSON.stringify({ libraryDir: '/tmp/somewhere', tunnelHours: 6 }));
    await saveTunnelHours(0);
    assert.deepEqual(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')), { libraryDir: '/tmp/somewhere', tunnelHours: 0 }, 'other settings survive');
    await writeFile(join(home, 'config.json'), JSON.stringify({ tunnelHours: 'six' }));
    assert.equal(await readSavedTunnelHours(), undefined);
    await writeFile(join(home, 'config.json'), '{not json');
    assert.equal(await readSavedTunnelHours(), undefined);
  } finally {
    if (before === undefined) delete process.env['PUBQUIZ_CONFIG_DIR'];
    else process.env['PUBQUIZ_CONFIG_DIR'] = before;
  }
});
