// Plays whole quizzes with many simulated teams, over a network that is slow, jittery and unreliable.
// Used by test/load.test.ts (small and quick) and scripts/loadtest.ts (as big as you like).
import { createServer, connect, type Server, type Socket } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import WebSocket from 'ws';
import { parseQuiz } from '../../server/quiz.ts';
import { createQuizServer } from '../../server/server.ts';

export interface LoadOptions {
  teams: number;
  questions: number;
  /** Time limit of each question. */
  seconds?: number;
  /** One-way delay added to every packet, in ms (so the round trip is double this). */
  latencyMs?: number;
  jitterMs?: number;
  /** Chance, per team per question, that its connection drops mid-question (it rejoins a moment later). */
  dropRate?: number;
  /** Chance a team picks the right answer. */
  correctRate?: number;
  /** How long a team thinks before answering, [min, max] ms. */
  thinkMs?: [number, number];
  /** More teams than the quiz allows, to check the cap holds. */
  extraTeams?: number;
  log?: (line: string) => void;
}

export interface LoadReport {
  ok: boolean;
  problems: string[];
  teams: number;
  questions: number;
  durationMs: number;
  /** Time from the host pressing Start/Next until each team's phone shows the question, across all teams and questions. */
  fanOutMs: Stats;
  /** Per question, how far apart the first and last team received it. */
  spreadMs: Stats;
  /** Event-loop delay on the server while the quiz ran. */
  loopDelayMs: { mean: number; p99: number; max: number };
  cpuMs: number;
  rssMb: number;
  drops: number;
  answersSent: number;
  answersMissing: number;
}

export interface Stats {
  min: number;
  p50: number;
  p95: number;
  max: number;
}

const stats = (values: number[]): Stats => {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { min: Math.round(s[0] ?? 0), p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(s.at(-1) ?? 0) };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const between = (min: number, max: number) => min + Math.random() * (max - min);

/** A TCP relay that holds each chunk back for the delay, in order, in both directions. */
function delayProxy(targetPort: number, latencyMs: number, jitterMs: number): Promise<{ port: number; server: Server }> {
  const server = createServer((client) => {
    const upstream = connect(targetPort, '127.0.0.1');
    const relay = (from: Socket, to: Socket) => {
      let last = 0;
      from.on('data', (chunk) => {
        const release = Math.max(last, Date.now() + Math.max(0, latencyMs + between(-jitterMs, jitterMs)));
        last = release;
        setTimeout(() => !to.destroyed && to.write(chunk), release - Date.now());
      });
      from.on('close', () => setTimeout(() => to.destroy(), Math.max(0, last - Date.now())));
      from.on('error', () => to.destroy());
    };
    relay(client, upstream);
    relay(upstream, client);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, server })));
}

type View = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

class Bot {
  readonly name: string;
  token?: string;
  ws?: WebSocket;
  view?: View;
  joined = false;
  rejected?: string;
  drops = 0;
  /** Questions during which this team's connection dropped. */
  readonly droppedDuring = new Set<number>();
  answersSent = 0;
  /** Points from each reveal, by question. */
  readonly revealed = new Map<number, number>();
  /** The answer the server shows this team as having given, by question. */
  readonly recorded = new Map<number, number | undefined>();
  readonly openedAt = new Map<number, number>();
  private answeredQuestions = new Set<number>();
  private stopped = false;
  private readonly o: Required<Pick<LoadOptions, 'dropRate' | 'correctRate' | 'thinkMs'>>;
  private readonly port: number;

  constructor(name: string, port: number, o: Required<Pick<LoadOptions, 'dropRate' | 'correctRate' | 'thinkMs'>>) {
    this.name = name;
    this.port = port;
    this.o = o;
  }

