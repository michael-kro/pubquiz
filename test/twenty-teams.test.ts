// 20 teams play a 5-round, 10-question quiz; every round's scoreboard is checked against the answers they gave.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gets, PER_ROUND, POINTS, ROUNDS, simulate, TEAMS } from '../scripts/sim-rounds.ts';

test('20 teams, 5 rounds of 10: each round scoreboard is complete, ordered, and moves are right', async () => {
  const run = await simulate();
  try {
    assert.equal(run.boards.length, ROUNDS);
    const scoreOfTeam = (name: string, upTo: number) => {
      const t = Number(name.slice(0, 2)) - 1;
      let score = 0;
      for (let n = 0; n < upTo; n++) if (gets(t, n)) score += POINTS;
      return score;
    };
    let previous: Map<string, number> | undefined;
    for (const board of run.boards) {
      assert.equal(board.rows.length, TEAMS, `round ${board.round}: every team is on the board`);
      const upTo = board.round * PER_ROUND;
      for (const row of board.rows) {
        assert.equal(row.score, scoreOfTeam(row.name, upTo), `round ${board.round}: ${row.name}'s total`);
        assert.equal(row.gained, scoreOfTeam(row.name, upTo) - scoreOfTeam(row.name, upTo - PER_ROUND), `round ${board.round}: ${row.name} gained this round`);
      }
      const scores = board.rows.map((r) => r.score);
      assert.deepEqual(scores, [...scores].sort((a, b) => b - a), `round ${board.round}: highest first`);
      assert.deepEqual(board.rows.map((r) => r.rank).slice(0, 1), [1]);
      assert.ok(board.rows.every((r, i) => i === 0 || r.rank >= board.rows[i - 1]!.rank), 'ranks never go backwards');
      if (previous) {
        for (const row of board.rows) {
          assert.equal(row.moved, previous.get(row.name)! - row.rank, `round ${board.round}: ${row.name} moved since the previous round's board`);
        }
      } else {
        assert.ok(board.rows.every((r) => !r.moved), 'nothing moves after the first round');
      }
      previous = new Map(board.rows.map((r) => [r.name, r.rank]));
    }
  } finally {
    await run.stop();
  }
});
