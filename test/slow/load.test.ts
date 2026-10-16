// M6: 30 teams play a whole quiz over a slow, jittery, unreliable network, and every score comes out right.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLoad } from '../helpers/load.ts';

test('30 teams, 5 questions, delayed and dropping connections: everyone ends up with the right score', { timeout: 120_000 }, async () => {
  const report = await runLoad({
    teams: 30,
    questions: 5,
    seconds: 8,
    latencyMs: 40,
    jitterMs: 25,
    dropRate: 0.15,
    thinkMs: [100, 900],
    extraTeams: 4,
  });
  assert.deepEqual(report.problems, []);
  assert.ok(report.drops > 5, `the test actually dropped connections (${report.drops})`);
  assert.ok(report.answersSent >= 30 * 5 * 0.9, `answers were sent (${report.answersSent})`);
  // Everyone's question arrives within a fraction of a second of the host pressing the button.
  assert.ok(report.fanOutMs.p95 < 3000, `fan-out p95 ${report.fanOutMs.p95} ms`);
  assert.ok(report.loopDelayMs.p99 < 600, `server event-loop p99 ${report.loopDelayMs.p99} ms`);
});
