// The host's soundboard: clips kept in a folder, played whenever the host likes, here or on the TV.
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ClipError, ClipStore } from '../server/clips.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const MP3 = Buffer.from('ID3-pretend-this-is-an-mp3-file-with-some-bytes');

test('the clip store lists, titles, adds without overwriting, and refuses bad files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pubquiz-clips-'));
  const store = new ClipStore(dir);
  assert.deepEqual(await store.list(), [], 'empty folder, nothing to list');
  const a = await store.add('Are You Not Entertained.MP3', MP3);
  assert.deepEqual([a.name, a.title], ['are-you-not-entertained.mp3', 'Are You Not Entertained']);
  const b = await store.add('are-you-not-entertained.mp3', MP3, '  Maximus ​ ');
  assert.equal(b.name, 'are-you-not-entertained-2.mp3', 'never overwrites');
  assert.equal(b.title, 'Maximus', 'a title can be given, and is tidied');
  assert.deepEqual((await store.list()).map((c) => c.title), ['Are You Not Entertained', 'Maximus']);
  await assert.rejects(store.add('notes.txt', MP3), ClipError);
  await assert.rejects(store.add('x.mp3', Buffer.alloc(0)), /empty/);
  await assert.rejects(store.add('x.mp3', Buffer.alloc(21 * 1024 * 1024)), /20 MB/);
  assert.deepEqual((await store.read(b.name)).contentType, 'audio/mpeg');
  await assert.rejects(store.read('../quiz.yaml'), ClipError);
  await assert.rejects(store.remove('../../etc/passwd'), ClipError);
  await store.remove(a.name);
  assert.deepEqual((await store.list()).map((c) => c.name), [b.name]);
  assert.ok(!(await readdir(dir)).includes(a.name));
});

test('over HTTP and the socket: only the host manages clips, the TV is sent the right link, and playback supports ranges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pubquiz-clips-'));
  const server = await createQuizServer({ quiz: parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n'), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', clipsDir: dir });
  const base = `http://127.0.0.1:${server.port}`;
  const auth = { 'x-host-key': server.hostKey };

  assert.equal((await fetch(`${base}/api/clips`)).status, 401, 'no key, no list');
  assert.deepEqual(await (await fetch(`${base}/api/clips`, { headers: auth })).json(), []);
  const added = await fetch(`${base}/api/clips?name=${encodeURIComponent('Hasta la vista.mp3')}`, { method: 'POST', headers: auth, body: MP3 });
  assert.equal(added.status, 201);
  const clip = (await added.json()) as { name: string; title: string };
  assert.equal(clip.title, 'Hasta la vista');
  assert.equal((await fetch(`${base}/api/clips?name=evil.exe`, { method: 'POST', headers: auth, body: MP3 })).status, 400);
  assert.equal((await fetch(`${base}/api/clips?name=x.mp3`, { method: 'POST', body: MP3 })).status, 401);

  // Playing: the host or the TV may fetch the file, nobody else; ranges work.
  const play = `${base}/clip/${clip.name}`;
  assert.equal((await fetch(play, { headers: { 'x-host-key': 'wrong' } })).status, 404);
  assert.equal((await fetch(`${play}?key=${server.hostKey}`)).status, 404, 'a key in the address is not accepted');
  const whole = await fetch(play, { headers: { 'x-host-key': server.hostKey } });
  assert.deepEqual([whole.status, whole.headers.get('content-type')], [200, 'audio/mpeg']);
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), MP3);
  const part = await fetch(play, { headers: { 'x-screen-key': server.screenKey, range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 10);

  // The host presses "play on TV": the TV (only the TV) is sent a link it is allowed to use.
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  const ann = await Client.connect(server.port);
  ann.send({ t: 'join', room: server.roomCode, name: 'Ann' });
  await ann.waitFor((m) => m.t === 'joined');
  await tv.state('lobby');
  ann.send({ t: 'play-clip', name: clip.name });
  assert.match((await ann.waitFor((m) => m.t === 'error')).message, /Only the host/);
  host.send({ t: 'play-clip', name: clip.name });
  const told = await tv.waitFor((m) => m.t === 'play-clip');
  assert.equal(told.title, 'Hasta la vista');
  assert.equal(told.name, clip.name, 'the TV is told which clip, and fetches it with its own key');
  assert.equal((await fetch(play, { headers: { 'x-screen-key': server.screenKey } })).status, 200);
  host.send({ t: 'play-clip', name: 'missing.mp3' });
  assert.match((await host.waitFor((m) => m.t === 'error')).message, /gone/);
  host.send({ t: 'stop-clips' });
  await tv.waitFor((m) => m.t === 'stop-clips');

  assert.equal((await fetch(`${base}/api/clips/${clip.name}`, { method: 'DELETE', headers: auth })).status, 200);
  assert.equal((await fetch(play, { headers: { 'x-host-key': server.hostKey } })).status, 404);
  for (const c of [host, tv, ann]) await c.close();
  await server.close();
});
