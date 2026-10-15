// M3: the internet link. Fake tunnels stand in for cloudflared so these run offline.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import {
  cloudflaredProvider,
  TunnelManager,
  type NetworkStatus,
  type RunningTunnel,
  type TunnelProvider,
} from '../server/tunnel.ts';
import { Client } from './client.ts';

const FAKE_CLOUDFLARED = fileURLToPath(new URL('fixtures/fake-cloudflared.mjs', import.meta.url));

/** Resolves when `statuses` gains an entry matching `match`. */
async function until(statuses: NetworkStatus[], match: (s: NetworkStatus) => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = statuses.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out. Statuses: ${JSON.stringify(statuses)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A tunnel provider whose tunnels the test can kill, handing out a new URL each time. */
function fakeProvider() {
  let count = 0;
  const kills: ((reason: string) => void)[] = [];
  let stops = 0;
  const provider: TunnelProvider = {
    name: 'Fake',
    async start(_port, onExit): Promise<RunningTunnel> {
      count++;
      kills.push(onExit);
      return { url: `https://tunnel-${count}.example`, stop: () => stops++ };
    },
  };
  return { provider, kill: (reason: string) => kills.at(-1)!(reason), stops: () => stops };
}

test('cloudflared: the public URL is read from its log output, ignoring the API address', async () => {
  const tunnel = await cloudflaredProvider(FAKE_CLOUDFLARED).start(1234, () => {});
  assert.equal(tunnel.url, 'https://pretty-random-words-here.trycloudflare.com');
  tunnel.stop();
});

test('cloudflared: a tunnel process that dies is reported, and a missing binary fails to start', async () => {
  process.env.FAKE_TUNNEL_EXIT_AFTER_MS = '150';
  try {
    const died = new Promise<string>((resolve) => {
      void cloudflaredProvider(FAKE_CLOUDFLARED).start(1234, resolve);
    });
    assert.match(await died, /exit code 3/);
  } finally {
    delete process.env.FAKE_TUNNEL_EXIT_AFTER_MS;
  }
  await assert.rejects(cloudflaredProvider('/nonexistent/cloudflared').start(1234, () => {}));
});

test('the manager restarts a tunnel that dies, and reports each step', async () => {
  const fake = fakeProvider();
  const statuses: NetworkStatus[] = [];
  const manager = new TunnelManager({
    provider: fake.provider,
    port: 1,
    check: async () => true,
    onStatus: (s) => statuses.push(s),
    retryDelaysMs: [10],
    firstCheckDelayMs: 1,
  });
  manager.start();
  await until(statuses, (s) => s.state === 'up');
  assert.deepEqual(statuses.slice(0, 3).map((s) => [s.state, s.publicUrl]), [
    ['starting', undefined],
    ['starting', undefined],
    ['up', 'https://tunnel-1.example'],
  ]);
  assert.equal(statuses[1]!.message, 'Checking the internet link works…');

  fake.kill('cloudflared stopped (exit code 1).');
  const down = await until(statuses, (s) => s.state === 'down');
  assert.match(down.message!, /exit code 1.*Retrying/);
  const back = await until(statuses, (s) => s.state === 'up' && s.publicUrl === 'https://tunnel-2.example');
  assert.equal(back.provider, 'Fake');
  manager.stop();
  assert.ok(fake.stops() >= 1);
});

test('the address is only handed out once it reaches this server; a link that never does is replaced', async () => {
  const fake = fakeProvider();
  const statuses: NetworkStatus[] = [];
  let reachable = (url: string) => url !== 'https://tunnel-1.example';
  const manager = new TunnelManager({
    provider: fake.provider,
    port: 1,
    check: async (url) => reachable(url),
    onStatus: (s) => statuses.push(s),
    firstCheckDelayMs: 1,
    startCheckIntervalMs: 5,
    reachTimeoutMs: 60,
    healthIntervalMs: 10,
    retryDelaysMs: [10],
  });
  manager.start();
  const up = await until(statuses, (s) => s.state === 'up');
  assert.equal(up.publicUrl, 'https://tunnel-2.example', 'tunnel 1 never became reachable');
  assert.ok(statuses.some((s) => s.state === 'down' && /didn't become reachable/.test(s.message!)));
  assert.ok(!statuses.some((s) => s.publicUrl === 'https://tunnel-1.example'));

  // Later the working link stops reaching this laptop: it is replaced.
  reachable = (url) => url === 'https://tunnel-3.example';
  const down = await until(statuses, (s) => s.state === 'down' && /stopped reaching/.test(s.message!));
  assert.ok(down);
  await until(statuses, (s) => s.state === 'up' && s.publicUrl === 'https://tunnel-3.example');
  manager.stop();
});

test('stopping the manager cancels pending retries', async () => {
  const statuses: NetworkStatus[] = [];
  const manager = new TunnelManager({
    provider: {
      name: 'Broken',
      start: async () => {
        throw new Error('No internet.');
      },
    },
    port: 1,
    check: async () => true,
    onStatus: (s) => statuses.push(s),
    retryDelaysMs: [30],
  });
  manager.start();
  await until(statuses, (s) => s.state === 'down');
  manager.stop();
  const count = statuses.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(statuses.length, count);
});

test('the server switches its join link and QR code with the network, and the host can switch modes', async () => {
  const quiz = parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n');
  const actions: string[] = [];
  const server = await createQuizServer({ closeEarly: true, lockOnStart: false,
    quiz,
    port: 0,
    bindHost: '127.0.0.1',
    publicHost: '127.0.0.1',
    onNetworkAction: (action) => actions.push(action),
  });
  const base = `http://127.0.0.1:${server.port}`;
  assert.equal(await (await fetch(`${base}/healthz`)).text(), server.instanceId);

  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const first = await host.state('lobby');
  assert.equal(first.joinUrl, server.lanJoinUrl);
  const qrBefore = await (await fetch(`${base}/qr.svg`)).text();

  server.setNetwork({ mode: 'tunnel', state: 'starting', provider: 'Fake' });
  await host.state('lobby', (v) => v.network.state === 'starting');
  server.setNetwork({ mode: 'tunnel', state: 'up', provider: 'Fake', publicUrl: 'https://quiz.example' });
  const up = await host.state('lobby', (v) => v.network.state === 'up');
  assert.equal(up.joinUrl, `https://quiz.example/?room=${server.roomCode}`);
  assert.equal(server.joinUrl, up.joinUrl);
  assert.ok(up.qrVersion > first.qrVersion);
  assert.notEqual(await (await fetch(`${base}/qr.svg`)).text(), qrBefore);

  server.setNetwork({ mode: 'tunnel', state: 'down', provider: 'Fake', message: 'Gone.' });
  const down = await host.state('lobby', (v) => v.network.state === 'down');
  assert.equal(down.joinUrl, server.lanJoinUrl, 'falls back to the local link while the internet link is down');

  host.send({ t: 'network', action: 'use-lan' });
  const team = await Client.connect(server.port);
  team.send({ t: 'network', action: 'use-tunnel' });
  assert.match((await team.waitFor((m) => m.t === 'error')).message, /Only the host/);
  assert.deepEqual(actions, ['use-lan']);

  for (const c of [host, team]) await c.close();
  await server.close();
});

test('a team can carry on from another phone (or a new link) with its team code', async () => {
  const quiz = parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n');
  const server = await createQuizServer({ closeEarly: true, lockOnStart: false, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const phone = await Client.connect(server.port);
  phone.send({ t: 'join', room: server.roomCode, name: 'Quizzy' });
  await phone.waitFor((m) => m.t === 'joined');
  const { teamCode } = await phone.state('lobby');
  assert.match(teamCode, /^[A-HJ-NP-Z2-9]{6}$/);

  const other = await Client.connect(server.port);
  other.send({ t: 'rejoin', code: ` ${teamCode.toLowerCase()} ` });
  const joined = await other.waitFor((m) => m.t === 'joined');
  assert.equal(joined.teamName, 'Quizzy');
  assert.ok(joined.token, 'the new phone gets its own saved login');
  await phone.waitFor((m) => m.t === 'replaced');

  const stranger = await Client.connect(server.port);
  stranger.send({ t: 'rejoin', code: 'ZZZZZZ' });
  await stranger.waitFor((m) => m.t === 'rejoin-failed');
  stranger.send({ t: 'rejoin' });
  await stranger.waitFor((m) => m.t === 'rejoin-failed');

  for (const c of [phone, other, stranger]) await c.close();
  await server.close();
});
