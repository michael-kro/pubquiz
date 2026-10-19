// Branding profiles: one branding setup per venue, with one active.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BrandingError, BrandingProfiles, profileId } from '../server/branding.ts';
import { Library } from '../server/library.ts';
import { createQuizServer } from '../server/server.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHYm4tAAAAABJRU5ErkJggg==', 'base64');

async function folder() {
  return mkdtemp(join(tmpdir(), 'pubquiz-profiles-'));
}

test('profile ids are safe folder names made from the venue name', () => {
  assert.equal(profileId('The Thirsty Bear, Warwick'), 'the-thirsty-bear-warwick');
  assert.equal(profileId('Café Ñandú!'), 'cafe-nandu');
  assert.equal(profileId('../../etc/passwd'), 'etc-passwd');
  assert.equal(profileId('   '), '');
});

test('an existing single branding setup becomes the "default" profile, untouched', async () => {
  const root = await folder();
  await writeFile(join(root, 'branding.json'), JSON.stringify({ name: 'Old Pub', accent: '#112233', background: '#000000' }));
  await writeFile(join(root, 'logo.png'), PNG);
  await mkdir(join(root, 'original'));
  await writeFile(join(root, 'original', 'big.png'), PNG);
  const profiles = new BrandingProfiles(root);
  assert.deepEqual(await profiles.list(), [{ id: 'default', label: 'Old Pub' }]);
  assert.equal(profiles.active, 'default');
  assert.equal((await profiles.info()).accent, '#112233');
  assert.ok((await profiles.info()).logo, 'the logo came along');
  assert.deepEqual((await readdir(root)).sort(), ['default', 'profiles.json']);
  assert.ok((await readdir(join(root, 'default'))).includes('original'));
});

test('a new library starts with one empty profile', async () => {
  const profiles = new BrandingProfiles(join(await folder(), 'branding'));
  assert.deepEqual(await profiles.list(), [{ id: 'default', label: 'default' }]);
});

test('create, switch, edit and delete profiles; the active one is what pages see', async () => {
  const root = await folder();
  const profiles = new BrandingProfiles(root);
  await profiles.init();
  await profiles.save({ name: 'First Pub', accent: '#aa0000', background: '#ffffff' });
  await profiles.setLogo('logo.png', PNG);

  const id = await profiles.create('Second Pub');
  assert.equal(id, 'second-pub');
  assert.equal(profiles.active, 'default', 'creating does not switch');
  await profiles.activate(id);
  assert.equal((await profiles.info()).name, 'Second Pub');
  assert.equal((await profiles.info()).logo, undefined, 'a blank profile has no logo');
  await profiles.save({ name: 'Second Pub', accent: '#00aa00', background: '#000000' });
  await profiles.activate('default');
  assert.equal((await profiles.info()).accent, '#aa0000', 'the first venue is unchanged by edits to the second');

  const copy = await profiles.create('Third Pub', 'default');
  assert.equal((await profiles.activate(copy), (await profiles.info()).name), 'Third Pub');
  assert.equal((await profiles.info()).accent, '#aa0000', 'a copy starts with the other venue’s colours');
  assert.ok((await profiles.info()).logo, 'and its logo');

  assert.equal(await profiles.create('Second Pub'), 'second-pub-2', 'names that clash get a number');
  await profiles.remove(copy);
  assert.equal(profiles.active, 'default', 'deleting the active profile switches to another');
  assert.equal(JSON.parse(await readFile(join(root, 'profiles.json'), 'utf8')).active, 'default', 'and that is remembered');
});

test('the active profile is remembered across restarts', async () => {
  const root = await folder();
  const first = new BrandingProfiles(root);
  await first.init();
  await first.activate(await first.create('Venue B'));
  const second = new BrandingProfiles(root);
  await second.init();
  assert.equal(second.active, 'venue-b');
});

test('bad profile requests are refused and cannot reach other folders', async () => {
  const root = await folder();
  const profiles = new BrandingProfiles(root);
  await profiles.init();
  for (const bad of ['../x', 'nope', '', undefined, 3, 'default/../..']) {
    await assert.rejects(profiles.activate(bad), BrandingError);
    await assert.rejects(profiles.remove(bad), BrandingError);
  }
  await assert.rejects(profiles.remove('default'), /only profile/);
  await assert.rejects(profiles.create('   '), /name/);
  await assert.rejects(profiles.create('Ok', '../x'), BrandingError);
});

test('the host can list, add, switch and delete venues over the API, and pages follow the active one', async () => {
  const root = await folder();
  const library = new Library(join(root, 'quizzes'));
  const profiles = new BrandingProfiles(join(root, 'quizzes', 'branding'));
  const server = await createQuizServer({ library, branding: profiles, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.port}`;
  const host = { 'x-host-key': server.hostKey, 'content-type': 'application/json' };
  type Info = { name: string; active: string; profiles: { id: string; label: string }[]; error?: string };
  const call = async (method: string, path: string, body?: object) => {
    const res = await fetch(`${base}/api/branding${path}`, { method, headers: host, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: (await res.json()) as Info };
  };

  assert.equal((await fetch(`${base}/api/branding/active`, { method: 'POST', body: '{"id":"default"}' })).status, 401, 'no key, no switching');
  assert.equal((await fetch(`${base}/api/branding/profiles`, { method: 'POST', body: '{"name":"x"}' })).status, 401);

  const first = await call('GET', '');
  assert.deepEqual(first.data.profiles.map((p) => p.id), ['default']);
  const added = await call('POST', '/profiles', { name: 'Venue Two', activate: true });
  assert.equal(added.status, 201);
  assert.equal(added.data.active, 'venue-two');
  assert.equal(((await (await fetch(`${base}/branding.json`)).json()) as Info).name, 'Venue Two', 'pages follow the active venue');
  assert.equal((await call('POST', '/active', { id: 'default' })).data.active, 'default');
  assert.equal((await call('POST', '/active', { id: '../..' })).status, 404);
  assert.equal((await call('DELETE', '/profiles/venue-two')).data.profiles.length, 1);
  assert.equal((await call('DELETE', '/profiles/default')).status, 400, 'the last venue stays');
  await server.close();
});
