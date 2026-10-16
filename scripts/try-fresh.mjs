#!/usr/bin/env node
// Starts the quiz with a brand-new, empty library and settings, so you can try things without touching your real quizzes:
//   npm run try                 (port 3001, so it can run beside your real one)
//   npm run try -- --port 4000 --keep     (--keep leaves the temporary folders behind; other options pass through)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const rest = args.filter((a) => a !== '--keep');
if (!rest.includes('--port') && !rest.includes('-p')) rest.push('--port', '3001');

const library = mkdtempSync(join(tmpdir(), 'pubquiz-try-library-'));
const config = mkdtempSync(join(tmpdir(), 'pubquiz-try-config-'));
console.log(`Trying the quiz with an empty library: ${library}\n(your real quizzes are not touched${keep ? '; these folders are kept when you stop' : '; these folders are deleted when you stop'})\n`);

const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'main.ts');
const child = spawn(process.execPath, [main, '--no-open', ...rest], { stdio: 'inherit', env: { ...process.env, PUBQUIZ_HOME: library, PUBQUIZ_CONFIG_DIR: config } });
const finish = (code) => {
  if (!keep) {
    rmSync(library, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  }
  process.exit(code ?? 0);
};
child.on('exit', finish);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
