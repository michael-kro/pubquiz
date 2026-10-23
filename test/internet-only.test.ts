// The quiz is never offered over plain HTTP on the local network: it listens on this machine only, and the
// options that put it on the Wi-Fi are gone.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { test } from 'node:test';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';

const quiz = parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n');

test('by default the server listens on this machine only, not on the Wi-Fi address', async (t) => {
  const lan = Object.values(networkInterfaces()).flatMap((list) => list ?? []).find((i) => i.family === 'IPv4' && !i.internal);
  const server = await createQuizServer({ quiz, port: 0, allowEmptyStart: true, closeEarly: false, lockOnStart: false, tvShowTeams: true });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status, 200, 'the laptop itself can reach it');
    assert.match(server.localJoinUrl, /^http:\/\/localhost:/);
    if (!lan) return t.skip('this machine has no network address to try');
    await assert.rejects(fetch(`http://${lan.address}:${server.port}/healthz`, { signal: AbortSignal.timeout(3000) }), 'the network address does not answer');
  } finally {
    await server.close();
  }
});

const run = (...args: string[]) => spawnSync(process.execPath, ['server/main.ts', '--no-open', '-p', '0', ...args], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, PUBQUIZ_CONFIG_DIR: '/nonexistent-pubquiz-test' } });

test('the options that put the quiz on the local network were removed, and say why', () => {
  for (const flag of [['--lan'], ['--public-host', 'x'], ['--wifi-ssid', 'x']]) {
    const result = run(...flag);
    assert.equal(result.status, 1, flag.join(' '));
    assert.match(result.stderr, /was removed.*plain HTTP/s, flag.join(' '));
  }
});

test('an own address must be https, except localhost for trying things out', () => {
  const result = run('--public-url', 'http://quiz.example.com');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must start with https/);
});