  /** Opens the connection and joins. A connection that hasn't opened after a few seconds is abandoned, so one stuck socket can't stall everything. */
  connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`${this.name} could not connect within ${timeoutMs} ms`));
      }, timeoutMs);
      ws.on('error', () => {});
      ws.once('open', () => {
        clearTimeout(timer);
        ws.send(JSON.stringify(this.token ? { t: 'rejoin', token: this.token } : { t: 'join', room: this.room, name: this.name }));
        resolve();
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.on('message', (data) => this.onMessage(JSON.parse(data.toString())));
    });
  }

  /** connect(), trying a few times: the first attempts of a busy machine can be slow. */
  async connectWithRetry(attempts = 3): Promise<void> {
    for (let i = 1; ; i++) {
      try {
        return await this.connect();
      } catch (error) {
        if (i >= attempts) throw error;
      }
    }
  }

  room = '';

  private onMessage(m: View): void {
    if (m.t === 'joined') {
      this.token = m.token;
      this.joined = true;
    } else if (m.t === 'error' && !this.joined) {
      this.rejected = m.message;
    } else if (m.t === 'state') {
      const view: View = m.view;
      this.view = view;
      const q = view.question;
      if (q && view.phase === 'open') {
        if (!this.openedAt.has(q.index)) this.openedAt.set(q.index, performance.now());
        this.onOpen(q.index, q.seconds * 1000);
      }
      if (q) this.recorded.set(q.index, view.myChoice);
      if (view.phase === 'reveal' && q && view.result) this.revealed.set(q.index, view.result.points);
    }
  }

  /** Ends the simulation: no more reconnecting, and the socket is dropped. */
  stop(): void {
    this.stopped = true;
    this.ws?.terminate();
  }

  private pending = new Set<number>();

  private onOpen(index: number, durationMs: number): void {
    if (this.view?.myChoice !== undefined || this.pending.has(index)) return;
    this.pending.add(index);
    const think = between(...this.o.thinkMs);
    const drop = Math.random() < this.o.dropRate;
    setTimeout(() => {
      this.pending.delete(index);
      if (this.view?.question?.index !== index || this.view.phase !== 'open') return;
      this.answer(index);
    }, think);
    if (drop) {
      // Signal lost partway through: the phone may or may not have answered yet, then it comes back.
      setTimeout(async () => {
        this.drops++;
        this.droppedDuring.add(index);
        this.ws?.terminate();
        // Back after a moment, trying again until the connection holds.
        while (!this.stopped) {
          await sleep(between(300, 1800));
          if (this.stopped) return;
          try {
            await this.connect();
            return;
          } catch {
            // Still no signal.
          }
        }
      }, between(0, Math.min(durationMs * 0.5, this.o.thinkMs[1])));
    }
  }

  private answer(index: number): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Offline right now: try again as soon as it's back, while the question is still open.
      setTimeout(() => this.view?.question?.index === index && this.view.phase === 'open' && this.view.myChoice === undefined && this.answer(index), 400);
      return;
    }
    const opened = this.openedAt.get(index) ?? performance.now();
    this.ws.send(JSON.stringify({ t: 'answer', value: Math.random() < this.o.correctRate ? 0 : 1, elapsedMs: Math.round(performance.now() - opened) }));
    this.answersSent++;
    this.answeredQuestions.add(index);
  }
}

