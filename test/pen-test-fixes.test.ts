// Weaknesses found by hand-testing the running app: DNS rebinding, endless wrong keys, slow sockets, clip titles.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import WebSocket from 'ws';
import { ClipStore } from '../server/clips.ts';
import { looksLocalName } from '../server/limits.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const quiz = parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n');
const start = () => createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, allowEmptyStart: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });

test('only names that can be on this network count as local', () => {
  for (const name of ['localhost:3000', '192.168.1.20:3000', '[::1]:3000', 'quizlaptop:3000', 'quiz.local', 'laptop.lan']) assert.equal(looksLocalName(name), true, name);
  for (const name of ['evil.com', 'evil.com:3000', 'rebind.attacker.example', 'quiz.local.evil.com', '1.2.3.4.evil.com']) assert.equal(looksLocalName(name), false, name);
});

test('a website whose domain was pointed at this laptop (DNS rebinding) cannot open a connection', async () => {
  const server = await start();
  const attempt = (headers: Record<string, string>) =>
    new Promise<'open' | 'refused'>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers });
      ws.once('open', () => (ws.terminate(), resolve('open')));
      ws.once('unexpected-response', () => resolve('refused'));
      ws.once('error', () => resolve('refused'));
    });
  assert.equal(await attempt({ Origin: 'http://evil.com:3000', Host: 'evil.com:3000' }), 'refused', 'Host and Origin agree, but it is a public name');
  assert.equal(await attempt({ Origin: 'http://localhost:3000', Host: 'localhost:3000' }), 'open', 'the laptop itself');
  assert.equal(await attempt({ Origin: 'http://192.168.1.20:3000', Host: '192.168.1.20:3000' }), 'open', 'a phone on the Wi-Fi');
  await server.close();
});

const FROM_ELSEWHERE = { 'x-forwarded-for': '203.0.113.7' };

test('an address elsewhere that keeps sending wrong keys is paused, over the socket and over HTTP, and the right key then waits', async () => {
  const server = await start();
  const ask = (key: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: FROM_ELSEWHERE });
      ws.once('open', () => ws.send(JSON.stringify({ t: 'host', key })));
      ws.once('message', (data) => (resolve(String((JSON.parse(String(data)) as { message?: string }).message ?? 'state')), ws.terminate()));
      ws.once('error', () => resolve('error'));
    });
  for (let i = 0; i < 20; i++) assert.match(await ask(`wrong-${i}`), /Wrong host key/);
  assert.match(await ask(server.hostKey), /Too many wrong keys/);
  const http = await fetch(`http://127.0.0.1:${server.port}/api/settings`, { headers: { ...FROM_ELSEWHERE, 'x-host-key': server.hostKey } });
  assert.equal(http.status, 429);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/healthz`, { headers: FROM_ELSEWHERE })).status, 200, 'pages that need no key are unaffected');
  const other = (await fetch(`http://127.0.0.1:${server.port}/api/settings`, { headers: { ...FROM_ELSEWHERE, 'x-forwarded-for': '203.0.113.8', 'x-host-key': server.hostKey } })).status;
  assert.ok(other !== 429 && other !== 401, `another address is not affected (got ${other})`);
  await server.close();
});

test('wrong keys over HTTP count too, and the laptop itself is never paused', async () => {
  const server = await start();
  const url = `http://127.0.0.1:${server.port}/api/settings`;
  for (let i = 0; i < 20; i++) assert.equal((await fetch(url, { headers: { ...FROM_ELSEWHERE, 'x-host-key': 'nope' } })).status, 401);
  assert.equal((await fetch(url, { headers: { ...FROM_ELSEWHERE, 'x-host-key': 'nope' } })).status, 429);
  for (let i = 0; i < 30; i++) await fetch(url, { headers: { 'x-host-key': 'nope' } });
  assert.notEqual((await fetch(url, { headers: { 'x-host-key': server.hostKey } })).status, 429, 'the laptop is exempt');
  await server.close();
});

test('a socket that never finishes its request is dropped within seconds', async () => {
  const server = await start();
  const socket = net.connect(server.port, '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nHost: x\r\nX-slow: '));
  const closedAfter = await new Promise<number>((resolve) => {
    const t0 = Date.now();
    socket.on('close', () => resolve(Date.now() - t0));
    socket.on('error', () => undefined);
    socket.resume();
  });
  assert.ok(closedAfter < 20_000, `closed after ${closedAfter} ms`);
  await server.close();
});

test('a clip uploaded with a path in its name gets a title without folders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clips-'));
  const store = new ClipStore(dir);
  const clip = await store.add('../../evil.mp3', new Uint8Array([1, 2, 3]));
  assert.equal(clip.title, 'Evil');
  assert.equal((await store.add('C:\\music\\the-big_one.mp3', new Uint8Array([1]))).title, 'The big one');
  await rm(dir, { recursive: true });
});
