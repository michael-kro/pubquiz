// M8f: team photos: checking uploads, serving them, showing them, moderating them, and keeping them across a restart.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_PHOTO_BYTES, PhotoStore, sniffImage } from '../server/photos.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer, type QuizServer } from '../server/server.ts';
import { readSession } from '../server/session.ts';
import { Client } from './client.ts';

const quiz = parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n');
const jpeg = (size = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(size, 7)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);

test('sniffing: images are recognised by their bytes, not by what the uploader says', () => {
  assert.equal(sniffImage(jpeg()), 'image/jpeg');
  assert.equal(sniffImage(png), 'image/png');
  assert.equal(sniffImage(Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.alloc(20)])), 'image/webp');
  assert.equal(sniffImage(Buffer.from('GIF89a' + 'x'.repeat(30))), undefined);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')), undefined, 'no SVG, which can carry scripts');
  assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script>')), undefined);
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff])), undefined, 'too short to be a picture');
});

test('the store hands out new versions, forgets, saves to a file and reloads only real images', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'pubquiz-photos-')), 'quiz.photos.json');
  const store = new PhotoStore(path);
  const v1 = store.set('a', jpeg(), 'image/jpeg');
  const v2 = store.set('a', png, 'image/png');
  assert.ok(v2 > v1, 'a new picture is a new version');
  store.set('b', jpeg(), 'image/jpeg');
  assert.equal(store.remove('b'), true);
  assert.equal(store.remove('b'), false);
  await store.flush();
  const again = await PhotoStore.load(path);
  assert.deepEqual([...again.versions()], [['a', v2]]);
  assert.equal(again.get('a')!.contentType, 'image/png');
  assert.ok(again.set('c', jpeg(), 'image/jpeg') > v2, 'versions carry on, never repeat');
  const store2 = new PhotoStore(path);
  await (await import('node:fs/promises')).writeFile(path, JSON.stringify({ x: { v: 1, t: 'image/jpeg', d: Buffer.from('<script>').toString('base64') } }));
  assert.equal((await PhotoStore.load(path)).get('x'), undefined, 'a file that is not an image is ignored');
  assert.equal(store2.get('a'), undefined);
});

async function start(extra: Parameters<typeof createQuizServer>[0] = {}): Promise<QuizServer> {
  return createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', ...extra });
}

async function joinTeam(server: QuizServer, name: string) {
  const client = await Client.connect(server.port);
  client.send({ t: 'join', room: server.roomCode, name });
  const joined = await client.waitFor((m) => m.t === 'joined');
  return { client, token: joined.token as string };
}

const upload = (server: QuizServer, token: string | undefined, body: Buffer, method = 'POST') =>
  fetch(`http://127.0.0.1:${server.port}/team-photo`, { method, headers: token ? { 'x-team-token': token } : {}, body: method === 'POST' ? (body as unknown as BodyInit) : undefined });

test('a team uploads a photo; it is served safely and shows up for the team, the host and the TV', async () => {
  const server = await start();
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  const ann = await joinTeam(server, 'Ann');

  const res = await upload(server, ann.token, jpeg());
  assert.equal(res.status, 200);
  const { photo } = (await res.json()) as { photo: string };
  assert.match(photo, /^\/team-photo\/[0-9a-f-]{36}\?v=\d+$/);

  const served = await fetch(`http://127.0.0.1:${server.port}${photo}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/jpeg');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.match(served.headers.get('cache-control') ?? '', /immutable/);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), jpeg());

  assert.equal((await ann.client.state('lobby', (v) => v.photo === photo)).photo, photo);
  assert.equal((await host.state('lobby', (v) => v.teams[0]?.photo === photo)).teams[0].photo, photo);
  assert.equal((await tv.state('lobby', (v) => v.teams[0]?.photo === photo)).teams[0].photo, photo);

  // A new picture is a new address, so nobody sees a stale one.
  const second = (await (await upload(server, ann.token, png)).json()) as { photo: string };
  assert.notEqual(second.photo, photo);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}${second.photo}`)).headers.get('content-type'), 'image/png');

  // It appears on the leaderboard rows too.
  host.send({ t: 'advance' });
  await ann.client.state('open');
  ann.client.send({ t: 'answer', value: 'A' });
  await host.state('closed');
  host.send({ t: 'advance' });
  host.send({ t: 'advance' });
  const board = await host.state('leaderboard');
  assert.equal(board.standings[0].photo, second.photo);
  for (const c of [host, tv, ann.client]) await c.close();
  await server.close();
});

