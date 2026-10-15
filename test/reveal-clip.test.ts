// A fun clip (a film quote, say) that the host and TV play after the answer is revealed.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Game } from '../server/game.ts';
import { loadQuizFile, QuizError } from '../server/quiz.ts';

const YAML = (clip: string) => `title: T
scoring: { leaderboard: question }
rounds:
  - name: R
    questions:
      - { type: multiple-choice, text: Which film?, options: [Gladiator, Troy], answer: 0, revealAudio: ${clip}, revealCaption: "Gladiator (2000)" }
`;

async function quizDir(yaml: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pubquiz-reveal-'));
  await writeFile(join(dir, 'quiz.yaml'), yaml);
  for (const [name, data] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), data);
  }
  return dir;
}

test('the reveal clip reaches the host and TV only once the answer is shown, never phones', async () => {
  const dir = await quizDir(YAML('audio/quote.mp3'), { 'audio/quote.mp3': 'fake' });
  const quiz = await loadQuizFile(join(dir, 'quiz.yaml'));
  assert.ok(quiz.media.has('q1-reveal.mp3'));
  const game = new Game(quiz);
  const t = game.join('A');
  assert.ok(t.ok);
  game.advance();
  game.answer(t.value.id, 0);
  assert.equal(game.phase, 'closed', 'everyone answered');
  assert.equal(game.hostView().question!.revealAudio, undefined, 'not before the reveal');
  game.advance(); // reveal
  const host = game.hostView().question!;
  assert.equal(host.revealAudio, '/media/q1-reveal.mp3');
  assert.equal(host.revealCaption, 'Gladiator (2000)');
  const team = game.teamView(t.value.id)!.question!;
  assert.equal(team.revealAudio, undefined);
  assert.equal(team.revealCaption, undefined);
  game.dispose();
});

test('a missing or wrong-type reveal clip is reported, and a web address is accepted', async () => {
  await assert.rejects(loadQuizFile(join(await quizDir(YAML('audio/none.mp3')), 'quiz.yaml')), (e) => e instanceof QuizError && /reveal clip.*can't find/.test(e.message));
  await assert.rejects(loadQuizFile(join(await quizDir(YAML('audio/x.txt'), { 'audio/x.txt': 'a' }), 'quiz.yaml')), /reveal clip/);
  const quiz = await loadQuizFile(join(await quizDir(YAML('"https://example.com/a.mp3"')), 'quiz.yaml'));
  assert.equal(quiz.questions[0]!.revealAudioUrl, 'https://example.com/a.mp3');
});
