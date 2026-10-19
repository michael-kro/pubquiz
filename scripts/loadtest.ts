#!/usr/bin/env node
// Plays a whole quiz with many simulated teams over a slow, jittery, unreliable network and checks every score.
//   node scripts/loadtest.ts --teams 30 --questions 10 --latency 80 --jitter 40 --drop 0.1
import { parseArgs } from 'node:util';

// The checks expect the 1000-point questions the tests use, so ask for that before the game code loads.
process.env['PUBQUIZ_POINTS_UNIT'] ??= '1000';
process.env['PUBQUIZ_SCORING_DEFAULT'] ??= 'speed';
process.env['PUBQUIZ_ADMISSION_DEFAULT'] ??= 'off';
process.env['PUBQUIZ_READOUT_DEFAULT'] ??= 'off';
const { runLoad } = await import('../test/helpers/load.ts');

const { values } = parseArgs({
  options: {
    teams: { type: 'string', default: '30' },
    questions: { type: 'string', default: '10' },
    seconds: { type: 'string', default: '10' },
    latency: { type: 'string', default: '50' },
    jitter: { type: 'string', default: '25' },
    drop: { type: 'string', default: '0.1' },
    correct: { type: 'string', default: '0.6' },
    extra: { type: 'string', default: '5' },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`Usage: node scripts/loadtest.ts [options]
  --teams <n>       teams that play (default 30, the most a quiz allows)
  --questions <n>   questions (default 10)
  --seconds <n>     time limit per question (default 10)
  --latency <ms>    delay each way on every phone's connection (default 50, so a 100 ms round trip)
  --jitter <ms>     random extra delay, plus or minus (default 25)
  --drop <0-1>      chance per team per question that its connection drops and comes back (default 0.1)
  --correct <0-1>   chance a team answers correctly (default 0.6)
  --extra <n>       more teams than fit, to check the cap holds (default 5)`);
  process.exit(0);
}

const num = (name: keyof typeof values) => Number(values[name]);
const log = values.quiet ? undefined : (line: string) => console.log(`  ${line}`);

console.log(
  `Load test: ${num('teams')} teams, ${num('questions')} questions, ${num('latency')} ms ±${num('jitter')} each way, ` +
    `${Math.round(num('drop') * 100)}% drop chance per question, ${num('extra')} extra teams\n`,
);

const report = await runLoad({
  teams: num('teams'),
  questions: num('questions'),
  seconds: num('seconds'),
  latencyMs: num('latency'),
  jitterMs: num('jitter'),
  dropRate: num('drop'),
  correctRate: num('correct'),
  extraTeams: num('extra'),
  log,
});

const ms = (s: { min: number; p50: number; p95: number; max: number }) => `min ${s.min}, median ${s.p50}, p95 ${s.p95}, max ${s.max} ms`;
console.log(`
Took ${(report.durationMs / 1000).toFixed(1)} s
Question reaches a phone after:   ${ms(report.fanOutMs)}   (includes the ${num('latency')} ms network delay)
Gap between first and last phone: ${ms(report.spreadMs)}
Connections dropped and restored: ${report.drops}
Answers sent / never recorded:    ${report.answersSent} / ${report.answersMissing} (an answer lost with its connection)
Server event loop delay:          mean ${report.loopDelayMs.mean}, p99 ${report.loopDelayMs.p99}, max ${report.loopDelayMs.max} ms
Server CPU time / memory:         ${report.cpuMs} ms / ${report.rssMb} MB (this whole process, including the simulated phones)
`);

if (report.ok) {
  console.log('PASS: every team ended with the score the server recorded, on its phone and on the host screen.');
} else {
  console.log(`FAIL: ${report.problems.length} problem${report.problems.length === 1 ? '' : 's'}`);
  for (const problem of report.problems.slice(0, 30)) console.log(`  - ${problem}`);
  process.exitCode = 1;
}
// Open sockets from the simulated phones can keep the process alive; the work is done.
process.exit(process.exitCode ?? 0);
