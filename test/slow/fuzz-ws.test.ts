// WebSocket fuzzing. Every message the server gets is schema-checked before it is handled; this test works the
// edges around that: junk, oversized frames, binary, floods, well-formed messages at the wrong moment, and commands
// from the wrong role, sent as a stranger, a team, the TV and the host. The server must stay up and keep answering,
// nobody but the host may change a setting, no answer may reach a phone or the TV before the reveal, and a quiz
// must still be playable to the end afterwards.
//
// Deterministic: FUZZ_SEED picks the sequence and FUZZ_ITERATIONS (default 120 per role) the length, so a failure
// can be replayed. A long run: FUZZ_ITERATIONS=2000 npm run test:slow
import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { CLIENT_MESSAGE_TYPES } from '../../server/protocol.ts';
import { parseQuiz } from '../../server/quiz.ts';
import { createQuizServer, type QuizServer } from '../../server/server.ts';

const ITERATIONS = Math.max(40, Number(process.env['FUZZ_ITERATIONS'] ?? 120));
const SEED = Number(process.env['FUZZ_SEED'] ?? 20261021);
/** Strings that exist only in answers. If one of them reaches a phone or the TV before the reveal, that is a leak. */
const SECRETS = ['Secretname', '7777777', 'SECRETTUNE', 'SECRETBUZZ', '424242'];
const REVEALED = new Set(['reveal', 'leaderboard', 'finished']);

const QUIZ = `
title: Fuzz
rounds:
  - name: One
    questions:
      - { type: letter, text: Q1, answer: Zyxwvu Secretname, seconds: 90 }
      - { type: number, text: Q2, answer: 7777777, seconds: 90 }
      - { type: multiple-choice, text: Q3, options: [a, b, c], answer: 2, seconds: 90 }
      - { type: music, text: Q4, accept: [SECRETTUNE], seconds: 90 }
      - { type: buzzer, text: Q5, answer: SECRETBUZZ, seconds: 90 }
  - name: Final
    wager: true
    questions:
      - { type: number, text: Q6, category: Numbers, answer: 424242, seconds: 90 }
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A small seeded random generator, so the same seed always gives the same messages. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIELDS = ['key', 'name', 'room', 'token', 'code', 'value', 'elapsedMs', 'seconds', 'minutes', 'visible', 'teamId', 'shown', 'on', 'locked', 'max', 'fee', 'prizes', 'amount', 'correct', 'enabled', 'action', 'id', 't'];
const NASTY = ['', 'constructor', '__proto__', 'prototype', '../../etc/passwd', "' OR 1=1 --", '<script>alert(1)</script>', '%s%s%n', 'x'.repeat(3000), '\u0000', '‮evil', 'null', 'undefined', 'NaN'];
const POOLS = ['abcdefghijklmnopqrstuvwxyz ABC0123456789', '\u0000​‮⁦﻿', '😀🍺🎉👨‍👩‍👧', '<>"\'&;`$(){}[]\\/', 'ÄöüßÆØåéñ中文العربية'];