/** Runs a load test, but fails with a clear message instead of hanging if it takes far longer than a quiz of this size should. */
export async function runLoad(options: LoadOptions): Promise<LoadReport> {
  const seconds = options.seconds ?? 10;
  const limitMs = (options.questions * (seconds + 8) + 60) * 1000;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The load test did not finish within ${Math.round(limitMs / 1000)} s`)), limitMs);
  });
  try {
    return await Promise.race([runLoadUnbounded(options), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function runLoadUnbounded(options: LoadOptions): Promise<LoadReport> {
  const log = options.log ?? (() => {});
  const o = {
    teams: options.teams,
    questions: options.questions,
    seconds: options.seconds ?? 10,
    latencyMs: options.latencyMs ?? 0,
    jitterMs: options.jitterMs ?? 0,
    dropRate: options.dropRate ?? 0,
    correctRate: options.correctRate ?? 0.6,
    thinkMs: options.thinkMs ?? ([100, 1200] as [number, number]),
    extraTeams: options.extraTeams ?? 0,
  };
  const problems: string[] = [];

  // Flat scoring makes every answer worth exactly 1000 or 0, so results can be checked exactly.
  const yaml = [
    'title: Load test',
    'scoring: { mode: flat, leaderboard: question }',
    'rounds:',
    '  - name: Load',
    '    questions:',
    ...Array.from({ length: o.questions }, (_, i) => `      - { type: multiple-choice, text: "Question ${i + 1}", options: [a, b, c, d], answer: 0, seconds: ${o.seconds} }`),
  ].join('\n');
  const server = await createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, quiz: parseQuiz(yaml), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const proxy = await delayProxy(server.port, o.latencyMs, o.jitterMs);
  const loopDelay = monitorEventLoopDelay({ resolution: 5 });
  loopDelay.enable();
  const cpu0 = process.cpuUsage();
  const started = performance.now();

  // The host and the TV connect directly: only the teams' phones are on the bad network.
  const host = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  host.on('error', () => {});
  let hostView: View = {};
  const hostWaiters: (() => void)[] = [];
  host.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.t === 'state') {
      hostView = m.view;
      for (const wake of hostWaiters.splice(0)) wake();
    }
  });
  await new Promise<void>((resolve) => host.once('open', () => resolve()));
  host.send(JSON.stringify({ t: 'host', key: server.hostKey }));
  const hostUntil = async (ok: (v: View) => boolean, timeoutMs: number, what: string) => {
    const deadline = Date.now() + timeoutMs;
    while (!ok(hostView)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Host sees phase "${hostView.phase}", ${hostView.answeredCount}/${hostView.connectedCount} answered.`);
      await new Promise<void>((resolve) => {
        hostWaiters.push(resolve);
        setTimeout(resolve, 200);
      });
    }
  };

  const bots = Array.from({ length: o.teams }, (_, i) => new Bot(`Team ${String(i + 1).padStart(2, '0')}`, proxy.port, o));
  const extras = Array.from({ length: o.extraTeams }, (_, i) => new Bot(`Extra ${i + 1}`, proxy.port, o));
  const sendTimes = new Map<number, number>();
  let peakRss = 0;
  const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 250);

  try {
    await hostUntil((v) => v.phase === 'lobby', 5000, 'the lobby');
    const room = hostView.roomCode as string;
    for (const bot of [...bots, ...extras]) bot.room = room;
    await Promise.all(bots.map((b) => b.connectWithRetry()));
    await hostUntil((v) => v.teams?.length === o.teams, 20_000, `${o.teams} teams to join`);
    log(`${o.teams} teams joined`);

    if (extras.length) {
      await Promise.all(extras.map((b) => b.connectWithRetry()));
      await sleep(Math.max(300, o.latencyMs * 4));
      const accepted = extras.filter((b) => b.joined).length;
      if (accepted > 0) problems.push(`${accepted} extra teams were let in beyond the ${o.teams} that fit`);
      if (!extras.every((b) => b.rejected)) problems.push('an extra team was neither accepted nor told why it was refused');
      for (const b of extras) b.ws?.terminate();
    }

    for (let q = 0; q < o.questions; q++) {
      sendTimes.set(q, performance.now());
      host.send(JSON.stringify({ t: 'advance' })); // start, or next question
      await hostUntil((v) => v.phase === 'open' && v.question?.index === q, 10_000, `question ${q + 1} to open`);
      await hostUntil((v) => v.phase === 'closed' && v.question?.index === q, (o.seconds + 10) * 1000, `question ${q + 1} to close`);
      host.send(JSON.stringify({ t: 'advance' })); // reveal
      await hostUntil((v) => v.phase === 'reveal', 5000, 'the reveal');
      host.send(JSON.stringify({ t: 'advance' })); // leaderboard
      await hostUntil((v) => v.phase === 'leaderboard', 5000, 'the leaderboard');
      log(`question ${q + 1}/${o.questions} done`);
    }
    host.send(JSON.stringify({ t: 'advance' }));
    await hostUntil((v) => v.phase === 'finished', 5000, 'the end');
    await sleep(Math.max(300, o.latencyMs * 4 + o.jitterMs * 2)); // let the last states reach every phone

    // Every phone, including the ones that dropped near the end, comes back and shows the final results.
    const settleBy = Date.now() + 25_000;
    while (bots.some((b) => b.view?.phase !== 'finished') && Date.now() < settleBy) await sleep(100);

    // Checks, against what the server itself recorded for each team.
    const snapshot = server.game!.snapshot();
    const recordedAnswers = new Map(snapshot.teams.map((t) => [t.name, new Map(t.answers.map(([q, a]) => [q, a.value]))]));
    const standings = new Map<string, number>((hostView.standings as { name: string; score: number }[]).map((r) => [r.name, r.score]));
    let missing = 0;
    for (const bot of bots) {
      if (bot.view?.phase !== 'finished') problems.push(`${bot.name} never saw the final results (phase "${bot.view?.phase}")`);
      const answers = recordedAnswers.get(bot.name) ?? new Map();
      let expected = 0;
      for (let q = 0; q < o.questions; q++) {
        const value = answers.get(q);
        if (value === undefined) {
          missing++;
          if (bot.revealed.get(q)) problems.push(`${bot.name} scored on question ${q + 1} without an answer`);
          continue;
        }
        const points = value === 0 ? 1000 : 0;
        expected += points;
        if (bot.revealed.has(q) && bot.revealed.get(q) !== points) {
          problems.push(`${bot.name} answered ${value} on question ${q + 1} but was awarded ${bot.revealed.get(q)}`);
        }
      }
      if (bot.view?.score !== expected) problems.push(`${bot.name}'s phone shows ${bot.view?.score}, expected ${expected}`);
      if (standings.get(bot.name) !== expected) problems.push(`${bot.name}: host standings say ${standings.get(bot.name)}, expected ${expected}`);
    }
    const unanswerable = bots.reduce((n, b) => n + b.drops, 0);
    const fanOut: number[] = [];
    const spread: number[] = [];
    for (let q = 0; q < o.questions; q++) {
      // Timing is judged on teams that stayed connected; a team that was reconnecting gets it late, which is expected.
      const steady = bots.filter((b) => !b.droppedDuring.has(q) && !b.droppedDuring.has(q - 1));
      const times = steady.flatMap((b) => (b.openedAt.has(q) ? [b.openedAt.get(q)! - sendTimes.get(q)!] : []));
      // A team whose connection had just dropped may still be reconnecting when a question opens and
      // miss it entirely; any other team missing one is a fault.
      const unexpected = bots.filter((b) => !b.openedAt.has(q) && !b.droppedDuring.has(q) && !b.droppedDuring.has(q - 1));
      if (unexpected.length) problems.push(`question ${q + 1} never reached ${unexpected.map((b) => b.name).join(', ')}`);
      fanOut.push(...times);
      if (times.length) spread.push(Math.max(...times) - Math.min(...times));
    }
    loopDelay.disable();
    const cpu = process.cpuUsage(cpu0);
    return {
      ok: problems.length === 0,
      problems,
      teams: o.teams,
      questions: o.questions,
      durationMs: Math.round(performance.now() - started),
      fanOutMs: stats(fanOut),
      spreadMs: stats(spread),
      loopDelayMs: { mean: Math.round(loopDelay.mean / 1e4) / 100, p99: Math.round(loopDelay.percentile(99) / 1e4) / 100, max: Math.round(loopDelay.max / 1e4) / 100 },
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      rssMb: Math.round(Math.max(peakRss, process.memoryUsage().rss) / 1048576),
      drops: unanswerable,
      answersSent: bots.reduce((n, b) => n + b.answersSent, 0),
      answersMissing: missing,
    };
  } finally {
    clearInterval(sampler);
    for (const bot of [...bots, ...extras]) bot.stop();
    host.terminate();
    proxy.server.close();
    await server.close();
  }
}
