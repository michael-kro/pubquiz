#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BrandingStore } from './branding.ts';
import { Library } from './library.ts';
import { chooseLibraryDir } from './settings.ts';
import { loadQuizFile, QuizError, type Quiz } from './quiz.ts';
import { createQuizServer, type QuizServer, type SessionOptions } from './server.ts';
import { hashQuiz, readSession } from './session.ts';
import { shortLinksFor } from './shortlink.ts';
import { cloudflaredProvider, ensureCloudflared, ngrokProvider, TunnelManager, type NetworkStatus } from './tunnel.ts';

const DEFAULT_LIBRARY = join(homedir(), 'PubQuiz');

const USAGE = `Usage: pubquiz [quiz.yaml] [options]

With no quiz file, opens your quiz library (${DEFAULT_LIBRARY}) on the host screen,
where you can write, import and run quizzes. With a quiz file, runs that quiz straight away.

Teams join over the internet by default (a free Cloudflare link, no account needed), so
their phones can use 4G or any Wi-Fi. With no internet, use --lan and put the phones on
the same Wi-Fi as this laptop (or this laptop's hotspot).

Options:
  -p, --port <n>         Port to listen on (default 3000)
      --lan              Local Wi-Fi only: no internet link
      --tunnel <name>    Internet link to use: cloudflare (default) or ngrok
      --short-links      Ask is.gd for a short address for the internet link (it is sent to is.gd; the host link never is)
      --public-url <url> Use your own public address instead (e.g. a VPS or Tailscale Funnel)
      --public-host <h>  Address to put in the local join link (default: this laptop's Wi-Fi address)
      --quizzes <dir>    Where the quiz library lives (default ${DEFAULT_LIBRARY}; or set PUBQUIZ_HOME,
                         or change it in the app under Settings)
      --branding <dir>   Folder with branding.json and a logo (name, colours, logo on every page).
                         Default: the "branding" folder inside your quiz library, editable from the host screen
      --wifi-ssid <name>      Show a second QR code on the host and TV lobby so teams can join this Wi-Fi network
      --wifi-password <pw>    The password for it (leave out for an open network)
      --no-photos        Don't let teams add a photo (the host can also switch photos off during a quiz)
      --no-name-filter   Allow any team name (the default blocks swearing; invisible characters are always removed)
      --host-pin <pin>   Let the host open /host by typing this PIN (6+ characters), e.g. from a phone
      --host-local-only  Only allow the host screen on this laptop, not from the network or the internet link
      --new-key          Make a new host key now (the old host link and TV link stop working)
      --no-open          Don't open the host screen in a browser
      --fresh            Start over instead of resuming an unfinished quiz
  -h, --help             Show this help

Quizzes are saved as they run. If the laptop crashes or you restart, run the same
command again to carry on.`;

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The library's host key is kept on disk, so the host link (and any bookmark of it) survives restarts. */
async function libraryHostKey(dir: string, renew = false): Promise<string> {
  const path = join(dir, '.host-key');
  const saved = (await readFile(path, 'utf8').catch(() => '')).trim();
  if (!renew && /^[\w-]{20,}$/.test(saved)) return saved;
  const key = randomBytes(18).toString('base64url');
  await mkdir(dir, { recursive: true });
  await writeFile(path, key, { mode: 0o600 });
  return key;
}

