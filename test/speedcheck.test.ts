// The connection check: how it judges a connection, and that it measures through the link without opening a way
// for anyone else to use the laptop's connection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { judgeSpeed, measureSpeed } from '../server/speedcheck.ts';
import { Client } from './client.ts';

const quiz = parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n');
const start = () => createQuizServer({ quiz, port: 0, allowEmptyStart: true, closeEarly: false, lockOnStart: false, tvShowTeams: true });

test('judgeSpeed: good, OK and weak', () => {
  assert.equal(judgeSpeed(80, 50).level, 'good');
  assert.equal(judgeSpeed(250, 10).level, 'good');
  assert.equal(judgeSpeed(400, 50).level, 'ok', 'a slow round trip is only OK');
  assert.equal(judgeSpeed(80, 5).level, 'ok', 'a slow download is only OK');
  assert.equal(judgeSpeed(700, 50).level, 'weak');
  assert.equal(judgeSpeed(80, 2).level, 'weak');
  assert.match(judgeSpeed(80, 2).message, /hotspot/);
});

test('the speed check download is only for the server itself', async () => {
  const server = await start();
  try {
    const base = `http://127.0.0.1:${server.port}`;
    assert.equal((await fetch(`${base}/speedcheck?bytes=1000`)).status, 404, 'no key');
    assert.equal((await fetch(`${base}/speedcheck?bytes=1000`, { headers: { 'x-speed-key': 'guess' } })).status, 404, 'wrong key');
  } finally {
    await server.close();
  }
});

test('measureSpeed times the round trip and the download, and judges by what arrived when time runs out', async () => {
  // A stand-in link: pings answer at once, the download trickles.
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/healthz')) return new Response('id');
    assert.equal((init?.headers as Record<string, string>)['x-speed-key'], 'k', 'the download carries the key');
    const body = new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (init?.signal?.aborted) return controller.error(new Error('aborted'));
        controller.enqueue(new Uint8Array(10_000));
      },
    });
    return new Response(body);
  }) as typeof fetch;
  const result = await measureSpeed('https://link.example/', { key: 'k', fetch: fakeFetch, downloadMs: 300, pings: 3 });
  assert.equal(result.state, 'done');
  assert.ok(result.latencyMs! < 100, `round trip ${result.latencyMs}`);
  assert.ok(result.mbps! > 0 && result.mbps! < 10, `about 4 Mbit/s expected, got ${result.mbps}`);
  assert.ok(result.level);
});

test('the host sees the check run and its result; a new link clears it', async () => {
  const server = await start();
  const host = await Client.connect(server.port);
  try {
    host.send({ t: 'host', key: server.hostKey });
    await host.state('lobby');
    // Without an internet link there is nothing to measure.
    await server.checkSpeed();
    // The server's own address stands in for the internet link.
    server.setNetwork({ mode: 'tunnel', state: 'up', provider: 'test', publicUrl: `http://127.0.0.1:${server.port}` });
    host.send({ t: 'network', action: 'speed-check' });
    await host.state('lobby', (v) => v.network.speed?.state === 'checking');
    const view = await host.state('lobby', (v) => v.network.speed?.state === 'done', 20_000);
    assert.ok(view.network.speed.mbps > 0);
    assert.ok(['good', 'ok', 'weak'].includes(view.network.speed.level));
    // A status update for the same link keeps the result; a different link drops it.
    server.setNetwork({ ...server.network, maxHours: 2 });
    await host.state('lobby', (v) => v.network.maxHours === 2 && v.network.speed?.state === 'done');
    server.setNetwork({ mode: 'tunnel', state: 'up', provider: 'test', publicUrl: 'https://other.example' });
    await host.state('lobby', (v) => v.network.publicUrl === 'https://other.example' && v.network.speed === undefined);
  } finally {
    await host.close();
    await server.close();
  }
});

test('a team cannot start a speed check', async () => {
  const server = await start();
  const team = await Client.connect(server.port);
  try {
    server.setNetwork({ mode: 'tunnel', state: 'up', provider: 'test', publicUrl: `http://127.0.0.1:${server.port}` });
    team.send({ t: 'network', action: 'speed-check' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const host = await Client.connect(server.port);
    host.send({ t: 'host', key: server.hostKey });
    const view = await host.state('lobby');
    assert.equal(view.network.speed, undefined);
    await host.close();
  } finally {
    await team.close();
    await server.close();
  }
});
