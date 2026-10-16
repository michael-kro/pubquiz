// M8d: audio clips on questions: loading, serving with byte ranges, who gets the link, and library upload/export/import.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { Library } from '../server/library.ts';
import { loadQuizFile, parseQuiz, QuizError } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

/** A real (silent) WAV file: 0.1 s of 8-bit mono at 8 kHz. */
function wav(): Buffer {
  const data = Buffer.alloc(800, 128);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const QUIZ = (q: string) => `title: T\nrounds:\n  - name: R\n    questions:\n      - ${q}\n`;

async function folder(files: Record<string, Buffer | string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pubquiz-audio-'));
  for (const [name, data] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), data);
  }
  return dir;
}

test('a question can name an audio file next to the quiz; it is loaded and given an address', async () => {
  const dir = await folder({ 'quiz.yaml': QUIZ('{ type: music, text: "Name the band", audio: audio/clip.wav, accept: [Queen] }'), 'audio/clip.wav': wav() });
  const quiz = await loadQuizFile(join(dir, 'quiz.yaml'));
  const q = quiz.questions[0]!;
  assert.equal(q.audioUrl, '/media/q1-audio.wav');
  assert.equal(quiz.media.get('q1-audio.wav')!.contentType, 'audio/wav');
  assert.deepEqual(quiz.media.get('q1-audio.wav')!.data, wav());
  assert.equal(parseQuiz(QUIZ('{ type: music, text: Q, audio: "https://example.com/a.mp3", accept: [x] }')).questions[0]!.audioUrl, 'https://example.com/a.mp3');
});

test('problems with audio files are reported clearly', async () => {
  const missing = await folder({ 'quiz.yaml': QUIZ('{ type: music, text: Q, audio: audio/nope.mp3, accept: [x] }') });
  await assert.rejects(loadQuizFile(join(missing, 'quiz.yaml')), (e: QuizError) => /audio: can't find audio\/nope.mp3/.test(e.issues[0]!));
  const wrong = await folder({ 'quiz.yaml': QUIZ('{ type: music, text: Q, audio: notes.txt, accept: [x] }'), 'notes.txt': 'hi' });
  await assert.rejects(loadQuizFile(join(wrong, 'quiz.yaml')), (e: QuizError) => /audio: use a \.mp3/.test(e.issues[0]!));
});

test('clips are served with byte ranges (Safari needs them), and only the host and TV are told where they are', async () => {
  const dir = await folder({ 'quiz.yaml': QUIZ('{ type: music, text: "Name the band", audio: clip.wav, accept: [Queen] }'), 'clip.wav': wav() });
  const quiz = await loadQuizFile(join(dir, 'quiz.yaml'));
  const server = await createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, allowEmptyStart: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const url = `http://127.0.0.1:${server.port}/media/q1-audio.wav`;
  const size = wav().length;

  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/wav');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(full.headers.get('content-length')), size);

  const part = await fetch(url, { headers: { range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-9/${size}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), wav().subarray(0, 10));
  const tail = await fetch(url, { headers: { range: 'bytes=-4' } });
  assert.equal(tail.headers.get('content-range'), `bytes ${size - 4}-${size - 1}/${size}`);
  const open = await fetch(url, { headers: { range: `bytes=${size - 2}-` } });
  assert.equal((await open.arrayBuffer()).byteLength, 2);
  assert.equal((await fetch(url, { headers: { range: `bytes=${size + 5}-` } })).status, 416);
  assert.equal((await fetch(url, { headers: { range: 'bytes=9-3' } })).status, 416);

  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  const team = await Client.connect(server.port);
  team.send({ t: 'join', room: server.roomCode, name: 'Ann' });
  await team.waitFor((m) => m.t === 'joined');
  host.send({ t: 'advance' });
  assert.equal((await host.state('open')).question.audio, '/media/q1-audio.wav');
  assert.equal((await tv.state('open')).question.audio, '/media/q1-audio.wav');
  assert.equal((await team.state('open')).question.audio, undefined, 'phones never play the clip');
  for (const c of [host, tv, team]) await c.close();
  await server.close();
});

test('library: upload a clip, hear it back, export it, import it, duplicate it', async () => {
  const library = new Library(await mkdtemp(join(tmpdir(), 'pubquiz-audio-lib-')));
  const server = await createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, allowEmptyStart: true, library, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const api = `http://127.0.0.1:${server.port}/api`;
  const headers = { 'x-host-key': server.hostKey };
  const call = (path: string, init: RequestInit = {}) => fetch(api + path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });

  const { id } = (await (await call('/quizzes', { method: 'POST' })).json()) as { id: string };
  const up = await call(`/quizzes/${id}/audio?name=${encodeURIComponent('Track 1.WAV')}`, { method: 'POST', body: wav() as unknown as BodyInit });
  assert.equal(up.status, 201);
  const { path } = (await up.json()) as { path: string };
  assert.equal(path, 'audio/track-1.wav');
  assert.equal(((await (await call(`/quizzes/${id}/audio?name=Track 1.wav`, { method: 'POST', body: wav() as unknown as BodyInit })).json()) as { path: string }).path, 'audio/track-1-2.wav', 'never overwrites');
  const heard = await call(`/quizzes/${id}/audio/track-1.wav`);
  assert.equal(heard.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await heard.arrayBuffer()), wav());
  assert.equal((await call(`/quizzes/${id}/audio?name=evil.exe`, { method: 'POST', body: wav() as unknown as BodyInit })).status, 400);
  assert.equal((await call(`/quizzes/${id}/audio?name=empty.mp3`, { method: 'POST', body: new Uint8Array(0) })).status, 400);
  assert.equal((await call(`/quizzes/${id}/audio/..%2Fquiz.yaml`)).status, 404);

  await call(`/quizzes/${id}`, { method: 'PUT', body: JSON.stringify({ title: 'Audio', rounds: [{ name: 'R', questions: [{ type: 'music', text: 'Band?', audio: path, accept: ['Queen'] }] }] }) });
  const zip = new Uint8Array(await (await call(`/quizzes/${id}/export.zip`)).arrayBuffer());
  assert.deepEqual(Object.keys(unzipSync(zip)).sort(), ['audio/track-1.wav', 'quiz.yaml'], 'only the clip the quiz uses is exported');

  const imported = (await (await call('/import?name=audio.zip', { method: 'POST', body: zip as unknown as BodyInit })).json()) as { id: string; issues: unknown[] };
  assert.deepEqual(imported.issues, []);
  assert.deepEqual(Buffer.from(await (await call(`/quizzes/${imported.id}/audio/track-1.wav`)).arrayBuffer()), wav());
  const copy = (await (await call(`/quizzes/${id}/duplicate`, { method: 'POST' })).json()) as { id: string };
  assert.equal((await call(`/quizzes/${copy.id}/audio/track-1.wav`)).status, 200);

  // Audio in a zip is taken only from audio/, with a safe name.
  const sneaky = zipSync({ 'quiz.yaml': strToU8(QUIZ('{ type: music, text: Q, audio: audio/a.wav, accept: [x] }')), 'audio/a.wav': wav(), 'audio/../escape.wav': wav(), 'audio/x.exe': wav() });
  const ok = (await (await call('/import?name=s.zip', { method: 'POST', body: sneaky as unknown as BodyInit })).json()) as { id: string };
  assert.equal((await call(`/quizzes/${ok.id}/audio/a.wav`)).status, 200);
  assert.equal((await call(`/quizzes/${ok.id}/audio/x.exe`)).status, 404);
  await server.close();
});
