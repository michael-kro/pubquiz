export interface ScoreInput {
  correct: boolean;
  points: number;
  /** Time from the question reaching the team to the answer reaching the server. */
  answerMs: number;
  durationMs: number;
  /** 0 = no speed bonus, 0.5 = an answer at the deadline earns half the points. */
  speedFactor: number;
}

export function scoreAnswer({ correct, points, answerMs, durationMs, speedFactor }: ScoreInput): number {
  if (!correct) return 0;
  const t = Math.min(Math.max(answerMs, 0), durationMs);
  return Math.round(points * (1 - (speedFactor * t) / durationMs));
}
