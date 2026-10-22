// HTTP upload fuzzing. Everything that takes a file: the quiz import (yaml and zip), quiz pictures and audio,
// soundboard clips, team photos and the venue logo; plus the JSON bodies next to them. Each gets malformed,
// mislabelled, oversized, empty and nasty-named files, bodies that lie about their length, zips that try to
// escape, zip bombs and junk JSON, with the right key, the wrong one and none. The server must stay up, answer
// every request with a status it meant (never 500), say yes to nothing without the key, never write outside its
// folders, never keep a file of a kind it refuses, never leak a key or a path, and still work afterwards.
//
// Deterministic: FUZZ_SEED picks the sequence and FUZZ_ITERATIONS (default 120 per target) the length, so a
// failure can be replayed. A long run: FUZZ_ITERATIONS=2000 npm run test:slow
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { zipSync } from 'fflate';
import { BrandingStore } from '../../server/branding.ts';
import { Library, MAX_IMAGE_UPLOAD } from '../../server/library.ts';
import { MAX_PHOTO_BYTES } from '../../server/photos.ts';
import { parseQuiz } from '../../server/quiz.ts';
import { createQuizServer, type QuizServer } from '../../server/server.ts';
import { Client } from '../client.ts';

const ITERATIONS = Math.max(40, Number(process.env['FUZZ_ITERATIONS'] ?? 120));
const SEED = Number(process.env['FUZZ_SEED'] ?? 20261021);

