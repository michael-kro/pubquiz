#!/usr/bin/env node
// Plays the long stress-test quiz (every question type, long text) with 30 simulated phones against a real server,
// with random reconnects, and checks that every phone's own results add up to the final standings.
//   node scripts/stress.ts [--rounds 12] [--teams 30]
import { spawn } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { loadQuizFile, type Question } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client, type Message } from '../test/client.ts';
import { STRESS_PER_ROUND } from './make-stress-quiz.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const noise = (a: number, b: number) => {
  let x = (Math.imul(a + 1, 374761393) + Math.imul(b + 1, 668265263)) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 2 ** 32;
};

export interface StressReport {
  questions: number;
  teams: number;
  seconds: number;
  refusedExtra: number;
  reconnects: number;
  wrongMarks: string[];
  scoreMismatches: string[];
  standingsOk: boolean;
  csvRows: number;
  rssMb: { start: number; end: number };
  loopDelayMs: { p99: number; max: number };
  longestQuestion: number;
  fanOutMs: { p50: number; p95: number; max: number };
}

/** The server in a separate process, so its event loop is measured without the simulated phones sharing it. */
async function startExternalServer(rounds: number): Promise<{ port: number; hostKey: string; screenKey: string; roomCode: string; stats(): Promise<{ p50: number; p99: number; max: number; rssMb: number }>; close(): Promise<void> }> {
  const child = spawn(process.execPath, [...(process.env['STRESS_PROF'] ? ['--cpu-prof', `--cpu-prof-dir=${process.env['STRESS_PROF']}`] : []), join(here, 'stress-server.ts'), String(rounds)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const lines: string[] = [];
  const waiters: (() => void)[] = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      lines.push(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      for (const wake of waiters.splice(0)) wake();
    }
  });
  const next = async (key: string): Promise<any> => {
    for (let i = 0; i < 200; i++) {
      const found = lines.findIndex((l) => l.includes(`"${key}"`));
      if (found >= 0) return JSON.parse(lines.splice(found, 1)[0]!)[key];
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 100); });
    }
    throw new Error(`The server process never reported ${key}`);
  };
  const ready = await next('ready');
  return {
    ...ready,
    stats: async () => {
      child.kill('SIGUSR2');
      return next('stats');
    },
    close: async () => {
      child.kill('SIGTERM');
    },
  };
}

