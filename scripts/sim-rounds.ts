#!/usr/bin/env node
// Plays a 5-round, 10-question quiz with 20 bot teams against a real server and prints every round's scoreboard.
//   node scripts/sim-rounds.ts            run it and print the boards
//   node scripts/sim-rounds.ts --hold     stop at the first round leaderboard and keep the server up (for looking at it)
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client, type Message } from '../test/client.ts';

export const ROUNDS = 5;
export const PER_ROUND = 10;
export const TEAMS = 20;
export const POINTS = 100;

export function simQuiz(): string {
  const rounds = Array.from({ length: ROUNDS }, (_, r) => {
    const questions = Array.from({ length: PER_ROUND }, (_, q) => `      - { type: multiple-choice, text: "Round ${r + 1} question ${q + 1}: which option is right?", options: [One, Two, Three, Four], answer: ${(r + q) % 4}, seconds: 20 }`);
    return `  - name: "Round ${r + 1}"\n    questions:\n${questions.join('\n')}`;
  });
  return `title: Twenty Teams\nscoring: { mode: flat, leaderboard: round }\nrounds:\n${rounds.join('\n')}\n`;
}

/** A small deterministic random number in [0, 1) for a pair of numbers. */
function noise(a: number, b: number): number {
  let x = (Math.imul(a + 1, 374761393) + Math.imul(b + 1, 668265263)) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 2 ** 32;
}

/** Does team t get question n (0-based across the quiz) right? Stronger teams (higher t) usually do, but not always. */
export const gets = (t: number, n: number): boolean => noise(t, n) < 0.3 + 0.5 * (t / (TEAMS - 1)) + 0.1 * Math.sin(t * 3 + n / 10 * (t % 5));

export interface Board {
  round: number;
  rows: { name: string; score: number; rank: number; gained?: number; moved?: number }[];
}

export async function simulate(options: { hold?: boolean; holdRound?: number; tvTeams?: boolean } = {}): Promise<{ boards: Board[]; port: number; hostKey: string; screenKey: string; stop(): Promise<void> }> {
  const quiz = parseQuiz(simQuiz().replace('mode: flat', `mode: flat, speedFactor: 0`).replace(/seconds: 20 }/g, `seconds: 20, points: ${POINTS} }`));
  const server = await createQuizServer({ quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', closeEarly: true, lockOnStart: false, tvShowTeams: options.tvTeams ?? true });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const teams: Client[] = [];
  for (let t = 0; t < TEAMS; t++) {
    const c = await Client.connect(server.port);
    c.send({ t: 'join', room: server.roomCode, name: `${String(t + 1).padStart(2, '0')} ${['Quizzards', 'Brainstormers', 'Know-It-Owls', 'Trivia Newton John', 'Les Quizerables'][t % 5]}` });
    await c.waitFor((m) => m.t === 'joined');
    teams.push(c);
  }
  await host.state('lobby', (v) => v.teams.length === TEAMS);

  // A real host presses a button every few seconds; the server rate-limits faster than that, so pace the bot host.
  const press = async () => {
    await new Promise((r) => setTimeout(r, 120));
    host.send({ t: 'advance' });
  };
  const boards: Board[] = [];
  for (let n = 0; n < ROUNDS * PER_ROUND; n++) {
    // A round's leaderboard (and the very start) need a press to open the question; mid-round the reveal press already did.
    if (n % PER_ROUND === 0) await press();
    try {
      await Promise.all(teams.map((c) => c.state('open', (v) => v.question.index === n)));
    } catch (error) {
      throw new Error(`Question ${n + 1}: teams never saw it open (server phase ${server.game?.phase}, question ${server.game?.questionIndex}). ${String(error).slice(0, 120)}`);
    }
    teams.forEach((c, t) => c.send({ t: 'answer', value: gets(t, n) ? (Math.floor(n / PER_ROUND) + (n % PER_ROUND)) % 4 : ((Math.floor(n / PER_ROUND) + (n % PER_ROUND)) % 4 + 1) % 4 }));
    await host.state('closed', (v) => v.question.index === n);
    await press(); // reveal
    await host.state('reveal', (v) => v.question.index === n);
    await press(); // leaderboard at the end of a round, otherwise straight on to the next question
    if (n % PER_ROUND === PER_ROUND - 1) {
      const board = await host.state('leaderboard', (v) => v.question.index === n);
      boards.push({ round: boards.length + 1, rows: board.standings.map((r: Message) => ({ name: r.name, score: r.score, rank: r.rank, gained: r.gained, moved: r.moved })) });
      if (options.hold && boards.length === (options.holdRound ?? 1)) break;
      if (n === ROUNDS * PER_ROUND - 1) await press();
    }
  }
  return {
    boards,
    port: server.port,
    hostKey: server.hostKey,
    screenKey: server.screenKey,
    async stop() {
      for (const c of [host, ...teams]) await c.close();
      await server.close();
    },
  };
}

if (import.meta.main) {
  const holdArg = process.argv.find((a) => a.startsWith('--hold'));
  const hold = Boolean(holdArg);
  const run = await simulate({ hold, holdRound: Number(holdArg?.split('=')[1]) || 1, tvTeams: !hold });
  for (const b of run.boards) {
    console.log(`\nAfter round ${b.round}:`);
    for (const r of b.rows) console.log(`${String(r.rank).padStart(3)}. ${r.name.padEnd(32)} ${String(r.score).padStart(5)}  ${r.gained != null ? `+${r.gained}` : ''} ${r.moved ? (r.moved > 0 ? `▲${r.moved}` : `▼${-r.moved}`) : ''}`);
  }
  if (hold) {
    console.log(`\nHolding. TV: http://127.0.0.1:${run.port}/screen?key=${run.screenKey}  Host: http://127.0.0.1:${run.port}/host?key=${run.hostKey}`);
    await new Promise(() => {});
  }
  await run.stop();
}
