#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadQuizFile, QuizError } from './quiz.ts';
import { createQuizServer } from './server.ts';

const USAGE = `Usage: npm start -- <quiz.yaml> [options]

Options:
  -p, --port <n>         Port to listen on (default 3000)
      --public-host <h>  Address to put in the join link (default: this laptop's Wi-Fi address)
      --no-open          Don't open the host screen in a browser
  -h, --help             Show this help`;

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p', default: '3000' },
      'public-host': { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const quizPath = positionals[0];
  if (values.help || !quizPath) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${values.port}`);
    process.exit(1);
  }

  let quiz;
  try {
    quiz = await loadQuizFile(quizPath);
  } catch (error) {
    if (error instanceof QuizError) {
      console.error(`Problems in ${quizPath}:\n  ${error.issues.join('\n  ')}`);
    } else {
      console.error(`Couldn't read ${quizPath}: ${(error as Error).message}`);
    }
    process.exit(1);
  }

  let server;
  try {
    server = await createQuizServer({ quiz, port, publicHost: values['public-host'] });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try another with --port 3001.`);
    } else {
      console.error((error as Error).message);
    }
    process.exit(1);
  }

  console.log(`
Pub quiz: "${quiz.title}" (${quiz.questions.length} questions)

  Host screen:  ${server.hostUrl}
  Teams join:   ${server.joinUrl}
  Room code:    ${server.roomCode}

Teams' phones must be on the same Wi-Fi as this laptop.
Press Ctrl+C to stop.
`);

  if (!values['no-open']) openBrowser(server.hostUrl);

  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
