import assert from 'node:assert/strict';
import { test } from 'node:test';
import { musicRound } from '../scripts/music-round.ts';
import { parseQuiz } from '../server/quiz.ts';

test('a track list becomes a music round', () => {
  const quiz = parseQuiz(musicRound('# comment\nQueen - Bohemian Rhapsody | 1975\n\nABBA - Dancing Queen\n', 'Tunes'));
  assert.equal(quiz.questions.length, 2);
  assert.equal(quiz.questions[0]!.text, 'Name the artist (1975)');
  const first = quiz.questions[0]!;
  assert.deepEqual(first.type === 'music' ? first.accept : undefined, ['Queen', 'Queen - Bohemian Rhapsody']);
  assert.throws(() => musicRound('no dash here', 'x'), /Artist - Title/);
  assert.throws(() => musicRound('\n', 'x'), /empty/);
});