test('uploads are checked: who, what, how big, how often', async () => {
  const server = await start();
  const ann = await joinTeam(server, 'Ann');
  assert.equal((await upload(server, undefined, jpeg())).status, 401, 'no login');
  assert.equal((await upload(server, 'not-a-token', jpeg())).status, 401, 'wrong login');
  assert.equal((await upload(server, ann.token, Buffer.from('<svg onload=alert(1)/>' + ' '.repeat(50)))).status, 415, 'not a photo');
  assert.equal((await upload(server, ann.token, jpeg(MAX_PHOTO_BYTES + 10))).status, 413, 'too big');
  assert.equal((await upload(server, ann.token, Buffer.alloc(0))).status, 415);
  for (let i = 0; i < 5; i++) assert.equal((await upload(server, ann.token, jpeg(500 + i))).status, 200);
  assert.equal((await upload(server, ann.token, jpeg(900))).status, 429, 'a sixth in a minute is refused');
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/team-photo/not-a-team`)).status, 404);
  await ann.client.close();
  await server.close();
});

test('a team can remove its own photo', async () => {
  const server = await start();
  const ann = await joinTeam(server, 'Ann');
  const { photo } = (await (await upload(server, ann.token, jpeg())).json()) as { photo: string };
  assert.equal((await upload(server, ann.token, Buffer.alloc(0), 'DELETE')).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}${photo}`)).status, 404);
  assert.equal((await ann.client.state('lobby', (v) => v.photo === undefined)).photo, undefined);
  assert.equal((await upload(server, 'bad', Buffer.alloc(0), 'DELETE')).status, 401);
  await ann.client.close();
  await server.close();
});

test('the host removes a photo, switches photos off and on, and only the host can', async () => {
  const server = await start();
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const ann = await joinTeam(server, 'Ann');
  const bob = await joinTeam(server, 'Bob');
  const a = (await (await upload(server, ann.token, jpeg(10))).json()) as { photo: string };
  const b = (await (await upload(server, bob.token, jpeg(20))).json()) as { photo: string };
  const teamId = (await host.state('lobby', (v) => v.teams.length === 2)).teams.find((t: { name: string }) => t.name === 'Ann').id;

  // Teams cannot moderate.
  bob.client.send({ t: 'remove-photo', teamId });
  bob.client.send({ t: 'photos', enabled: false });
  assert.equal((await bob.client.waitFor((m) => m.t === 'error')).message, 'Only the host can do that.');
  assert.equal((await fetch(`http://127.0.0.1:${server.port}${a.photo}`)).status, 200);

  host.send({ t: 'remove-photo', teamId });
  await host.state('lobby', (v) => v.teams.find((t: { name: string }) => t.name === 'Ann').photo === undefined);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}${a.photo}`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}${b.photo}`)).status, 200, "Bob's is untouched");

  host.send({ t: 'photos', enabled: false });
  const off = await host.state('lobby', (v) => v.photosEnabled === false);
  assert.ok(off.teams.every((t: { photo?: string }) => t.photo === undefined), 'hidden while off');
  assert.equal((await bob.client.state('lobby', (v) => v.photosEnabled === false)).photo, undefined);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}${b.photo}`)).status, 404, 'not served while off');
  assert.equal((await upload(server, ann.token, jpeg())).status, 403);

  host.send({ t: 'photos', enabled: true });
  const on = await host.state('lobby', (v) => v.photosEnabled === true);
  assert.equal(on.teams.find((t: { name: string }) => t.name === 'Bob').photo, b.photo, 'still there when switched back on');
  for (const c of [host, ann.client, bob.client]) await c.close();
  await server.close();
});

test('removing a team removes its photo; --no-photos starts with photos off', async () => {
  const server = await start();
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const ann = await joinTeam(server, 'Ann');
  const { photo } = (await (await upload(server, ann.token, jpeg())).json()) as { photo: string };
  const teamId = (await host.state('lobby', (v) => v.teams.length === 1)).teams[0].id;
  host.send({ t: 'kick', teamId });
  await host.state('lobby', (v) => v.teams.length === 0);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}${photo}`)).status, 404);
  await host.close();
  await ann.client.close();
  await server.close();

  const off = await start({ photos: false });
  const bob = await joinTeam(off, 'Bob');
  assert.equal((await upload(off, bob.token, jpeg())).status, 403);
  assert.equal((await bob.client.state('lobby')).photosEnabled, false);
  await bob.client.close();
  await off.close();
});

test('photos survive a restart with the game, and a fresh game starts without them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pubquiz-photos-'));
  const session = { path: join(dir, 'quiz.session.json'), quizHash: 'h' };
  const first = await start({ session });
  const ann = await joinTeam(first, 'Ann');
  const { photo } = (await (await upload(first, ann.token, jpeg(321))).json()) as { photo: string };
  await ann.client.close();
  await first.close();

  const saved = await readSession(session.path);
  assert.ok(saved);
  const second = await start({ session: { ...session, resume: saved } });
  assert.equal((await fetch(`http://127.0.0.1:${second.port}${photo}`)).status, 200, 'the picture came back');
  const again = await Client.connect(second.port);
  again.send({ t: 'rejoin', token: ann.token });
  await again.waitFor((m) => m.t === 'joined');
  assert.equal((await again.state('lobby')).photo, photo);
  await again.close();
  await second.close();

  const fresh = await start({ session });
  const stranger = await joinTeam(fresh, 'Cat');
  assert.equal((await stranger.client.state('lobby')).photo, undefined, 'a new game does not inherit old photos');
  assert.equal(fresh.game!.hostView().teams.length, 1);
  await stranger.client.close();
  await fresh.close();
  assert.equal((await PhotoStore.load(join(dir, 'quiz.photos.json'))).versions().size, 0, 'and the old file was cleared');
});
