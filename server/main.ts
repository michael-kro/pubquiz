#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadQuizFile, QuizError } from './quiz.ts';
import { createQuizServer, type QuizServer } from './server.ts';
import { hashQuiz, readSession } from './session.ts';
import { cloudflaredProvider, ensureCloudflared, ngrokProvider, TunnelManager, type NetworkStatus } from './tunnel.ts';

const USAGE = `Usage: npm start -- <quiz.yaml> [options]

Teams join over the internet by default (a free Cloudflare link, no account needed), so
their phones can use 4G or any Wi-Fi. With no internet, use --lan and put the phones on
the same Wi-Fi as this laptop (or this laptop's hotspot).

Options:
  -p, --port <n>         Port to listen on (default 3000)
      --lan              Local Wi-Fi only: no internet link
      --tunnel <name>    Internet link to use: cloudflare (default) or ngrok
      --public-url <url> Use your own public address instead (e.g. a VPS or Tailscale Funnel)
      --public-host <h>  Address to put in the local join link (default: this laptop's Wi-Fi address)
      --no-open          Don't open the host screen in a browser
      --fresh            Start over instead of resuming an unfinished quiz
  -h, --help             Show this help

The quiz is saved as it runs (next to the quiz file, as <name>.session.json).
If the laptop crashes or you restart, run the same command to carry on.`;

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
      fresh: { type: 'boolean', default: false },
      lan: { type: 'boolean', default: false },
      tunnel: { type: 'string', default: 'cloudflare' },
      'public-url': { type: 'string' },
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

  if (!['cloudflare', 'ngrok'].includes(values.tunnel)) {
    console.error(`Unknown --tunnel "${values.tunnel}". Use cloudflare or ngrok.`);
    process.exit(1);
  }
  const publicUrl = values['public-url']?.replace(/\/+$/, '');
  if (publicUrl && !/^https?:\/\//.test(publicUrl)) {
    console.error('--public-url must start with https:// (or http://).');
    process.exit(1);
  }

  let tunnel: TunnelManager | undefined;

  const sessionPath = `${quizPath.replace(/\.ya?ml$/i, '')}.session.json`;
  const quizHash = hashQuiz(await readFile(quizPath, 'utf8'));
  const saved = values.fresh ? undefined : await readSession(sessionPath);
  const resume = saved && saved.quizHash === quizHash && saved.game.phase !== 'finished' ? saved : undefined;

  let server: QuizServer | undefined;
  try {
    server = await createQuizServer({
      quiz,
      port,
      publicHost: values['public-host'],
      session: { path: sessionPath, quizHash, resume },
      onNetworkAction(action) {
        if (action === 'use-lan') {
          tunnel?.stop();
          server?.setNetwork({ mode: 'lan', tunnelAvailable: true });
          console.log('Switched to local Wi-Fi only.');
        } else if (tunnel) {
          tunnel.start();
        }
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try another with --port 3001.`);
    } else {
      console.error((error as Error).message);
    }
    process.exit(1);
  }

  const game = server.game;
  const resumedAt =
    resume && game.phase !== 'lobby'
      ? ` at question ${game.questionIndex + 1} of ${quiz.questions.length}`
      : resume
        ? ' in the lobby'
        : '';
  console.log(`
Pub quiz: "${quiz.title}" (${quiz.questions.length} questions)${
    resume ? `\nResumed the unfinished quiz${resumedAt}. Teams reconnect automatically. (Use --fresh to start over.)` : ''
  }

  Host screen:  ${server.hostUrl}
  ${values.lan ? 'Teams join: ' : 'Local link: '}  ${server.lanJoinUrl}
  Room code:    ${server.roomCode}

${
    values.lan
      ? "Local Wi-Fi only: teams' phones must be on the same Wi-Fi as this laptop."
      : publicUrl
        ? `Teams can also join at ${publicUrl}/?room=${server.roomCode}`
        : 'Setting up the internet link; the QR code on the host screen switches to it when ready.'
  }
Press Ctrl+C to stop.
`);

  const quizServer = server;
  if (publicUrl) {
    server.setNetwork({ mode: 'tunnel', state: 'up', provider: 'your own address', publicUrl });
  } else if (!values.lan) {
    let lastState: string | undefined;
    tunnel = new TunnelManager({
      port: server.port,
      provider:
        values.tunnel === 'ngrok'
          ? ngrokProvider()
          : async () => cloudflaredProvider(await ensureCloudflared((message) => console.log(message))),
      check: async (url) => {
        const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
        return (await res.text()) === quizServer.instanceId;
      },
      onStatus(status: NetworkStatus) {
        quizServer.setNetwork(status);
        if (status.state === lastState && status.state !== 'down') return;
        lastState = status.state;
        if (status.state === 'up') console.log(`Internet link ready: ${status.publicUrl}/?room=${quizServer.roomCode}`);
        if (status.state === 'down') console.log(`Internet link problem: ${status.message}`);
      },
    });
    tunnel.start();
  }

  if (!values['no-open']) openBrowser(server.hostUrl);

  const shutdown = () => {
    tunnel?.stop();
    server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