const QUIZ = 'title: Fuzz\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba, seconds: 90 }\n';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A small seeded random generator, so the same seed always gives the same files. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Real headers of the file types the app accepts, so some fuzzed files get past the sniffing and into the parsers.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0'), Buffer.alloc(32, 0x11), Buffer.from([0xff, 0xd9])]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(28, 0x22)]);
const MP3 = Buffer.concat([Buffer.from('ID3\x04\0\0\0\0\0\0'), Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(64, 0x33)]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const NAMES = [
  'a.png', 'A.PNG', 'photo.jpg', 'pic.jpeg', 'x.webp', 'x.gif', 'x.svg', 'song.mp3', 'song.m4a', 'song.ogg', 'song.wav', 'quiz.yaml', 'quiz.yml', 'bundle.zip',
  '', '.', '..', '../../../etc/passwd.png', '..\\..\\win.ini.mp3', 'a/b/c.png', 'con.png', 'nul.mp3', '.hidden.png', 'x.png.exe', 'x.exe.png', 'x.PnG', 'x.mp3 ', ' x.mp3',
  'x.php', 'x.html', 'x.js', 'x', 'x.', '.png', '.mp3', 'x.ZIP', 'x.tar.gz', 'quiz.yaml.zip', '%2e%2e%2fx.png', 'x%00.png', 'x\0.png', 'ünïcödé.png', '😀.mp3', '‮evil.gnp.mp3',
  'x'.repeat(300) + '.png', 'x'.repeat(5000) + '.mp3', 'constructor.png', '__proto__.mp3', 'prototype.yaml', 'x;rm -rf ~.png', '$(id).mp3', '`id`.png', "x' OR 1=1.png", '<script>.png',
];
const TITLES = ['', 'A clip', 'x'.repeat(5000), '<script>alert(1)</script>', '\u0000\u0001\u0002', '‮evil', '__proto__', 'ÄÖÜ 中文 😀', '%s%s%n', '../x'];
const YAMLS = [
  QUIZ, '', 'title: x', 'title: [', '- - - -', '!!js/function "x"', 'title: &a [*a, *a]\nrounds: *a', '&a [*a]', 'title: x\nrounds: ' + '['.repeat(5000), 'x: ' + 'y'.repeat(100_000),
  'title: x\nrounds:\n  - name: r\n    questions:\n      - { type: letter, text: q, answer: a, image: ../../etc/passwd }', 'title: x\nrounds:\n  - name: r\n    questions:\n' + '      - { type: number, text: q, answer: 1 }\n'.repeat(3000),
  '__proto__:\n  polluted: yes\ntitle: x', 'title: x\nconstructor:\n  prototype:\n    polluted: yes', '﻿title: bom', 'title: "\u0000\u0000"', Buffer.alloc(4096, 0xff).toString('latin1'),
];
const JSONS = ['', '{', '[]', 'null', '0', '"x"', '{"__proto__":{"polluted":1}}', '{"constructor":{"prototype":{"polluted":1}}}', '{"title":' + '['.repeat(50_000) + '}', '{"title":"' + 'x'.repeat(1_000_000) + '"}', '{"rounds":"nope"}', '{"rounds":[{"questions":[{"type":"nope"}]}]}', '﻿{}', '{"a":1e999}', '{"a":"\ud800"}', '{"name":"x","copy":true}', '{"name":"' + 'n'.repeat(10_000) + '","accent":"#zzz","background":"javascript:alert(1)"}'];

class Generator {
  private readonly r: () => number;
  constructor(seed: number) {
    this.r = mulberry32(seed);
  }
  int(n: number): number {
    return Math.floor(this.r() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
  chance(p: number): boolean {
    return this.r() < p;
  }
  bytes(n: number): Buffer {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = this.int(256);
    return b;
  }
  /** A file body: empty, random, a real header followed by junk, a header with the tail chopped, or huge. */
  body(kind: 'image' | 'audio' | 'any' = 'any'): Buffer {
    const header = kind === 'image' ? this.pick([PNG, JPEG, WEBP]) : kind === 'audio' ? MP3 : this.pick([PNG, JPEG, WEBP, MP3, ZIP_MAGIC]);
    switch (this.int(9)) {
      case 0: return Buffer.alloc(0);
      case 1: return this.bytes(1 + this.int(64));
      case 2: return header;
      case 3: return header.subarray(0, 1 + this.int(header.length - 1));
      case 4: return Buffer.concat([header, this.bytes(this.int(4096))]);
      case 5: return Buffer.concat([header, Buffer.alloc(this.int(200_000), 0)]);
      case 6: return Buffer.concat([this.bytes(this.int(8)), header]);
      case 7: return Buffer.alloc(MAX_PHOTO_BYTES + 1 + this.int(1000), 0x41);
      default: return Buffer.concat([header, Buffer.alloc(this.pick([1, 2, 11]) * 1024 * 1024, 0x42)]); // around and over the 10 MB picture limit
    }
  }
  /** A zip: well-formed with nasty entries, trying to escape, a bomb, thousands of entries, truncated, nested, or not a zip at all. */
  zip(): Buffer {
    switch (this.int(8)) {
      case 0: return Buffer.from(zipSync({ 'quiz.yaml': Buffer.from(this.pick(YAMLS)), [`images/${this.pick(NAMES)}`]: this.body('image'), [`audio/${this.pick(NAMES)}`]: this.body('audio') }));
      case 1: return Buffer.from(zipSync({ '../quiz.yaml': Buffer.from(QUIZ), '../../escape.png': PNG, 'images/../../escape2.png': PNG, '/abs/quiz.yaml': Buffer.from(QUIZ), 'folder/quiz.yaml': Buffer.from(QUIZ), 'folder/images/ok.png': PNG }));
      case 2: return Buffer.from(zipSync({ 'quiz.yaml': Buffer.from(QUIZ), 'images/bomb.png': Buffer.alloc(MAX_IMAGE_UPLOAD + 1024, 0) }, { level: 9 })); // tiny, inflates past the picture limit
      case 3: return Buffer.from(zipSync(Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`images/f${i}.png`, PNG])), { level: 0 }));
      case 4: { const z = Buffer.from(zipSync({ 'quiz.yaml': Buffer.from(QUIZ), 'images/a.png': PNG })); return z.subarray(0, this.int(z.length)); }
      case 5: return Buffer.from(zipSync({ 'inner.zip': zipSync({ 'quiz.yaml': Buffer.from(QUIZ) }), 'quiz.yaml': Buffer.from(this.pick(YAMLS)) }));
      case 6: return Buffer.concat([ZIP_MAGIC, this.bytes(this.int(2000))]);
      default: return Buffer.from(zipSync({ 'quiz.yaml': Buffer.from(this.pick(YAMLS)) }));
    }
  }
  name(kind: 'image' | 'audio' | 'bundle'): string {
    if (this.chance(0.5)) return this.pick(NAMES);
    return kind === 'image' ? 'a.png' : kind === 'audio' ? 'a.mp3' : this.pick(['quiz.yaml', 'bundle.zip']);
  }
}

