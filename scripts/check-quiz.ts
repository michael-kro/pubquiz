#!/usr/bin/env node
// Checks a quiz file the way the app does, and says what is wrong and where:
//   node scripts/check-quiz.ts path/to/quiz.yaml
import { loadQuizFile, QuizError } from '../server/quiz.ts';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/check-quiz.ts path/to/quiz.yaml');
  process.exit(1);
}
try {
  const quiz = await loadQuizFile(file);
  const types = new Map<string, number>();
  for (const q of quiz.questions) types.set(q.type, (types.get(q.type) ?? 0) + 1);
  console.log(`OK: "${quiz.title}", ${quiz.rounds.length} rounds, ${quiz.questions.length} questions (${[...types].map(([t, n]) => `${n} ${t}`).join(', ')})`);
} catch (error) {
  console.error(error instanceof QuizError ? error.message : `Could not read ${file}: ${(error as Error).message}`);
  process.exit(1);
}
