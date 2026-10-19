// Testing mode: with openHost the page can get the keys without the link.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const QUIZ = `
title: Open
rounds:
  - name: R
    questions:
      - { type: multiple-choice, text: Q1, options: [a, b], answer: 0 }
`;

async function login(port: number, body?: object) {
  const res = await fetch(`http://127.0.0.1:${port}/login`, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : undefined);
  return { status: res.status, data: (await res.json()) as { key?: string; open?: boolean; pin?: boolean } };
}

test('by default there is no keyless sign-in', async () => {
  const server = await createQuizServer({ quiz: parseQuiz(QUIZ), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  assert.deepEqual((await login(server.port)).data, { pin: false });
  assert.equal((await login(server.port, { pin: '' })).status, 404);
  await server.close();
});

test('openHost hands the host key (or the TV key) to the page, and the host key then works', async () => {
  const server = await createQuizServer({ openHost: true, quiz: parseQuiz(QUIZ), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  assert.equal((await login(server.port)).data.open, true);
  const host = await login(server.port, { pin: '' });
  assert.equal(host.data.key, server.hostKey);
  const tv = await login(server.port, { pin: '', screen: true });
  assert.notEqual(tv.data.key, server.hostKey);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/screen?key=${tv.data.key}`)).status, 200);
  await server.close();
});

test('openHost still respects --host-local-only', async () => {
  const server = await createQuizServer({ openHost: true, hostLocalOnly: true, quiz: parseQuiz(QUIZ), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  assert.equal((await login(server.port, { pin: '' })).data.key, server.hostKey, 'the laptop itself is allowed');
  await server.close();
});

test('the host view says the testing switch is on (so the page can warn), and says nothing otherwise', async () => {
  for (const openHost of [true, false]) {
    const server = await createQuizServer({ openHost, quiz: parseQuiz(QUIZ), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
    const host = await Client.connect(server.port);
    host.send({ t: 'host', key: server.hostKey });
    const view = await host.state('lobby');
    assert.equal(view.openHost, openHost ? true : undefined);
    await host.close();
    await server.close();
  }
});