/** One fuzzed request: what it targeted, whether it carried the right credential, and how the server answered. */
interface Outcome {
  target: string;
  authorised: boolean;
  status: number;
  body: string;
}

test('HTTP upload fuzzing: malformed, mislabelled and oversized files to every upload; the server stays up and keeps nothing it refused', { timeout: 170_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pubquiz-fuzz-http-'));
  const library = new Library(join(root, 'library'));
  const branding = new BrandingStore(join(root, 'branding'));
  const server: QuizServer = await createQuizServer({
    quiz: parseQuiz(QUIZ), library, branding, clipsDir: join(root, 'clips'), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1',
    allowEmptyStart: true, closeEarly: false, lockOnStart: false, tvShowTeams: true,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const gen = new Generator(SEED);
  const outcomes: Outcome[] = [];
  const statuses: Record<string, Record<number, number>> = {};
  const keyBefore = server.hostKey;
  const MUST_NOT_APPEAR: [string, string][] = [[server.hostKey, 'the host key'], [server.screenKey, 'the TV key'], [root, 'a path']];

  /** Mostly the host key; sometimes none, or the TV's key where the host's belongs. Marked so `send` knows what to expect. */
  const RIGHT = Symbol('the right credential');
  type Headers = Record<string, string> & { [RIGHT]?: true };
  const hostHeaders = (): Headers => (gen.chance(0.85) ? { 'x-host-key': server.hostKey, [RIGHT]: true } : gen.chance(0.5) ? {} : { 'x-host-key': server.screenKey });
  const isAuthorised = (headers: Headers) => headers[RIGHT] === true;

  /** A request written by hand, so the content-length can lie: shorter, longer, absurd or negative. */
  const rawRequest = (method: string, path: string, headers: Record<string, string>, body: Buffer, declared: number) =>
    new Promise<{ status: number; body: string }>((resolve) => {
      const socket = createConnection(server.port, '127.0.0.1');
      let data = '';
      const finish = () => {
        clearTimeout(timer);
        socket.destroy();
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0);
        resolve({ status, body: data.slice(data.indexOf('\r\n\r\n') + 4) });
      };
      const timer = setTimeout(finish, 3000); // a body declared longer than it is leaves the server waiting; that is correct, not a hang
      socket.on('connect', () => {
        const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
        socket.write(`${method} ${path} HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\ncontent-length: ${declared}\r\n${lines}\r\n`);
        socket.write(body);
      });
      socket.on('data', (d) => (data += d.toString('latin1')));
      socket.on('close', finish);
      socket.on('error', () => {});
    });

  /** Sends one request and records how it went. */
  const send = async (target: string, method: string, path: string, headers: Headers, body?: Buffer, authorised = isAuthorised(headers)): Promise<Outcome> => {
    let outcome: Outcome;
    const plain = Object.fromEntries(Object.entries(headers)); // without the marker, which fetch would refuse
    try {
      if (body && target !== 'check' && gen.chance(0.1)) {
        const declared = gen.pick([0, 1, Math.floor(body.length / 2), body.length * 2 + 1, 2 ** 31, -1]);
        outcome = { target: `${target}-lying-length`, authorised, ...(await rawRequest(method, path, plain, body, declared)) };
      } else {
        const res = await fetch(base + path, { method, headers: plain, body: body as unknown as BodyInit, signal: AbortSignal.timeout(20_000) });
        outcome = { target, authorised, status: res.status, body: (await res.text()).slice(0, 2000) };
      }
    } catch (error) {
      // A reset connection is fine (the server may hang up on a body it will not read); a timeout is not.
      assert.notEqual((error as Error).name, 'TimeoutError', `${target} ${path}: the server stopped answering`);
      outcome = { target, authorised, status: 0, body: `(no answer: ${(error as Error).message} ${(error as Error & { cause?: Error }).cause?.message ?? ''})` };
    }
    outcomes.push(outcome);
    (statuses[outcome.target] ??= {})[outcome.status] = (statuses[outcome.target]![outcome.status] ?? 0) + 1;
    assert.notEqual(outcome.status, 500, `${target} ${path}: an unhandled error: ${outcome.body}`);
    for (const [text, what] of MUST_NOT_APPEAR) assert.ok(!outcome.body.includes(text), `${target} ${path}: the response leaks ${what}`);
    if (!authorised) assert.ok(outcome.status < 200 || outcome.status >= 300, `${target} ${path}: said yes (${outcome.status}) without the right credential`);
    return outcome;
  };

  const query = (params: Record<string, string>) => '?' + new URLSearchParams(params).toString();
  const alive = async () => {
    const res = await fetch(`${base}/api/quizzes`, { headers: { 'x-host-key': server.hostKey }, signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 200, 'the server is still answering');
    return (await res.json()) as { id: string }[];
  };

  // A quiz to upload into, and a team to upload photos as.
  const quizId = ((await (await fetch(`${base}/api/quizzes`, { method: 'POST', headers: { 'x-host-key': server.hostKey } })).json()) as { id: string }).id;
  const joinTeam = async (name: string) => {
    const client = await Client.connect(server.port);
    client.send({ t: 'join', room: server.roomCode, name });
    return { client, token: (await client.waitFor((m) => m.t === 'joined')).token as string };
  };
  const team = await joinTeam('Fuzz Team');

  await t.test('the quiz import: yaml, zips that escape or explode, and junk', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const name = gen.name('bundle');
      const body = name.toLowerCase().endsWith('.zip') || gen.chance(0.3) ? gen.zip() : gen.chance(0.7) ? Buffer.from(gen.pick(YAMLS)) : gen.body();
      await send('import', 'POST', `/api/import${query({ name })}`, hostHeaders(), body);
    }
    await alive();
  });

  await t.test('quiz pictures and audio, and the JSON that saves or copies a quiz', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const id = gen.chance(0.8) ? quizId : gen.pick(['nope', '..', `../${quizId}`, `${quizId}/..`, '%2e%2e', encodeURIComponent('..\\..')]);
      switch (gen.int(6)) {
        case 0: await send('image', 'POST', `/api/quizzes/${id}/images${query({ name: gen.name('image') })}`, hostHeaders(), gen.body('image')); break;
        case 1: await send('audio', 'POST', `/api/quizzes/${id}/audio${query({ name: gen.name('audio') })}`, hostHeaders(), gen.body('audio')); break;
        case 2: await send('save', 'PUT', `/api/quizzes/${id}`, { ...hostHeaders(), 'content-type': 'application/json' }, Buffer.from(gen.pick(JSONS))); break;
        case 3: await send('duplicate', 'POST', `/api/quizzes/${id}/duplicate`, { ...hostHeaders(), 'content-type': 'application/json' }, Buffer.from(gen.pick(JSONS))); break;
        // Practice mode takes JSON too (the host key is accepted there): starting a session and answering.
        case 4: await send('practice-start', 'POST', `/api/practice/learners/${encodeURIComponent(gen.pick(['Fuzz', gen.pick(TITLES), '..', '%00', 'x'.repeat(300)]))}/sessions`, { ...hostHeaders(), 'content-type': 'application/json' }, Buffer.from(gen.pick([...JSONS, `{"quizId":"${id}","mode":"learn"}`, `{"quizId":"${id}","mode":"test","count":1e9,"only":[-1,1e9,"x"]}`]))); break;
        default: await send('practice-act', 'POST', `/api/practice/learners/Fuzz/current/${gen.pick(['answer', 'next', 'back', 'skip', 'flag', 'reveal', 'finish', 'abandon', '..', 'nope'])}`, { ...hostHeaders(), 'content-type': 'application/json' }, Buffer.from(gen.pick([...JSONS, '{"value":0}', '{"value":[0,1,2,3,4]}', '{"value":"' + 'x'.repeat(5000) + '"}', '{"value":{"__proto__":1}}', '{"value":1e400}'])));
      }
    }
    await alive();
  });

  await t.test('soundboard clips, the venue logo and the branding JSON', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      if (gen.chance(0.6)) await send('clip', 'POST', `/api/clips${query({ name: gen.name('audio'), title: gen.pick(TITLES) })}`, hostHeaders(), gen.body('audio'));
      else if (gen.chance(0.7)) await send('logo', 'POST', `/api/branding/logo${query({ name: gen.name('image') })}`, hostHeaders(), gen.body('image'));
      else await send('branding', 'PUT', '/api/branding', { ...hostHeaders(), 'content-type': 'application/json' }, Buffer.from(gen.pick(JSONS)));
    }
    await alive();
  });

  await t.test('team photos: as the team, as nobody, and with a made-up token', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const headers: Record<string, string> = gen.chance(0.7) ? { 'x-team-token': team.token } : gen.chance(0.5) ? {} : { 'x-team-token': gen.pick(['', 'x', server.hostKey, 'x'.repeat(5000), '\0']) };
      await send('photo', gen.chance(0.9) ? 'POST' : 'DELETE', '/team-photo', headers, gen.body('image'), headers['x-team-token'] === team.token);
    }
    await alive();
  });

  // Nothing was written outside the library, clips and branding folders, nothing escaped, and nothing kept is of a kind or size the app refuses.
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(relative(root, path));
    }
  };
  await walk(root);
  for (const file of files) {
    assert.match(file, /^(library|clips|branding)\//, `a file outside the app's folders: ${file}`);
    assert.doesNotMatch(file, /(^|\/)\.\.(\/|$)/, `a file that escaped: ${file}`);
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    assert.ok(['.yaml', '.json', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp3', '.m4a', '.ogg', '.wav', '.csv'].includes(ext), `a file of a kind the app does not accept: ${file}`);
    assert.ok((await stat(join(root, file))).size <= 20 * 1024 * 1024, `a file bigger than any limit: ${file}`);
  }
  // Every quiz the library lists can still be read, so the editor's list cannot break; every folder it made holds a quiz.
  for (const { id } of await alive()) assert.ok(await library.read(id).then(() => true, () => false), `quiz ${id} can still be read`);
  for (const dir of await readdir(join(root, 'library'), { withFileTypes: true })) {
    if (dir.isDirectory() && dir.name !== 'bank') assert.ok(await readFile(join(root, 'library', dir.name, 'quiz.yaml')).then(() => true, () => false), `library folder ${dir.name} has a quiz.yaml`);
  }

  // The app still works: a real import, a real picture, a real clip, a real photo from a fresh team.
  const host: Headers = { 'x-host-key': server.hostKey, [RIGHT]: true };
  const imported = await send('check', 'POST', `/api/import${query({ name: 'bundle.zip' })}`, host, Buffer.from(zipSync({ 'quiz.yaml': Buffer.from(QUIZ), 'images/a.png': PNG })));
  assert.equal(imported.status, 201, `a real import still works: ${imported.body}`);
  assert.equal((await send('check', 'POST', `/api/quizzes/${quizId}/images?name=a.png`, host, PNG)).status, 201, 'a real picture still works');
  assert.equal((await send('check', 'POST', '/api/clips?name=ok.mp3', host, MP3)).status, 201, 'a real clip still works');
  const fresh = await joinTeam('Fresh Team');
  assert.equal((await send('check', 'POST', '/team-photo', { 'x-team-token': fresh.token }, JPEG, true)).status, 200, 'a real photo still works');

  assert.equal(server.hostKey, keyBefore, 'the host key did not change');
  assert.equal(Object.keys(Object.prototype).length, 0, 'no prototype pollution');
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);

  await Promise.all([team.client.close(), fresh.client.close()]);
  await server.close();
  await sleep(50);
  console.log(`fuzz-http: seed ${SEED}, ${ITERATIONS} per target; statuses ${JSON.stringify(statuses)}`);
});
