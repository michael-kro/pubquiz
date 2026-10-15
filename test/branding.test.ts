// M8g: branding: name, tagline, colours and a logo on every page.
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BrandingError, BrandingStore, DEFAULT_BRANDING, validateBranding } from '../server/branding.ts';
import { Library } from '../server/library.ts';
import { createQuizServer } from '../server/server.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const fresh = async () => new BrandingStore(await mkdtemp(join(tmpdir(), 'pubquiz-brand-')));

test('validation: colours must be hex (so nothing can be injected into the page), text is tidied', () => {
  assert.deepEqual(validateBranding({}), DEFAULT_BRANDING);
  assert.deepEqual(validateBranding({ name: '  The   Quiz​ Pub ', tagline: 'Your Friendly your town Bar', accent: '#F9B233', background: '#045' }), {
    name: 'The Quiz Pub',
    tagline: 'Your Friendly your town Bar',
    accent: '#f9b233',
    background: '#004455',
    showName: true,
  });
  for (const bad of ['red', 'rgb(0,0,0)', '#12', '#12345g', 'red;}body{display:none', 'url(http://x)', '#ffffff;', 7]) {
    assert.throws(() => validateBranding({ accent: bad }), BrandingError, String(bad));
    assert.throws(() => validateBranding({ background: bad }), BrandingError, String(bad));
  }
  assert.throws(() => validateBranding({ name: 'x'.repeat(41) }), /at most 40/);
  assert.throws(() => validateBranding({ tagline: 'x'.repeat(81) }), /at most 80/);
  assert.throws(() => validateBranding({ name: 5 }), /must be text/);
  assert.equal(validateBranding({ showName: false }).showName, false);
  assert.throws(() => validateBranding({ showName: 'no' }), /true or false/);
  assert.throws(() => validateBranding(null), BrandingError);
  assert.throws(() => validateBranding([1]), BrandingError);
});

test('the store saves and reads back, and falls back to the default look when nothing is saved', async () => {
  const store = await fresh();
  assert.deepEqual(await store.info(), DEFAULT_BRANDING);
  await store.save({ name: 'Pub', accent: '#f9b233', background: '#004516' });
  assert.deepEqual(await store.config(), { name: 'Pub', tagline: '', accent: '#f9b233', background: '#004516', showName: true });
});

test('logos: one at a time, images only, size limited, and versioned so browsers refresh them', async () => {
  const store = await fresh();
  await store.setLogo('My Logo.PNG', PNG);
  const first = await store.info();
  assert.match(first.logo!, /^\/branding\/logo\?v=/);
  assert.equal((await store.logo())!.contentType, 'image/png');
  await store.setLogo('new.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  assert.deepEqual((await readdir(store.dir)).filter((f) => f.startsWith('logo')), ['logo.svg'], 'the old logo is replaced, not kept');
  assert.notEqual((await store.info()).logo, first.logo);
  await assert.rejects(store.setLogo('evil.html', PNG), /image/);
  await assert.rejects(store.setLogo('big.png', Buffer.alloc(2 * 1024 * 1024 + 1)), /2 MB/);
  await assert.rejects(store.setLogo('empty.png', Buffer.alloc(0)), /empty/);
  await store.removeLogo();
  assert.equal((await store.info()).logo, undefined);
});

test('a read-only branding folder (from the command line) cannot be changed', async () => {
  const store = new BrandingStore(await mkdtemp(join(tmpdir(), 'pubquiz-brand-')), { readOnly: true });
  assert.equal(store.editable, false);
  await assert.rejects(store.save({ name: 'x' }), /read-only/);
  await assert.rejects(store.setLogo('a.png', PNG), /read-only/);
});

const quiz = (await import('../server/quiz.ts')).parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n');

test('pages get the branding from /branding.json and the logo from /branding/logo, with safe headers', async () => {
  const plain = await createQuizServer({ closeEarly: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const base = (s: { port: number }) => `http://127.0.0.1:${s.port}`;
  assert.deepEqual(await (await fetch(`${base(plain)}/branding.json`)).json(), DEFAULT_BRANDING, 'no branding set up: the default look');
  assert.equal((await fetch(`${base(plain)}/branding/logo`)).status, 404);
  await plain.close();

  const store = await fresh();
  await store.save({ name: 'The Quiz Pub', tagline: 'Your Friendly your town Bar', accent: '#f9b233', background: '#0a1f12' });
  await store.setLogo('logo.png', PNG);
  const server = await createQuizServer({ closeEarly: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', branding: store });
  const res = await fetch(`${base(server)}/branding.json`);
  const info = (await res.json()) as { name: string; logo: string; accent: string };
  assert.equal(info.name, 'The Quiz Pub');
  assert.equal(info.accent, '#f9b233');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const logo = await fetch(base(server) + info.logo);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.match(logo.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.deepEqual(Buffer.from(await logo.arrayBuffer()), PNG);
  await server.close();
});

test('the host edits branding through the API, and only the host can', async () => {
  const library = new Library(await mkdtemp(join(tmpdir(), 'pubquiz-lib-')));
  const store = new BrandingStore(join(library.dir, 'branding'));
  const server = await createQuizServer({ closeEarly: true, library, branding: store, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const api = `http://127.0.0.1:${server.port}/api/branding`;
  const asHost = { 'x-host-key': server.hostKey };

  assert.equal((await fetch(api)).status, 401, 'no key, no access');
  assert.equal((await fetch(api, { method: 'PUT', body: '{}' })).status, 401);
  assert.equal((await fetch(`${api}/logo?name=a.png`, { method: 'POST', body: PNG })).status, 401);

  const put = await fetch(api, { method: 'PUT', headers: asHost, body: JSON.stringify({ name: 'Pub Quiz', accent: '#029c3b', background: '#004516' }) });
  assert.equal(put.status, 200);
  assert.equal(((await put.json()) as { editable: boolean }).editable, true);
  const bad = await fetch(api, { method: 'PUT', headers: asHost, body: JSON.stringify({ accent: 'red;}' }) });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /colour like #f5b83d/);

  const upload = await fetch(`${api}/logo?name=${encodeURIComponent('logo.png')}`, { method: 'POST', headers: asHost, body: PNG });
  assert.equal(upload.status, 200);
  const live = (await (await fetch(`http://127.0.0.1:${server.port}/branding.json`)).json()) as { name: string; logo: string };
  assert.equal(live.name, 'Pub Quiz');
  assert.ok(live.logo);
  assert.equal((await fetch(`${api}/logo?name=x.exe`, { method: 'POST', headers: asHost, body: PNG })).status, 400);
  assert.equal((await fetch(`${api}/logo`, { method: 'DELETE', headers: asHost })).status, 200);
  assert.equal(((await (await fetch(`http://127.0.0.1:${server.port}/branding.json`)).json()) as { logo?: string }).logo, undefined);

  // The branding folder inside the library is not a quiz.
  assert.deepEqual(await library.list(), []);
  await server.close();
});
