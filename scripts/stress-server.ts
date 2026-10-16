// The stress-test server on its own, in its own process, so a stress run can measure the server's event loop
// without the simulated phones competing for it.  Prints one JSON line when ready; SIGUSR2 prints loop-delay stats.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQuizFile } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const quiz = await loadQuizFile(join(here, '..', 'examples', 'stress-test', 'quiz.yaml'));
const rounds = Number(process.argv[2] ?? 12);
quiz.questions = quiz.questions.slice(0, rounds * 10);
quiz.rounds = quiz.rounds.slice(0, rounds);
const server = await createQuizServer({ quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', closeEarly: true, lockOnStart: false, tvShowTeams: true });
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
process.on('SIGUSR2', () => {
  console.log(JSON.stringify({ stats: { p50: Math.round(loop.percentile(50) / 1e6), p99: Math.round(loop.percentile(99) / 1e6), max: Math.round(loop.max / 1e6), rssMb: Math.round(process.memoryUsage().rss / 1e6) } }));
  loop.reset();
});
console.log(JSON.stringify({ ready: { port: server.port, hostKey: server.hostKey, screenKey: server.screenKey, roomCode: server.roomCode } }));
process.on('SIGTERM', () => process.exit(0));
