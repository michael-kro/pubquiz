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

  const csv = '/results.csv';
  assert.equal(await get(server.port, csv, { 'x-host-key': server.hostKey }), 200, 'local');
  assert.equal(await get(server.port, csv, { 'x-host-key': server.hostKey, 'cf-connecting-ip': '203.0.113.9' }), 404, 'through the tunnel');
  await host.close();
  await server.close();

  const open = await createQuizServer({ quiz: quiz(), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  assert.equal(await get(open.port, '/results.csv', { 'x-host-key': open.hostKey, 'cf-connecting-ip': '203.0.113.9' }), 200, 'allowed when the setting is off');
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

test('out of the box a question is worth 100 points; the tests run with a unit of 1000', async () => {
  const { execFileSync } = await import('node:child_process');
  const env = { ...process.env, PUBQUIZ_POINTS_UNIT: '' };
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "import('./server/quiz.ts').then(m=>console.log(m.POINTS_UNIT, m.DEFAULT_POINTS))"], { env, encoding: 'utf8' });
  assert.equal(out.trim(), '100 100');
});

test('the TV lists teams as they join on the wait screen, never during questions, and the host can hide them', async () => {
  const server = await createQuizServer({ quiz: quiz(), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  const ann = await Client.connect(server.port);
  ann.send({ t: 'join', room: server.roomCode, name: 'Ann' });
  await ann.waitFor((m) => m.t === 'joined');
  const shown = await tv.state('lobby', (v) => v.teams.length === 1);
  assert.deepEqual([shown.teamsHidden, shown.teams[0].name], [false, 'Ann'], 'shown by default, as they join');
  assert.equal((await host.state('lobby', (v) => v.teams.length === 1)).tvShowTeams, true);

  host.send({ t: 'tv-teams', visible: false });
  const hidden = await tv.state('lobby', (v) => v.teamsHidden === true);
  assert.deepEqual(hidden.teams, []);
  host.send({ t: 'tv-teams', visible: true });
  await tv.state('lobby', (v) => v.teamsHidden === false);

  host.send({ t: 'advance' });
  const open = await tv.state('open');
  assert.deepEqual([open.teams, open.teamsHidden], [[], true], 'during the quiz the TV has no team list');
  for (const c of [host, tv, ann]) await c.close();
  await server.close();
});

test('the home page needs no room code: teams just join the one quiz that is running', async () => {
  const server = await createQuizServer({ quiz: quiz(), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const status = await (await fetch(`http://127.0.0.1:${server.port}/status.json`)).json();
  assert.deepEqual(status, { running: true, title: 'T' });

  const plain = await Client.connect(server.port);
  plain.send({ t: 'join', name: 'No Code' });
  assert.equal((await plain.waitFor((m) => m.t === 'joined' || m.t === 'error')).t, 'joined');
  const blank = await Client.connect(server.port);
  blank.send({ t: 'join', room: '  ', name: 'Blank Code' });
  assert.equal((await blank.waitFor((m) => m.t === 'joined' || m.t === 'error')).t, 'joined');
  const stale = await Client.connect(server.port);
  stale.send({ t: 'join', room: 'ZZZZ', name: 'Old Link' });
  assert.match((await stale.waitFor((m) => m.t === 'error')).message, /room code/);
  for (const c of [plain, blank, stale]) await c.close();
  await server.close();
});

test('with no quiz running, the home page says so and nobody can join', async () => {
  const { Library } = await import('../server/library.ts');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const server = await createQuizServer({ library: new Library(await mkdtemp(join(tmpdir(), 'pubquiz-idle-'))), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${server.port}/status.json`)).json(), { running: false, title: '' });
  const c = await Client.connect(server.port);
  c.send({ t: 'join', name: 'Early Bird' });
  assert.match((await c.waitFor((m) => m.t === 'error')).message, /No quiz is running/);
  await c.close();
  await server.close();
});
