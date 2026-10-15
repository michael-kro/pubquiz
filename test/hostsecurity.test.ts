// Optional host hardening: host-only-from-this-laptop, and replacing the host key.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const quiz = () => parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n');

/** An HTTP GET that carries extra headers, as the internet tunnel's requests do. */
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('with host-local-only, the host key works from the laptop but not through the tunnel', async () => {
  const server = await createQuizServer({ quiz: quiz(), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', hostLocalOnly: true });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  await host.state('lobby');

  const csvKey = `/results.csv?key=${server.hostKey}`;
  assert.equal(await get(server.port, csvKey), 200, 'local');
  assert.equal(await get(server.port, csvKey, { 'cf-connecting-ip': '203.0.113.9' }), 404, 'through the tunnel');
  await host.close();
  await server.close();

  const open = await createQuizServer({ quiz: quiz(), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  assert.equal(await get(open.port, `/results.csv?key=${open.hostKey}`, { 'cf-connecting-ip': '203.0.113.9' }), 200, 'allowed when the setting is off');
  await open.close();
});

test('a new host key cuts off the old host link and the TV link', async () => {
  const server = await createQuizServer({ quiz: quiz(), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const oldKey = server.hostKey;
  const oldScreen = server.screenKey;
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: oldKey });
  await host.state('lobby');
  const second = await Client.connect(server.port);
  second.send({ t: 'host', key: oldKey });
  await second.state('lobby');
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: oldScreen });
  await tv.state('lobby');

  host.send({ t: 'rotate-key' });
  const rotated = await host.waitFor((m) => m.t === 'host-key');
  assert.notEqual(rotated.key, oldKey);
  assert.equal(server.hostKey, rotated.key);
  assert.notEqual(server.screenKey, oldScreen);
  await second.waitFor((m) => m.t === 'error');
  await tv.waitFor((m) => m.t === 'error');
  await host.state('lobby'); // the requesting host carries on

  const stale = await Client.connect(server.port);
  stale.send({ t: 'host', key: oldKey });
  assert.match((await stale.waitFor((m) => m.t === 'error')).message, /Wrong host key/);
  const fresh = await Client.connect(server.port);
  fresh.send({ t: 'host', key: rotated.key });
  await fresh.state('lobby');
  for (const c of [host, second, tv, stale, fresh]) await c.close();
  await server.close();
});
