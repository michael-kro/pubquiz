#!/usr/bin/env node
// Turns a track list into a music round the host plays from their own music app:
//   node scripts/music-round.ts tracks.txt <out-folder> "<title>"
// One track per line: "Artist - Title" (an optional "| hint" is shown to the host). Teams answer the
// artist (or title); the host cues the track from the quiz screen. No audio is stored or streamed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { parseQuiz } from '../server/quiz.ts';

export function musicRound(list: string, title: string): string {
  const questions = list
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const [track = '', hint] = line.split('|').map((s) => s.trim());
      const [artist = '', ...rest] = track.split(' - ');
      const song = rest.join(' - ');
      if (!artist || !song) throw new Error(`Use "Artist - Title": ${line}`);
      return {
        type: 'music',
        text: `Name the artist${hint ? ` (${hint})` : ''}`,
        accept: [artist, `${artist} - ${song}`],
        info: `${song} by ${artist}`,
        seconds: 25,
      };
    });
  if (!questions.length) throw new Error('The track list is empty.');
  const yaml = stringify({ title, scoring: { leaderboard: 'round' }, rounds: [{ name: 'Name that tune', questions }] });
  parseQuiz(yaml); // fail now, not on quiz night
  return yaml;
}

if (import.meta.main) {
  const [file, outDir, title = 'Music Round'] = process.argv.slice(2);
  if (!file || !outDir) {
    console.error('Usage: node scripts/music-round.ts tracks.txt <out-folder> "<title>"');
    process.exit(1);
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'quiz.yaml'), musicRound(await readFile(file, 'utf8'), title));
  console.log(`Wrote ${join(outDir, 'quiz.yaml')}`);
}