class Generator {
  private readonly r: () => number;
  constructor(seed: number) {
    this.r = mulberry32(seed);
  }
  int(n: number): number {
    return Math.floor(this.r() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
  chance(p: number): boolean {
    return this.r() < p;
  }
  string(max = 60): string {
    if (this.chance(0.2)) return this.pick(NASTY);
    const pool = this.pick(POOLS);
    const n = this.int(max);
    let s = '';
    for (let i = 0; i < n; i++) s += pool[this.int(pool.length)];
    return s;
  }
  junk(depth = 2): unknown {
    const k = this.int(depth > 0 ? 14 : 10);
    switch (k) {
      case 0: return null;
      case 1: return this.chance(0.5);
      case 2: return this.pick([0, -1, 1, 2 ** 31, 2 ** 53, -(2 ** 53), 1e308, -1e308, 3.5, -0.001, 1e-9]);
      case 3: return '';
      case 4: case 5: return this.string();
      case 6: return this.string(3000);
      case 7: return [];
      case 8: return {};
      case 9: return Array.from({ length: 200 }, (_, i) => i);
      case 10: return Array.from({ length: this.int(6) }, () => this.junk(depth - 1));
      default: {
        const o: Record<string, unknown> = {};
        for (let i = this.int(5); i >= 0; i--) o[this.chance(0.15) ? this.pick(['__proto__', 'constructor', 'prototype']) : this.pick(FIELDS)] = this.junk(depth - 1);
        return o;
      }
    }
  }
  /** A well-formed message of this type with values that might be sensible, so out-of-order logic gets exercised too. */
  plausible(type: string): Record<string, unknown> {
    const b = () => this.pick([true, false, 'yes', 1]);
    const id = () => this.pick(['x', 'nobody', this.string(20)]);
    const by: Record<string, () => Record<string, unknown>> = {
      host: () => ({ key: this.string(30) }),
      screen: () => ({ key: this.string(30) }),
      join: () => ({ name: this.pick(['Fuzz Guest', this.string(), 'A'.repeat(200), 'B'.repeat(201), '  ', 'Shit Happens']), ...(this.chance(0.3) ? { room: this.string(6) } : {}) }),
      rejoin: () => (this.chance(0.5) ? { token: this.string(40) } : { code: this.string(6) }),
      answer: () => ({ value: this.pick<unknown>([0, 1, 2, 3, 99, -1, 'abc', '7', 'B', [0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [0, 0, 0, 0, 0], [1], [], 'x'.repeat(200), 12345]), ...(this.chance(0.5) ? { elapsedMs: this.pick([0, 5, 999_999, 1_000_001, -1]) } : {}) }),
      extend: () => ({ seconds: this.pick([1, 10, 120, 121, 0, -5]) }),
      break: () => ({ minutes: this.pick([1, 5, 60, 61, 0]) }),
      'set-answer': () => ({ value: this.pick<unknown>([0, 1, 2, 'A', 'ABCD', 'ABCDE', 12345]) }),
      'tv-teams': () => ({ visible: b() }),
      'tv-questions': () => ({ visible: b() }),
      'head-start': () => ({ teamId: id(), seconds: this.pick([0, 5, 30, 31, -1]) }),
      'show-join': () => ({ shown: b() }),
      'read-out': () => ({ on: b() }),
      'lock-joining': () => ({ locked: b() }),
      'allow-empty-start': () => ({ on: b() }),
      'set-max-teams': () => ({ max: this.pick([1, 30, 100, 101, 0]) }),
      'play-clip': () => ({ name: this.pick(['a.mp3', '../../x', 'x'.repeat(100)]) }),
      admit: () => ({ teamId: id() }),
      'set-entry-fee': () => ({ fee: this.string(80) }),
      'require-admission': () => ({ on: b() }),
      'set-prizes': () => ({ prizes: Array.from({ length: this.int(5) }, () => this.string(120)) }),
      'lock-on-start': () => ({ on: b() }),
      'start-on-last': () => ({ on: b() }),
      'close-early': () => ({ on: b() }),
      wager: () => ({ amount: this.pick([0, 200, 1_000_000, 1_000_001, -1, 2.5]) }),
      buzz: () => (this.chance(0.5) ? { elapsedMs: this.pick([0, 50, -1]) } : {}),
      judge: () => ({ correct: b() }),
      kick: () => ({ teamId: id() }),
      mark: () => ({ key: this.string(), correct: b() }),
      network: () => ({ action: this.pick(['use-lan', 'use-tunnel', 'nope']) }),
      photos: () => ({ enabled: b() }),
      'remove-photo': () => ({ teamId: id() }),
    };
    return { t: type, ...(by[type]?.() ?? {}) };
  }
  /** One thing to send: what it is, and the payload. */
  next(): { kind: string; payload: string | Buffer } {
    const roll = this.r();
    if (roll < 0.12) {
      const broken = ['{', '[1,2', 'null', '"abc"', '42', '{"t":}', '', ' ', '{"t":"advance"}trailing', '['.repeat(1500) + ']'.repeat(1500), '{"t":"join","name":"a\\u0000b"}', '￿￾', '{"t":"advance","t":"pause"}'];
      return { kind: 'invalid-json', payload: this.chance(0.8) ? this.pick(broken) : this.string(200) };
    }
    if (roll < 0.17) return { kind: 'binary', payload: Buffer.from(Array.from({ length: 1 + this.int(600) }, () => this.int(256))) };
    if (roll < 0.21) return { kind: 'oversized', payload: `{"t":"join","name":"${'a'.repeat(5000)}"}` };
    if (roll < 0.31) return { kind: 'unknown-type', payload: JSON.stringify({ t: this.string(), [this.pick(FIELDS)]: this.junk() }) };
    if (roll < 0.66) {
      const o: Record<string, unknown> = { t: this.pick(CLIENT_MESSAGE_TYPES) };
      for (let i = this.int(4); i >= 0; i--) o[this.chance(0.1) ? this.pick(['__proto__', 'constructor', 'prototype']) : this.pick(FIELDS)] = this.junk();
      return { kind: 'known-type-junk', payload: JSON.stringify(o) };
    }
    return { kind: 'plausible', payload: JSON.stringify(this.plausible(this.pick(CLIENT_MESSAGE_TYPES))) };
  }
}

interface Role {
  name: string;
  auth: (role: Role) => Promise<void>;
  ws?: WebSocket;
  received: string[];
  badFrames: string[];
  leaks: string[];
  reconnects: number;
  token?: string;
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function attach(role: Role, ws: WebSocket): void {
  role.ws = ws;
  ws.on('error', () => {});
  ws.on('message', (data) => {
    const raw = data.toString();
    role.received.push(raw);
    let message: { t?: unknown; view?: { phase?: string } } | undefined;
    try {
      message = JSON.parse(raw);
    } catch {
      role.badFrames.push(raw.slice(0, 120));
      return;
    }
    if (typeof message?.t !== 'string') role.badFrames.push(raw.slice(0, 120));
    // What a phone or the TV is sent must never carry an answer before the reveal.
    const phase = message?.t === 'state' ? message.view?.phase : undefined;
    if (role.name !== 'host' && !(phase && REVEALED.has(phase)) && SECRETS.some((s) => raw.includes(s))) role.leaks.push(raw.slice(0, 200));
  });
}

async function waitFor(role: Role, from: number, match: (m: { t?: string; [k: string]: unknown }) => boolean, timeoutMs = 4000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = from; i < role.received.length; i++) {
      try {
        const m = JSON.parse(role.received[i]!);
        if (match(m)) return m;
      } catch {
        // Not JSON: already recorded as a bad frame.
      }
    }
    await sleep(25);
  }
  throw new Error(`${role.name}: timed out waiting for a message`);
}

test('WebSocket fuzzing: junk, floods and wrong-role commands from every role; the server stays up and leaks nothing', { timeout: 170_000 }, async (t) => {
  const server: QuizServer = await createQuizServer({ quiz: parseQuiz(QUIZ), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', allowEmptyStart: true, closeEarly: false, lockOnStart: false, tvShowTeams: true });
  const gen = new Generator(SEED);
  const counts: Record<string, number> = {};

  const ensureOpen = async (role: Role) => {
    if (role.ws && role.ws.readyState === WebSocket.OPEN) return;
    if (role.ws) role.reconnects++;
    attach(role, await connect(server.port));
    await role.auth(role);
  };
  const send = (role: Role, payload: string | Buffer | object) => {
    try {
      role.ws!.send(typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
    } catch {
      // A closing socket; the next ensureOpen reconnects.
    }
  };

  /** Sends `n` fuzzed messages, paced under the server's rate limit so they reach the parser rather than the flood guard. */
  const fuzz = async (role: Role, n: number) => {
    for (let i = 0; i < n; i++) {
      await ensureOpen(role);
      const { kind, payload } = gen.next();
      counts[kind] = (counts[kind] ?? 0) + 1;
      send(role, payload);
      if (i >= 25 && i % 9 === 0) await sleep(1000);
    }
    await sleep(400);
  };
  /** 400 messages as fast as possible: the flood guard must answer "Slow down." and then hang up, and the server must not care. */
  const flood = async (role: Role) => {
    await ensureOpen(role);
    const from = role.received.length;
    for (let i = 0; i < 400; i++) send(role, { t: 'advance' });
    await sleep(1500);
    const slowed = role.received.slice(from).some((raw) => raw.includes('Slow down.'));
    assert.ok(slowed || role.ws!.readyState !== WebSocket.OPEN, `${role.name}: a flood was neither slowed nor cut off`);
  };

  // Roles. The control connection is a real host, used to look at the game and drive it; it is never fuzzed.
  const control: Role = { name: 'host', received: [], badFrames: [], leaks: [], reconnects: 0, auth: async (r) => { const from = r.received.length; send(r, { t: 'host', key: server.hostKey }); await waitFor(r, from, (m) => m.t === 'state'); } };
  const stranger: Role = { name: 'stranger', received: [], badFrames: [], leaks: [], reconnects: 0, auth: async () => {} };
  const team: Role = {
    name: 'team', received: [], badFrames: [], leaks: [], reconnects: 0,
    auth: async (r) => {
      const from = r.received.length;
      if (r.token) {
        send(r, { t: 'rejoin', token: r.token });
        const m = await waitFor(r, from, (x) => x.t === 'state' || x.t === 'rejoin-failed');
        if (m['t'] === 'state') return;
      }
      send(r, { t: 'join', name: 'Fuzz Team' });
      const joined = await waitFor(r, from, (x) => x.t === 'joined');
      r.token = joined['token'] as string;
    },
  };
  const tv: Role = { name: 'tv', received: [], badFrames: [], leaks: [], reconnects: 0, auth: async (r) => { const from = r.received.length; send(r, { t: 'screen', key: server.screenKey }); await waitFor(r, from, (m) => m.t === 'state'); } };
  const host: Role = { name: 'host', received: [], badFrames: [], leaks: [], reconnects: 0, auth: control.auth };

  const hostView = async (): Promise<Record<string, unknown>> => {
    await ensureOpen(control);
    const from = control.received.length;
    // Re-sending a setting the game already has makes it broadcast a fresh view.
    const current = JSON.parse(control.received.findLast((raw) => raw.includes('"t":"state"')) ?? '{"view":{}}') as { view: { tvShowQuestions?: boolean } };
    send(control, { t: 'tv-questions', visible: current.view.tvShowQuestions ?? true });
    return (await waitFor(control, from, (m) => m.t === 'state'))['view'] as Record<string, unknown>;
  };
  const SETTINGS = ['tvShowTeams', 'tvShowQuestions', 'requireAdmission', 'joiningLocked', 'maxTeams', 'entryFee', 'prizes', 'photosEnabled', 'readOut', 'startOnLastAnswer', 'closeEarly', 'allowEmptyStart', 'showJoin', 'lockOnStart'];
  const settingsOf = (view: Record<string, unknown>) => Object.fromEntries(SETTINGS.map((k) => [k, view[k]]));
  const alive = async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(res.status, 200, 'healthz answers');
    const probe: Role = { name: 'host', received: [], badFrames: [], leaks: [], reconnects: 0, auth: control.auth };
    await ensureOpen(probe);
    probe.ws!.close();
  };

  await ensureOpen(control);
  const baseline = settingsOf(await hostView());
  const keyBefore = server.hostKey;
  const cleanName = (name: unknown) => typeof name === 'string' && name.length > 0 && name.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(name);

  await t.test('a stranger', async () => {
    await fuzz(stranger, ITERATIONS);
    await flood(stranger);
    await alive();
    const view = await hostView();
    assert.equal(view['phase'], 'lobby');
    assert.deepEqual(settingsOf(view), baseline, 'no setting changed');
    assert.equal(server.hostKey, keyBefore);
    // Valid joins are allowed from anyone; whatever got in must have a clean name.
    for (const team of view['teams'] as { name: unknown }[]) assert.ok(cleanName(team.name), `team name is clean: ${JSON.stringify(team.name)}`);
  });

  await t.test('a team and the TV, in the lobby', async () => {
    await Promise.all([fuzz(team, ITERATIONS), fuzz(tv, ITERATIONS)]);
    await Promise.all([flood(team), flood(tv)]);
    await alive();
    const view = await hostView();
    assert.equal(view['phase'], 'lobby');
    assert.deepEqual(settingsOf(view), baseline, 'no setting changed');
    assert.equal(server.hostKey, keyBefore);
    assert.ok((view['teams'] as { name: string }[]).some((x) => x.name === 'Fuzz Team'), 'the fuzzing team is still in');
  });

  await t.test('a team and the TV, while a question is open', async () => {
    for (let i = 0; i < 8; i++) {
      const v = await hostView();
      if (v['phase'] === 'open') break;
      send(control, { t: v['phase'] === 'reading' ? 'start-timer' : 'advance' });
      await sleep(200);
    }
    assert.equal((await hostView())['phase'], 'open', 'the first question is open');
    await Promise.all([fuzz(team, ITERATIONS), fuzz(tv, ITERATIONS)]);
    await alive();
    const view = await hostView();
    assert.ok(['open', 'closed'].includes(view['phase'] as string), `still on the question, not ${view['phase']}`);
    assert.deepEqual(settingsOf(view), baseline, 'no setting changed');
    assert.equal(server.hostKey, keyBefore);
  });

  await t.test('the host: anything goes, but the server stays consistent and the quiz can still be finished', async () => {
    await fuzz(host, ITERATIONS);
    await flood(host);
    await alive();
    // Drive whatever state the fuzzing left to the end of the quiz, with the real control connection.
    let last = '';
    let stuck = 0;
    for (let guard = 0; ; guard++) {
      const v = await hostView();
      if (v['phase'] === 'finished' || v['phase'] === 'idle') break;
      assert.ok(guard < 200, `could not drive the quiz to the end; stuck at ${last}`);
      const q = v['question'] as { index?: number } | undefined;
      const sig = `${v['phase']}:${q?.index ?? '-'}`;
      stuck = sig === last ? stuck + 1 : 0;
      last = sig;
      const cmd = (['advance', 'start-timer', 'judge', 'end-break', 'resume', 'skip', 'end-round'] as const)[Math.min(stuck, 6)];
      send(control, cmd === 'judge' ? { t: 'judge', correct: false } : { t: cmd });
      await sleep(150);
    }
    const finalView = await hostView();
    for (const row of finalView['standings'] as { score: unknown }[]) assert.ok(Number.isFinite(row.score), 'every score is a number');
  });

  // Across everything: the server never sent a non-JSON frame, and no answer reached a phone or the TV early.
  for (const role of [stranger, team, tv, host, control]) assert.deepEqual(role.badFrames, [], `${role.name}: frames from the server are JSON messages`);
  for (const role of [stranger, team, tv]) assert.deepEqual(role.leaks, [], `${role.name}: no answer leaked before the reveal`);
  assert.equal(Object.keys(Object.prototype).length, 0, 'no prototype pollution');
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);

  for (const role of [stranger, team, tv, host, control]) role.ws?.terminate();
  await server.close();
  console.log(`fuzz: seed ${SEED}, ${ITERATIONS} per role; sent ${JSON.stringify(counts)}; reconnects ${[stranger, team, tv, host].map((r) => `${r.name}=${r.reconnects}`).join(' ')}`);
});