export async function runStress(options: { rounds?: number; teams?: number; external?: boolean; log?: (s: string) => void } = {}): Promise<StressReport> {
  const rounds = options.rounds ?? 12;
  const teams = options.teams ?? 30;
  const log = options.log ?? (() => {});
  const quiz = await loadQuizFile(join(here, '..', 'examples', 'stress-test', 'quiz.yaml'));
  const count = rounds * STRESS_PER_ROUND;
  const questions = quiz.questions.slice(0, count);
  quiz.questions = questions;
  quiz.rounds = quiz.rounds.slice(0, rounds);
  const external = options.external ? await startExternalServer(rounds) : undefined;
  const server = external ?? (await createQuizServer({ quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', closeEarly: true, lockOnStart: false, tvShowTeams: true }));
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const rssStart = process.memoryUsage().rss;
  const t0 = Date.now();

  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });

  interface Bot { client: Client; token: string; id: number; name: string; points: number[]; seen: Map<number, { correct: boolean; points: number }> }
  const bots: Bot[] = [];
  for (let t = 0; t < teams; t++) {
    const client = await Client.connect(server.port);
    const name = `Team ${String(t + 1).padStart(2, '0')} ${['Quizzards', 'Brainstormers', 'Know-It-Owls'][t % 3]}`;
    client.send({ t: 'join', room: server.roomCode, name });
    const joined = await client.waitFor((m) => m.t === 'joined', 5000);
    bots.push({ client, token: joined.token, id: t, name, points: [], seen: new Map() });
  }
  // The 31st and later teams must be refused.
  let refusedExtra = 0;
  for (let i = 0; i < 4; i++) {
    const extra = await Client.connect(server.port);
    extra.send({ t: 'join', room: server.roomCode, name: `Extra ${i}` });
    const reply = await extra.waitFor((m) => m.t === 'joined' || m.t === 'error', 3000);
    if (reply.t === 'error') refusedExtra++;
    await extra.close();
  }
  await host.state('lobby', (v) => v.teams.length === teams);

  const press = async () => {
    await new Promise((r) => setTimeout(r, 130));
    host.send({ t: 'advance' });
  };
  let reconnects = 0;
  const wrongMarks: string[] = [];
  const fanOut: number[] = [];

  /** What a phone sends for question n; right (or deliberately wrong) depending on the team. */
  const answerFor = (bot: Bot, n: number, q: Question, view: Message): { value: unknown; shouldBeRight: boolean | undefined } => {
    const right = noise(bot.id, n) < 0.25 + 0.55 * (bot.id / Math.max(1, teams - 1));
    switch (q.type) {
      case 'multiple-choice':
        return { value: right ? q.answer : (q.answer + 1) % q.options.length, shouldBeRight: right };
      case 'letter':
        return { value: right ? q.letter : q.letter === 'Z' ? 'A' : String.fromCharCode(q.letter!.charCodeAt(0) + 1), shouldBeRight: right };
      case 'number':
        return { value: right ? q.answer : q.answer + 1, shouldBeRight: right };
      case 'nearest':
        return { value: q.answer + Math.round((noise(bot.id, n + 99) - 0.5) * 400), shouldBeRight: undefined };
      case 'ordering': {
        const shown: string[] = view.question.items;
        const order = q.items.map((item) => shown.indexOf(item));
        return { value: right ? order : [...order].reverse(), shouldBeRight: right };
      }
      case 'picture':
      case 'music':
        return { value: right ? q.accept[0] : 'Definitely not it', shouldBeRight: right };
      default:
        return { value: 0, shouldBeRight: undefined };
    }
  };

  for (let n = 0; n < count; n++) {
    const q = questions[n]!;
    if (n % STRESS_PER_ROUND === 0 || n === 0) await press(); // start of a round: open (or the wager screen)
    if (q.wager) {
      await Promise.all(bots.map((b) => b.client.state('wagering', (v) => v.question.index === n)));
      bots.forEach((b) => b.client.send({ t: 'wager', amount: 20 + (b.id % 5) * 10 }));
      await host.state('wagering', (v) => v.wagering?.done === teams, 8000);
      await press();
    }
    const asked = Date.now();
    const views = await Promise.all(bots.map((b) => b.client.state('open', (v) => v.question.index === n).then((v) => {
      fanOut.push(Date.now() - asked);
      return v;
    })));
    await Promise.all(
      bots.map(async (bot, i) => {
        await new Promise((r) => setTimeout(r, Math.floor(noise(bot.id, n + 7) * 500)));
        // Some phones lose signal just before answering and come back with their token.
        if (noise(bot.id, n + 31) < 0.06) {
          await bot.client.close();
          bot.client = await Client.connect(server.port);
          bot.client.send({ t: 'rejoin', token: bot.token });
          await bot.client.waitFor((m) => m.t === 'joined', 5000);
          reconnects++;
        }
        const { value } = answerFor(bot, n, q, views[i]);
        bot.client.send({ t: 'answer', value });
      }),
    );
    await host.state('closed', (v) => v.question.index === n, 15000);
    await press(); // reveal
    const expected = bots.map((bot) => answerFor(bot, n, q, views[bots.indexOf(bot)]).shouldBeRight);
    await Promise.all(
      bots.map(async (bot, i) => {
        const v = await bot.client.state('reveal', (x) => x.question.index === n, 8000);
        bot.seen.set(n, { correct: v.result.correct, points: v.result.points });
        if (expected[i] !== undefined && v.result.correct !== expected[i]) wrongMarks.push(`${bot.name}, question ${n + 1} (${q.type}): expected ${expected[i]}, got ${v.result.correct}`);
      }),
    );
    if (n % STRESS_PER_ROUND === STRESS_PER_ROUND - 1) {
      await press(); // leaderboard at the end of the round
      await host.state('leaderboard', (v) => v.question.index === n, 8000);
      const board = await tv.state('leaderboard', (v) => v.question.index === n, 8000);
      log(`round ${n / STRESS_PER_ROUND + 1 | 0} done, leader ${board.standings[0].name} on ${board.standings[0].score}`);
    } else {
      await press(); // straight on to the next question
    }
  }
  await press(); // finished
  const final = await host.state('finished', () => true, 10000);

  const scoreMismatches: string[] = [];
  for (const row of final.standings) {
    const bot = bots.find((b) => b.name === row.name)!;
    const own = [...bot.seen.values()].reduce((sum, r) => sum + r.points, 0);
    if (own !== row.score) scoreMismatches.push(`${row.name}: its own results total ${own}, standings say ${row.score}`);
  }
  const scores: number[] = final.standings.map((r: Message) => r.score);
  const standingsOk = final.standings.length === teams && scores.every((s, i) => i === 0 || scores[i - 1]! >= s) && final.standings[0].rank === 1;
  const csv = await (await fetch(`http://127.0.0.1:${server.port}/results.csv?key=${server.hostKey}`)).text();
  loop.disable();
  const serverStats = external ? await external.stats() : undefined;
  const sorted = [...fanOut].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const report: StressReport = {
    questions: count,
    teams,
    seconds: (Date.now() - t0) / 1000,
    refusedExtra,
    reconnects,
    wrongMarks,
    scoreMismatches,
    standingsOk,
    csvRows: csv.trim().split('\n').length,
    rssMb: serverStats ? { start: 0, end: serverStats.rssMb } : { start: Math.round(rssStart / 1e6), end: Math.round(process.memoryUsage().rss / 1e6) },
    loopDelayMs: serverStats ? { p99: serverStats.p99, max: serverStats.max } : { p99: Math.round(loop.percentile(99) / 1e6), max: Math.round(loop.max / 1e6) },
    longestQuestion: Math.max(...questions.map((q) => q.text.length)),
    fanOutMs: { p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1) ?? 0 },
  };
  for (const c of [host, tv, ...bots.map((b) => b.client)]) await c.close();
  await server.close();
  return report;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { rounds: { type: 'string', default: '12' }, teams: { type: 'string', default: '30' }, external: { type: 'boolean', default: false } } });
  const report = await runStress({ rounds: Number(values.rounds), teams: Number(values.teams), external: values.external, log: (s) => console.log(' ', s) });
  console.log('\n' + JSON.stringify(report, null, 2));
  const bad = report.wrongMarks.length + report.scoreMismatches.length + (report.standingsOk ? 0 : 1);
  process.exit(bad ? 1 : 0);
}
