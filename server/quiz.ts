import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// M1 supports multiple choice only. Picture, ordering and music arrive in M1b.
const MultipleChoice = z
  .object({
    type: z.literal('multiple-choice'),
    text: z.string().trim().min(1),
    options: z.array(z.string().trim().min(1)).min(2).max(4),
    answer: z.number().int().min(0),
    seconds: z.number().int().min(5).max(300).default(20),
    points: z.number().int().min(0).max(10_000).default(1000),
  })
  .strict()
  .refine((q) => q.answer < q.options.length, {
    message: 'must be the position of one of the options, counting from 0',
    path: ['answer'],
  });

const QuizFile = z
  .object({
    title: z.string().trim().min(1),
    scoring: z
      .object({
        // Share of a correct answer's points lost by answering at the very last moment.
        speedFactor: z.number().min(0).max(1).default(0.5),
      })
      .strict()
      .default({ speedFactor: 0.5 }),
    rounds: z
      .array(
        z
          .object({
            name: z.string().trim().min(1),
            questions: z.array(MultipleChoice).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type Question = z.infer<typeof MultipleChoice> & { round: string };

export interface Quiz {
  title: string;
  speedFactor: number;
  questions: Question[];
}

export class QuizError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid quiz:\n  ${issues.join('\n  ')}`);
    this.name = 'QuizError';
    this.issues = issues;
  }
}

export function parseQuiz(text: string): Quiz {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new QuizError([`Not valid YAML: ${(error as Error).message}`]);
  }

  const result = QuizFile.safeParse(raw);
  if (!result.success) {
    throw new QuizError(result.error.issues.map((issue) => `${describePath(issue.path)}: ${issue.message}`));
  }

  const file = result.data;
  return {
    title: file.title,
    speedFactor: file.scoring.speedFactor,
    questions: file.rounds.flatMap((round) => round.questions.map((q) => ({ ...q, round: round.name }))),
  };
}

export async function loadQuizFile(path: string): Promise<Quiz> {
  return parseQuiz(await readFile(path, 'utf8'));
}

// Turns ['rounds', 0, 'questions', 2, 'answer'] into "Round 1, question 3, answer".
function describePath(path: PropertyKey[]): string {
  if (path.length === 0) return 'Quiz';
  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const next = path[i + 1];
    if ((key === 'rounds' || key === 'questions' || key === 'options') && typeof next === 'number') {
      parts.push(`${key === 'rounds' ? 'Round' : key === 'questions' ? 'question' : 'option'} ${next + 1}`);
      i++;
    } else {
      parts.push(String(key));
    }
  }
  return parts.join(', ');
}