/** Loads a quiz file given on the command line, with its saved session if there's an unfinished one. */
async function loadQuizArgument(quizPath: string, fresh: boolean): Promise<{ quiz: Quiz; session: SessionOptions }> {
  let quiz: Quiz;
  try {
    quiz = await loadQuizFile(quizPath);
  } catch (error) {
    if (error instanceof QuizError) fail(`Problems in ${quizPath}:\n  ${error.issues.join('\n  ')}`);
    fail(`Couldn't read ${quizPath}: ${(error as Error).message}`);
  }
  const path = `${quizPath.replace(/\.ya?ml$/i, '')}.session.json`;
  const quizHash = hashQuiz(await readFile(quizPath, 'utf8'));
  const saved = fresh ? undefined : await readSession(path);
  const resume = saved && saved.quizHash === quizHash && saved.game.phase !== 'finished' ? saved : undefined;
  return { quiz, session: { path, quizHash, resume } };
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
      quizzes: { type: 'string' },
      'host-pin': { type: 'string' },
      'host-local-only': { type: 'boolean', default: false },
      'open-host': { type: 'boolean', default: false },
      'short-links': { type: 'boolean', default: false },
      'new-key': { type: 'boolean', default: false },
      'no-name-filter': { type: 'boolean', default: false },
      'no-photos': { type: 'boolean', default: false },
      'wifi-ssid': { type: 'string' },
      'wifi-password': { type: 'string' },
      branding: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`Invalid port: ${values.port}`);
  if (!['cloudflare', 'ngrok'].includes(values.tunnel)) fail(`Unknown --tunnel "${values.tunnel}". Use cloudflare or ngrok.`);
  const publicUrl = values['public-url']?.replace(/\/+$/, '');
  if (publicUrl && !/^https?:\/\//.test(publicUrl)) fail('--public-url must start with https:// (or http://).');

  if (values['open-host']) console.log('WARNING: --open-host is on. Anyone who can reach this address can run the quiz without a key. Use it for testing only.');
  const hostPin = values['host-pin'];
  if (hostPin !== undefined && hostPin.trim().length < 6) {
    fail('--host-pin needs at least 6 characters. The quiz can be reached from the internet, so a short PIN could be guessed.');
  }

  if (values['wifi-password'] && !values['wifi-ssid']) fail('--wifi-password needs --wifi-ssid too.');
  const quizPath = positionals[0];
  const single = quizPath ? await loadQuizArgument(quizPath, values.fresh) : undefined;
  const folder = await chooseLibraryDir(values.quizzes);
  const library = quizPath ? undefined : new Library(folder.dir);

  // A library keeps its branding inside itself, where the host screen can edit it. A folder given on the
  // command line is used as it is, which is the way to brand a single quiz file.
  const branding = values.branding
    ? new BrandingStore(resolve(values.branding), { readOnly: !library })
    : library
      ? new BrandingStore(join(library.dir, 'branding'))
      : undefined;

  let tunnel: TunnelManager | undefined;
  let server: QuizServer | undefined;
  try {
    server = await createQuizServer({
      quiz: single?.quiz,
      session: single?.session,
      library,
      // The host's soundboard lives with the library (or in the default library folder when a single quiz file is run).
      clipsDir: join(library?.dir ?? folder.dir, 'clips'),
      libraryFolder: folder,
      hostKey: library ? await libraryHostKey(library.dir, values['new-key']) : values['new-key'] ? randomBytes(18).toString('base64url') : undefined,
      hostPin: hostPin?.trim(),
      hostLocalOnly: values['host-local-only'],
      openHost: values['open-host'],
      onHostKeyChange: library ? (key: string) => void writeFile(join(library.dir, '.host-key'), key, { mode: 0o600 }) : undefined,
      branding,
      nameFilter: !values['no-name-filter'],
      photos: !values['no-photos'],
      wifi: values['wifi-ssid'] ? { ssid: values['wifi-ssid'], password: values['wifi-password'] || undefined } : undefined,
      port,
      publicHost: values['public-host'],
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
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') fail(`Port ${port} is already in use. Try another with --port 3001.`);
    fail((error as Error).message);
  }

  const resume = single?.session.resume;
  const game = server.game;
  const heading = single
    ? `Pub quiz: "${single.quiz.title}" (${single.quiz.questions.length} questions)${
        resume && game
          ? `\nResumed the unfinished quiz${
              game.phase === 'lobby' ? ' in the lobby' : ` at question ${game.questionIndex + 1} of ${single.quiz.questions.length}`
            }. Teams reconnect automatically. (Use --fresh to start over.)`
          : ''
      }`
    : `Pub quiz library: ${library!.dir}`;
  console.log(`
${heading}

  Host screen:  ${server.hostUrl}${hostPin ? `\n  Host on a phone: open /host on the same address and type the PIN` : ''}${single ? `\n  ${values.lan ? 'Teams join: ' : 'Local link: '}  ${server.lanJoinUrl}\n  Room code:    ${server.roomCode}` : ''}

${
  values.lan
    ? "Local Wi-Fi only: teams' phones must be on the same Wi-Fi as this laptop."
    : publicUrl
      ? `Teams join through ${publicUrl}`
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
        if (status.state !== 'up') quizServer.setShortLinks(undefined);
        if (status.state === lastState && status.state !== 'down') return;
        lastState = status.state;
        if (status.state === 'up') {
          console.log(`Internet link ready: ${status.publicUrl}`);
          if (values['short-links'] && status.publicUrl) {
            void shortLinksFor(status.publicUrl, Boolean(values['open-host'])).then((links) => {
              quizServer.setShortLinks(links);
              if (links.join) console.log(`Short link for teams: ${links.join}${links.tv ? `   TV: ${links.tv}` : ''}`);
              else console.log('Could not make a short link (the full address still works).');
            });
          }
        }
        if (status.state === 'down') console.log(`Internet link problem: ${status.message}`);
      },
    });
    tunnel.start();
  }

  if (!values['no-open']) openBrowser(server.hostUrl);

  const shutdown = () => {
    tunnel?.stop();
    quizServer.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
