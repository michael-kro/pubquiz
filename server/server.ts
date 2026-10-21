import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, dirname, extname, join } from 'node:path';
import QRCode from 'qrcode';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleApi } from './api.ts';
import { readPublicFile } from './assets.ts';
import { Game, type Team } from './game.ts';
import type { Library } from './library.ts';
import type { BrandingSource } from './branding.ts';
import { ClipError, ClipStore, MAX_CLIP_BYTES } from './clips.ts';
import { changeLibraryDir, defaultLibraryDir, SettingsError, type FolderChoice } from './settings.ts';
import { clientAddress, isLocalRequest, TokenBucket, WindowCounter } from './limits.ts';
import { MAX_PHOTO_BYTES, PhotoStore, sniffImage } from './photos.ts';
import * as practice from './practice.ts';
import { cleanLearnerName, currentSession, PracticeError, PracticeStore, startSession } from './practice.ts';
import { loadBundledFacts, pickFacts } from './facts.ts';
import { lanAddress, wifiQrText } from './net.ts';
import type { ShortLinks } from './shortlink.ts';
import { parseClientMessage, type HostIdleView, type HostView, type ServerMessage } from './protocol.ts';
import { loadQuizFile, QuizError, type Quiz } from './quiz.ts';
import { createSaver, hashQuiz, readSession, writeSession, type Session } from './session.ts';
import type { NetworkStatus } from './tunnel.ts';

const ROUTES: Record<string, string> = { '/': 'play.html', '/host': 'host.html', '/screen': 'screen.html', '/practice': 'practice.html' };
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
// No I or O, so codes can't be misread as 1 or 0.
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PING_INTERVAL_MS = 5_000;
/** Pings in a row a connection can miss before it's treated as gone. */
const MAX_MISSED_PINGS = 3;
const RTT_SAMPLES = 5;
/** Most connections one address may hold open, and in total (a pub's Wi-Fi shares one address, so this is generous). */
const MAX_CONNECTIONS_PER_ADDRESS = 80;
const MAX_CONNECTIONS = 600;
/** A phone sends a message or two per question; this only stops floods. */
const MESSAGE_BURST = 30;
const MESSAGES_PER_SECOND = 10;
const MAX_DROPPED_MESSAGES = 200;
/** Wrong room codes and wrong team codes an address may try per minute. */
const MAX_JOIN_GUESSES_PER_MINUTE = 20;

/** Sent with every page: the host key arrives in the host page's link, so nothing may leak it as a referrer. `blob:` is for the pictures and clips the pages fetch with the key in a header. */
const PAGE_HEADERS = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; " +
    "connect-src 'self' ws: wss:; media-src 'self' blob: https: http:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",  // No camera, microphone or location for anything on the page, except the same-origin camera (a team's photo).
  'permissions-policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

/** What an error page carries, so it is typed and as locked down as any other response. */
const NOT_FOUND_HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...PAGE_HEADERS };

export interface SessionOptions {
  path: string;
  quizHash: string;
  resume?: Session;
}

export interface ServerOptions {
  /** Start running this quiz straight away. */
  quiz?: Quiz;
  /** Where to save that quiz as it runs, and optionally a saved session to carry on from. */
  session?: SessionOptions;
  /** The host's quiz library: enables the editor and choosing a quiz to run. */
  library?: Library;
  /** A short PIN the host can type at /host instead of using the secret link (for running the quiz from a phone). */
  hostPin?: string;
  /** A folder of audio clips for the host's soundboard. */
  clipsDir?: string;
  /** Where the library lives and why (shown, and changeable, in the app's Settings). */
  libraryFolder?: FolderChoice;
  /** Only let the host controls be used from the machine running the quiz (not the network or the tunnel). */
  hostLocalOnly?: boolean;
  /** Testing only: /host and /screen open without the key (the page asks for the key itself). Not documented for hosts. */
  openHost?: boolean;
  /** Called when the host key is changed from the host screen, so it can be saved. */
  onHostKeyChange?(key: string): void;
  /** Name, colours and logo for every page. */
  branding?: BrandingSource;
  /** The Wi-Fi network teams can join, shown as a QR code beside the join code (for a hotspot). */
  wifi?: { ssid: string; password?: string };
  /** Let teams add a photo (the host can still switch it off). Default on. */
  photos?: boolean;
  /** Turn off the team-name word filter. */
  nameFilter?: boolean;
  /** End a question once every team has answered. Off by default: the timer always counts down. */
  closeEarly?: boolean;
  /** Pressing Start quiz stops new teams joining. On by default; the host can untick it in the lobby. */
  lockOnStart?: boolean;
  /** List the teams on the TV's wait screen as they join. On by default; the host can untick it. */
  tvShowTeams?: boolean;
  /** Let the quiz start with no teams. Off by default: the host waits for players (and can tick it to start anyway). */
  allowEmptyStart?: boolean;
  /** Keeps the host link the same across restarts. Defaults to the resumed session's key, or a new one. */
  hostKey?: string;
  port?: number;
  /** Interface to listen on. Defaults to all interfaces so phones can connect. */
  bindHost?: string;
  /** Host name or IP put in the join link. Defaults to the laptop's LAN address. */
  publicHost?: string;
  /** Called when the host asks to switch between the internet link and local Wi-Fi. */
  onNetworkAction?: (action: 'use-lan' | 'use-tunnel') => void;
  pingIntervalMs?: number;
}

export interface QuizServer {
  /** The running quiz's game, if one is running. */
  readonly game: Game | undefined;
  /** The running quiz's room code, or '' when none is running. */
  readonly roomCode: string;
  port: number;
  readonly hostKey: string;
  readonly screenKey: string;
  /** The key the practice page uses (derived from the host key, like the TV's). */
  readonly practiceKey: string;
  readonly hostUrl: string;
  /** The link teams use right now: the internet link when it's up, otherwise the local address. */
  readonly joinUrl: string;
  readonly lanJoinUrl: string;
  /** Random per run; /healthz returns it, so a tunnel check knows it reached this server. */
  instanceId: string;
  startQuiz(quiz: Quiz, session?: SessionOptions): Promise<void>;
  endQuiz(): Promise<void>;
  setNetwork(status: NetworkStatus): void;
  /** Short addresses for the internet link (shown instead of the long one), or none. */
  setShortLinks(links: ShortLinks | undefined): void;
  close(): Promise<void>;
}

/**
 * Whether a joining team is on a phone or tablet: its browser says so (every phone browser does), or the page reports
 * a touch screen (an iPad asking for desktop sites looks like a Mac to the server). A deterrent against playing with a
 * laptop and a search engine, not a lock: anyone can pretend, and that is documented.
 */
export function looksLikePhone(userAgent: string, pageSaysPhone?: boolean): boolean {
  return /\b(Mobi|Android|iPhone|iPad|iPod|Tablet|Silk|Kindle|webOS|Windows Phone)\b/i.test(userAgent) || pageSaysPhone === true;
}

const PHONES_ONLY_ERROR = { t: 'error', code: 'phones-only', message: '📱 Open this on your phone. The quiz master has asked that teams play from a phone: scan the code on the screen with your phone camera.' } as const;

interface Connection {
  ws: WebSocket;
  role?: 'host' | 'team' | 'screen';
  address: string;
  /** The connection came from the machine running the quiz itself. */
  local: boolean;
  /** The browser's User-Agent header, for the phones-only check when a team joins. */
  userAgent: string;
  messages: TokenBucket;
  dropped: number;
  teamId?: string;
  pingSentAt?: number;
  missedPings: number;
  /** Recent round-trip times in ms, newest last. */
  rtts: number[];
}

interface ActiveQuiz {
  quiz: Quiz;
  game: Game;
  roomCode: string;
  saver?: ReturnType<typeof createSaver>;
  photos: PhotoStore;
  resultsWritten?: boolean;
}

/** CSV for spreadsheets. Cells that could be read as formulas are made plain text, since team names are typed by anyone. */
export function toCsv(rows: string[][]): string {
  const cell = (value: string) => {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Median of recent round trips: steady against the odd slow ping. */
function latencyOf(conn: Connection): number {
  if (conn.rtts.length === 0) return 0;
  const sorted = [...conn.rtts].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const newRoomCode = () => Array.from({ length: 4 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');

export async function createQuizServer(options: ServerOptions): Promise<QuizServer> {
  let hostKey = options.hostKey ?? options.session?.resume?.hostKey ?? randomBytes(18).toString('base64url');
  const connections = new Set<Connection>();
  const teamConnections = new Map<string, Connection>();
  const instanceId = randomBytes(9).toString('base64url');
  const joinGuesses = new WindowCounter(MAX_JOIN_GUESSES_PER_MINUTE, 60_000);
  const photoUploads = new WindowCounter(5, 60_000);
  const perAddress = new Map<string, number>();
  // Derived from the host key, so a TV left on /screen reconnects after a restart.
  const deriveScreenKey = () => createHmac('sha256', hostKey).update('screen').digest('base64url').slice(0, 24);
  let screenKey = deriveScreenKey();
  // The practice page has its own key the same way: safe to hand to a learner, and it changes with the host key.
  const derivePracticeKey = () => createHmac('sha256', hostKey).update('practice').digest('base64url').slice(0, 24);
  let practiceKey = derivePracticeKey();
  let active: ActiveQuiz | undefined;
  let baseUrl = '';
  let joinUrl = '';
  let shortLinks: ShortLinks | undefined;
  let qrSvg = '';
  let qrVersion = 0;
  let network: NetworkStatus = { mode: 'lan' };

  let broadcastQueued = false;
  function scheduleBroadcast(): void {
    // Several changes in one tick (e.g. last answer closes the question) go out as one update.
    if (broadcastQueued) return;
    broadcastQueued = true;
    queueMicrotask(() => {
      broadcastQueued = false;
      broadcast();
    });
  }

  function send(conn: Connection, message: ServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(message));
  }

  function hostView(): HostView | HostIdleView {
    if (!active) return { phase: 'idle', library: Boolean(options.library), network, ...(options.openHost ? { openHost: true } : {}) };
    return {
      ...active.game.hostView(),
      roomCode: active.roomCode,
      joinUrl,
      lanJoinUrl: lanUrl(),
      qrVersion,
      network,
      ...(options.openHost ? { openHost: true } : {}),
      ...(shortLinks && (shortLinks.join || shortLinks.tv) ? { shortLinks } : {}),
      canEnd: Boolean(options.library),
      screenKey,
      wifi: options.wifi,
    };
  }

  /** What the TV sees: the host's view without anything that gives the answer away early. */
  function screenView(): HostView | HostIdleView {
    const view = hostView();
    if (view.phase === 'idle') return view;
    const revealed = ['reveal', 'leaderboard', 'finished'].includes(view.phase);
    // With questions kept off the TV, it shows nothing of the question until the answer is revealed. (A music clip still plays.)
    const keepOff = !view.tvShowQuestions && !revealed;
    return {
      ...view,
      question: view.question && !revealed
        ? {
            ...view.question,
            answerText: '',
            answer: undefined,
            info: undefined,
            hostText: undefined,
            // The host's editable copy of the answer (letter, number, nearest) is the answer too. (answerEdited, a yes/no, stays.)
            editValue: undefined,
            editable: undefined,
            ...(keepOff ? { hidden: true, text: '', image: undefined, options: undefined, items: undefined, category: undefined, uncover: undefined } : {}),
          }
        : view.question,
      distribution: keepOff ? undefined : view.distribution,
      review: revealed ? view.review : undefined,
      // A list of guesses with how far off each was gives the answer away.
      guesses: revealed ? view.guesses : undefined,
      // The TV lists the teams only on the wait screen, as they join (and only if the host has not hidden them).
      // Once the quiz is under way it never shows the team list: the leaderboard shows who is winning.
      teams: view.tvShowTeams && view.phase === 'lobby' ? view.teams.map((t) => ({ ...t, code: '' })) : [],
      teamsHidden: !view.tvShowTeams || view.phase !== 'lobby',
      pendingTeams: [],
      screenKey: '',
      canEnd: false,
    };
  }

  function sendState(conn: Connection): void {
    if (conn.role === 'host') {
      send(conn, { t: 'state', view: hostView() });
    } else if (conn.role === 'screen') {
      send(conn, { t: 'state', view: screenView() });
    } else if (conn.role === 'team' && conn.teamId) {
      const view = active?.game.teamView(conn.teamId);
      if (view) send(conn, { t: 'state', view });
    }
  }

  function broadcast(): void {
    for (const conn of connections) sendState(conn);
  }

  function lanUrl(): string {
    return active ? `${baseUrl}/?room=${active.roomCode}` : `${baseUrl}/`;
  }

  async function updateJoinUrl(): Promise<void> {
    const base = network.mode === 'tunnel' && network.state === 'up' && network.publicUrl ? network.publicUrl : baseUrl;
    const url = active ? `${base}/?room=${active.roomCode}` : `${base}/`;
    if (url === joinUrl) return;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    joinUrl = url;
    qrSvg = svg;
    qrVersion++;
  }

  /** Keeps the final scores as a CSV next to the quiz, so they survive the host closing the page. */
  /** Results files being written right now, so shutting down can wait for them instead of leaving a half-saved file. */
  const resultsWrites = new Set<Promise<void>>();

  async function saveResults(sessionPath: string, game: Game): Promise<void> {
    const stamp = new Date().toISOString().slice(0, 10);
    const prefix = basename(sessionPath).replace(/session\.json$/, '');
    const path = join(dirname(sessionPath), `${prefix}results-${stamp}.csv`);
    try {
      await writeFile(`${path}.tmp`, toCsv(game.resultsTable()));
      await rename(`${path}.tmp`, path);
    } catch (error) {
      console.error(`Couldn't save the results file: ${(error as Error).message}`);
    }
  }

  /** Disconnects every team from the running quiz, e.g. because the host ended it. */
  function releaseTeams(): void {
    for (const conn of teamConnections.values()) {
      conn.role = undefined;
      conn.teamId = undefined;
      send(conn, { t: 'quiz-ended' });
    }
    teamConnections.clear();
  }

  async function endQuiz(): Promise<void> {
    if (!active) return;
    const ending = active;
    active = undefined;
    ending.game.dispose();
    await ending.saver?.flush();
    await ending.photos.flush();
    releaseTeams();
    await updateJoinUrl();
    broadcast();
  }

  async function startQuiz(quiz: Quiz, session?: SessionOptions): Promise<void> {
    await endQuiz();
    const resume = session?.resume;
    const roomCode = resume?.roomCode ?? newRoomCode();
    const gameOptions = {
      nameFilter: options.nameFilter,
      closeEarly: options.closeEarly ?? false,
      lockOnStart: options.lockOnStart ?? true,
      tvShowTeams: options.tvShowTeams ?? true,
      allowEmptyStart: options.allowEmptyStart ?? false,
      onChange() {
        current.saver?.schedule();
        if (game.phase === 'finished' && session && !current.resultsWritten) {
          current.resultsWritten = true;
          const writing = saveResults(session.path, game);
          resultsWrites.add(writing);
          void writing.finally(() => resultsWrites.delete(writing));
        }
        scheduleBroadcast();
      },
    };
    const game = resume
      ? Game.restore(quiz, resume.game, gameOptions)
      : new Game(quiz, gameOptions);
    const photoPath = session?.path.replace(/session\.json$/, 'photos.json');
    const photos = resume && photoPath ? await PhotoStore.load(photoPath) : new PhotoStore(photoPath);
    if (!resume) {
      photos.reset();
      game.photosEnabled = options.photos !== false;
    }
    const current: ActiveQuiz = { quiz, game, roomCode, photos };
    if (session) {
      current.saver = createSaver(() =>
        writeSession(session.path, {
          quizHash: session.quizHash,
          roomCode,
          hostKey,
          savedAt: new Date().toISOString(),
          game: game.snapshot(),
        }),
      );
      current.saver.schedule();
    }
    active = current;
    // A resumed game and its photo file are saved separately; make sure they agree about who has one.
    if (resume) for (const [teamId, version] of photos.versions()) game.setPhoto(teamId, version);
    await updateJoinUrl();
    broadcast();
  }

  /** Runs a quiz from the library, resuming its unfinished game unless `fresh`. */
  async function runLibraryQuiz(id: string, fresh: boolean): Promise<{ ok: true } | { ok: false; issues: string[] }> {
    const library = options.library!;
    const path = library.quizPath(id);
    let quiz: Quiz;
    try {
      quiz = await loadQuizFile(path);
    } catch (error) {
      if (error instanceof QuizError) return { ok: false, issues: error.issues };
      throw error;
    }
    const quizHash = hashQuiz(await readFile(path, 'utf8'));
    const saved = fresh ? undefined : await readSession(library.sessionPath(id));
    const resume = saved && saved.quizHash === quizHash && saved.game.phase !== 'finished' ? saved : undefined;
    await startQuiz(quiz, { path: library.sessionPath(id), quizHash, resume });
    return { ok: true };
  }

  function attachTeam(conn: Connection, team: Team): void {
    const previous = teamConnections.get(team.id);
    if (previous && previous !== conn) {
      // The newest device wins; the old one is told why it stopped.
      previous.role = undefined;
      previous.teamId = undefined;
      send(previous, { t: 'replaced' });
      previous.ws.close(4002, 'replaced');
    }
    conn.role = 'team';
    conn.teamId = team.id;
    teamConnections.set(team.id, conn);
    send(conn, { t: 'joined', token: team.token, teamName: team.name });
  }

  function keyIs(expected: string, key: string | undefined): boolean {
    if (key === undefined) return false;
    const a = Buffer.from(key);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const isHostKey = (key: string | undefined) => keyIs(hostKey, key);
  /** The key a request presents, in a header: never in the address, so it cannot end up in a proxy's or anyone's logs. */
  const presentedKey = (req: IncomingMessage): string | undefined => {
    const value = req.headers['x-host-key'] ?? req.headers['x-screen-key'];
    return typeof value === 'string' ? value : undefined;
  };
  /** With --host-local-only the host controls work only from the laptop running the quiz. */
  const hostAllowed = (req: IncomingMessage) => !options.hostLocalOnly || isLocalRequest(req);

  /** Replaces the host key: the old host link and TV link stop working at once. */
  function rotateHostKey(requester: Connection): void {
    hostKey = randomBytes(18).toString('base64url');
    screenKey = deriveScreenKey();
    practiceKey = derivePracticeKey();
    options.onHostKeyChange?.(hostKey);
    for (const conn of [...connections]) {
      if (conn === requester || (conn.role !== 'host' && conn.role !== 'screen')) continue;
      send(conn, { t: 'error', message: 'The host key was changed. Open the new link.' });
      conn.ws.close(4001, 'key changed');
    }
    send(requester, { t: 'host-key', key: hostKey });
    broadcast();
  }

  const builtInFacts = () => loadBundledFacts();

  async function handleMessage(conn: Connection, raw: string): Promise<void> {
    if (!conn.messages.take()) {
      // Too many messages too fast: ignore them, and hang up on a connection that keeps flooding.
      if (conn.dropped++ === 0) send(conn, { t: 'error', message: 'Slow down.' });
      if (conn.dropped > MAX_DROPPED_MESSAGES) conn.ws.terminate();
      return;
    }
    const msg = parseClientMessage(raw);
    if (!msg) return send(conn, { t: 'error', message: 'Unrecognised message.' });
    const game = active?.game;
    const hostOnly = () => {
      if (conn.role === 'host') return true;
      send(conn, { t: 'error', message: 'Only the host can do that.' });
      return false;
    };

    switch (msg.t) {
      case 'host':
        if (options.hostLocalOnly && !conn.local) {
          send(conn, { t: 'error', message: 'The host screen can only be used on the laptop running the quiz.' });
          conn.ws.close(4001, 'not local');
          return;
        }
        if (!isHostKey(msg.key)) {
          send(conn, { t: 'error', message: 'Wrong host key. Use the host link printed when the quiz started.' });
          conn.ws.close(4001, 'bad key');
          return;
        }
        conn.role = 'host';
        sendState(conn);
        return;

      case 'screen':
        if (!keyIs(screenKey, msg.key)) {
          send(conn, { t: 'error', message: 'Wrong screen link. Open the TV link from the host screen.' });
          conn.ws.close(4001, 'bad key');
          return;
        }
        conn.role = 'screen';
        sendState(conn);
        return;

      case 'join': {
        if (conn.role) return send(conn, { t: 'error', message: 'Already joined.' });
        if (!active || !game) return send(conn, { t: 'error', message: 'No quiz is running right now. Ask the quiz master.' });
        if (joinGuesses.blocked(conn.address)) return send(conn, { t: 'error', message: 'Too many wrong tries. Wait a minute and try again.' });
        if (game.phonesOnly && !looksLikePhone(conn.userAgent, msg.phone)) return send(conn, PHONES_ONLY_ERROR);
        // With no room code the phone just opened the home page, and joins the one quiz that is running.
        // A code that is given (an old link, say) must still match.
        const room = (msg.room ?? '').trim().toUpperCase();
        if (room && room !== active.roomCode) {
          joinGuesses.add(conn.address);
          return send(conn, { t: 'error', message: 'No quiz with that room code. Leave the room code out and open the home page, or scan the code on the screen again.' });
        }
        const result = game.join(msg.name);
        if (!result.ok) return send(conn, { t: 'error', message: result.error });
        attachTeam(conn, result.value);
        return;
      }

      case 'rejoin': {
        if (conn.role) return send(conn, { t: 'error', message: 'Already joined.' });
        // Typed team codes can be guessed, so wrong ones are limited. A stale saved token isn't a guess.
        if (msg.code !== undefined && joinGuesses.blocked(conn.address)) {
          return send(conn, { t: 'error', message: 'Too many wrong tries. Wait a minute and try again.' });
        }
        // A team cannot move to a laptop by carrying its code over.
        if (game?.phonesOnly && !looksLikePhone(conn.userAgent, msg.phone)) return send(conn, PHONES_ONLY_ERROR);
        const team = game?.rejoin({ token: msg.token, code: msg.code });
        if (!team) {
          if (msg.token === undefined) joinGuesses.add(conn.address);
          return send(conn, { t: 'rejoin-failed' });
        }
        attachTeam(conn, team);
        return;
      }

      case 'answer': {
        if (conn.role !== 'team' || !conn.teamId || !game) return send(conn, { t: 'error', message: 'Join a team first.' });
        const result = game.answer(conn.teamId, msg.value, latencyOf(conn), msg.elapsedMs);
        if (!result.ok) send(conn, { t: 'error', message: result.error });
        return;
      }

      case 'mark': {
        if (!hostOnly() || !game) return;
        const result = game.mark(msg.key, msg.correct);
        if (!result.ok) send(conn, { t: 'error', message: result.error });
        return;
      }

      case 'advance':
        if (!hostOnly()) return;
        if (game && game.phase === 'lobby' && !game.canStart()) {
          return send(conn, { t: 'error', message: 'Waiting for the first team to join. (Tick "Allow starting with no teams" to start anyway.)' });
        }
        game?.advance();
        return;

      case 'leaderboard': {
        if (!hostOnly() || !game) return;
        const result = game.showLeaderboard();
        if (!result.ok) send(conn, { t: 'error', message: result.error });
        return;
      }

      case 'break': {
        if (!hostOnly() || !active) return;
        const own = active.quiz.facts;
        const facts = pickFacts(own.length ? own : await builtInFacts(), 40);
        const result = active.game.startBreak(msg.minutes, facts);
        if (!result.ok) send(conn, { t: 'error', message: result.error });
        return;
      }

      case 'end-break': {
        if (!hostOnly() || !game) return;
        const result = game.endBreak();
        if (!result.ok) send(conn, { t: 'error', message: result.error });
        return;
      }

      case 'set-answer': {
        if (!hostOnly() || !game) return;
        const result = game.setAnswer(msg.value);
        if (!result.ok) send(conn, { t: 'error', message: result.error });
        return;
      }

      case 'start-on-last':
        if (hostOnly()) game?.setStartOnLastAnswer(msg.on);
        return;

      case 'lock-on-start':
        if (hostOnly()) game?.setLockOnStart(msg.on);
        return;

      case 'set-prizes':
        if (hostOnly()) game?.setPrizes(msg.prizes);
        return;

      case 'admit':
        if (hostOnly()) game?.admit(msg.teamId);
        return;

      case 'admit-all':
        if (hostOnly()) game?.admitAll();
        return;

      case 'set-entry-fee':
        if (hostOnly()) game?.setEntryFee(msg.fee);
        return;

      case 'require-admission':
        if (hostOnly()) game?.setRequireAdmission(msg.on);
        return;

      case 'phones-only':
        if (hostOnly()) game?.setPhonesOnly(msg.on);
        return;

      case 'play-clip': {
        if (!hostOnly()) return;
        if (!clips || !(await clips.has(msg.name))) return send(conn, { t: 'error', message: 'That clip is gone.' });
        const title = (await clips.list()).find((c) => c.name === msg.name)?.title ?? msg.name;
        for (const other of connections) {
          if (other.role === 'screen') send(other, { t: 'play-clip', name: msg.name, title });
        }
        return;
      }

      case 'stop-clips':
        if (hostOnly()) for (const other of connections) if (other.role === 'screen') send(other, { t: 'stop-clips' });
        return;

      case 'set-max-teams':
        if (hostOnly()) game?.setMaxTeams(msg.max);
        return;

      case 'allow-empty-start':
        if (hostOnly()) game?.setAllowEmptyStart(msg.on);
        return;

      case 'lock-joining':
        if (hostOnly()) game?.setJoiningLocked(msg.locked);
        return;

      case 'rotate-key':
        if (hostOnly()) rotateHostKey(conn);
        return;

      case 'read-out':
        if (hostOnly()) game?.setReadOut(msg.on);
        return;

      case 'close-early':
        if (hostOnly()) game?.setCloseEarly(msg.on);
        return;

      case 'start-timer':
        if (hostOnly()) {
          const result = game?.startTimerNow();
          if (result && !result.ok) send(conn, { t: 'error', message: result.error });
        }
        return;

      case 'show-join':
        if (hostOnly()) game?.setShowJoin(msg.shown);
        return;

      case 'head-start': {
        if (!hostOnly()) return;
        const result = game?.setHeadStart(msg.teamId, msg.seconds);
        if (result && !result.ok) send(conn, { t: 'error', message: result.error });
        return;
      }

      case 'tv-questions':
        if (hostOnly()) game?.setTvShowQuestions(msg.visible);
        return;

      case 'tv-teams':
        if (hostOnly()) game?.setTvShowTeams(msg.visible);
        return;

      case 'wager': {
        if (conn.role !== 'team' || !conn.teamId || !game) return send(conn, { t: 'error', message: 'Join a team first.' });
        const result = game.placeWager(conn.teamId, msg.amount);
        if (!result.ok) send(conn, { t: 'error', message: result.error });
        return;
      }

      case 'buzz': {
        if (conn.role !== 'team' || !conn.teamId || !game) return send(conn, { t: 'error', message: 'Join a team first.' });
        const result = game.buzz(conn.teamId, latencyOf(conn), msg.elapsedMs);
        if (!result.ok) send(conn, { t: 'error', message: result.error });
        return;
      }

      case 'judge': {
        if (!hostOnly() || !game) return;
        const result = game.judge(msg.correct);
        if (!result.ok) send(conn, { t: 'error', message: result.error });
        return;
      }

      case 'end-round': {
        if (!hostOnly() || !game) return;
        const result = game.endRound();
        if (!result.ok) send(conn, { t: 'error', message: result.error });
        return;
      }

      case 'pause':
      case 'resume':
      case 'extend':
      case 'skip': {
        if (!hostOnly() || !game) return;
        const result =
          msg.t === 'pause' ? game.pause() : msg.t === 'resume' ? game.resume() : msg.t === 'extend' ? game.extend(msg.seconds ?? 10) : game.skip();
        if (!result.ok) send(conn, { t: 'error', message: result.error });
        return;
      }

      case 'end-quiz':
        if (!hostOnly()) return;
        if (!options.library) return send(conn, { t: 'error', message: 'Restart the program to run another quiz.' });
        void endQuiz();
        return;

      case 'photos':
        if (hostOnly()) game?.setPhotosEnabled(msg.enabled);
        return;

      case 'remove-photo':
        if (hostOnly() && active) {
          active.photos.remove(msg.teamId);
          active.game.setPhoto(msg.teamId);
        }
        return;

      case 'network':
        if (hostOnly()) options.onNetworkAction?.(msg.action);
        return;

      case 'kick': {
        if (!hostOnly() || !game) return;
        const teamConn = teamConnections.get(msg.teamId);
        teamConnections.delete(msg.teamId);
        game.kick(msg.teamId);
        active?.photos.remove(msg.teamId);
        if (teamConn) {
          teamConn.role = undefined;
          teamConn.teamId = undefined;
          send(teamConn, { t: 'kicked' });
          teamConn.ws.close(4003, 'kicked');
        }
        return;
      }
    }
  }

  // PIN login: wrong guesses are limited per address, and overall, so a PIN can't be brute-forced.
  const failures = new Map<string, { count: number; resetAt: number }>();
  let totalFailures = { count: 0, resetAt: 0 };
  const MAX_FAILURES_PER_ADDRESS = 5;
  const MAX_FAILURES_TOTAL = 20;
  const FAILURE_WINDOW_MS = 60_000;

  async function handlePhotoUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const token = req.headers['x-team-token'];
    const team = active && typeof token === 'string' ? active.game.teamByToken(token) : undefined;
    if (!active || !team) return json(401, { error: 'Join the quiz first.' });
    if (req.method === 'DELETE') {
      active.photos.remove(team.id);
      active.game.setPhoto(team.id);
      return json(200, { ok: true });
    }
    if (!active.game.photosEnabled) return json(403, { error: 'The quiz master has turned team photos off.' });
    if (photoUploads.blocked(team.id)) return json(429, { error: 'That is a lot of photos. Wait a minute and try again.' });
    if (Number(req.headers['content-length'] ?? 0) > MAX_PHOTO_BYTES) return json(413, { error: 'That photo is too big.' });

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_PHOTO_BYTES) return json(413, { error: 'That photo is too big.' });
      chunks.push(chunk as Buffer);
    }
    const data = Buffer.concat(chunks);
    const contentType = sniffImage(data);
    if (!contentType) return json(415, { error: 'Use a JPEG, PNG or WebP photo.' });
    photoUploads.add(team.id);
    const version = active.photos.set(team.id, data, contentType);
    active.game.setPhoto(team.id, version);
    return json(200, { ok: true, photo: `/team-photo/${team.id}?v=${version}` });
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET') return json(200, options.openHost ? { pin: false, open: true } : { pin: Boolean(options.hostPin) });
    if (req.method !== 'POST' || !(options.hostPin || options.openHost)) return json(404, { error: 'Not found.' });
    if (!hostAllowed(req)) return json(403, { error: 'The host screen can only be used on the laptop running the quiz.' });

    const now = Date.now();
    const address = clientAddress(req);
    const mine = failures.get(address);
    if (totalFailures.resetAt < now) totalFailures = { count: 0, resetAt: now + FAILURE_WINDOW_MS };
    if ((mine && mine.resetAt > now && mine.count >= MAX_FAILURES_PER_ADDRESS) || totalFailures.count >= MAX_FAILURES_TOTAL) {
      return json(429, { error: 'Too many wrong PINs. Wait a minute and try again.' });
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1000) return json(413, { error: 'Too big.' });
    }
    let pin: unknown;
    try {
      pin = (JSON.parse(body) as { pin?: unknown }).pin;
    } catch {
      return json(400, { error: 'Expected JSON.' });
    }
    if (options.openHost && hostAllowed(req)) return json(200, { key: (JSON.parse(body) as { screen?: unknown }).screen === true ? screenKey : hostKey });
    if (typeof pin === 'string' && options.hostPin && keyIs(options.hostPin, pin.trim())) {
      failures.delete(address);
      return json(200, { key: hostKey });
    }
    const entry = mine && mine.resetAt > now ? mine : { count: 0, resetAt: now + FAILURE_WINDOW_MS };
    entry.count++;
    failures.set(address, entry);
    totalFailures.count++;
    return json(401, { error: 'Wrong PIN.' });
  }

  const clips = options.clipsDir ? new ClipStore(options.clipsDir) : undefined;

  /** Sends bytes, answering byte-range requests (Safari will only play audio from a server that does). */
  function sendBytes(req: IncomingMessage, res: ServerResponse, data: Buffer, headers: Record<string, string>): void {
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      const size = data.length;
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      res.end(data.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...headers, 'accept-ranges': 'bytes', 'content-length': data.length });
    res.end(data);
  }

  /** The soundboard: /api/clips (list, upload, delete; host only) and /clip/<name> (played by the host and the TV). */
  async function handleClips(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { pathname } = url;
    const isApi = pathname === '/api/clips' || pathname.startsWith('/api/clips/');
    if (!isApi && !pathname.startsWith('/clip/')) return false;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const key = presentedKey(req);
    const isHost = isHostKey(key) && hostAllowed(req);
    if (!clips) return void json(404, { error: 'Clips are not set up.' }), true;
    try {
      if (isApi) {
        if (!isHost) return void json(401, { error: 'Use the host link printed when the quiz program started.' }), true;
        const name = decodeURIComponent(pathname.slice('/api/clips/'.length));
        if (pathname === '/api/clips' && req.method === 'GET') return void json(200, await clips.list()), true;
        if (pathname === '/api/clips' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > MAX_CLIP_BYTES) throw new ClipError('Clips can be at most 20 MB.', 413);
            chunks.push(chunk as Buffer);
          }
          return void json(201, await clips.add(url.searchParams.get('name') ?? '', Buffer.concat(chunks), url.searchParams.get('title') ?? undefined)), true;
        }
        if (name && req.method === 'DELETE') {
          await clips.remove(name);
          return void json(200, { ok: true }), true;
        }
        return void json(404, { error: 'Not found.' }), true;
      }
      // Playing a clip: the host, or the TV (which has its own key).
      if (!(isHost || keyIs(screenKey, key))) {
        res.writeHead(404, NOT_FOUND_HEADERS).end('Not found');
        return true;
      }
      const clip = await clips.read(decodeURIComponent(pathname.slice('/clip/'.length)));
      sendBytes(req, res, clip.data, { 'content-type': clip.contentType, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
      return true;
    } catch (error) {
      if (error instanceof ClipError) return void json(error.status, { error: error.message }), true;
      throw error;
    }
  }

  // Practice mode: one learner over plain HTTP, with its own key. Sessions live in the library, one file per learner.
  const practiceStore = options.library ? new PracticeStore(options.library.dir) : undefined;
  const practiceQuizzes = new Map<string, { hash: string; quiz: Quiz }>();
  const QUIZ_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;

  /** A quiz from the library, loaded with its pictures and kept until the file changes. */
  async function practiceQuiz(id: string): Promise<{ hash: string; quiz: Quiz }> {
    const library = options.library!;
    if (!QUIZ_ID.test(id)) throw new PracticeError('No such quiz.', 404);
    let source: string;
    try {
      source = await readFile(library.quizPath(id), 'utf8');
    } catch {
      throw new PracticeError('No such quiz.', 404);
    }
    const hash = hashQuiz(source);
    const cached = practiceQuizzes.get(id);
    if (cached && cached.hash === hash) return cached;
    let quiz: Quiz;
    try {
      quiz = await loadQuizFile(library.quizPath(id));
    } catch (error) {
      if (error instanceof QuizError) throw new PracticeError(`This quiz has something to fix first: ${error.issues[0] ?? ''}`, 422);
      throw error;
    }
    const entry = { hash, quiz };
    practiceQuizzes.set(id, entry);
    if (practiceQuizzes.size > 20) practiceQuizzes.delete(practiceQuizzes.keys().next().value!);
    return entry;
  }

  async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64 * 1024) throw new PracticeError('Too big.', 413);
    }
    if (!body.trim()) return {};
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new PracticeError('Expected JSON.');
    }
  }

  /** /api/practice/… for the practice page (its own key, or the host's), and the practice link and QR code for the host. */
  async function handlePractice(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { pathname } = url;
    if (pathname !== '/practice-qr.svg' && pathname !== '/api/practice' && !pathname.startsWith('/api/practice/')) return false;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const library = options.library;
    if (!practiceStore || !library) return void json(404, { error: 'Practice mode needs a quiz library.' }), true;
    const presented = req.headers['x-practice-key'];
    const asHost = isHostKey(presentedKey(req)) && hostAllowed(req);
    const allowed = asHost || keyIs(practiceKey, typeof presented === 'string' ? presented : undefined);
    const base = network.mode === 'tunnel' && network.state === 'up' && network.publicUrl ? network.publicUrl : baseUrl;
    const practiceUrl = `${base}/practice#key=${practiceKey}`;
    const method = req.method ?? 'GET';
    try {
      if (pathname === '/practice-qr.svg') {
        if (!asHost) {
          res.writeHead(401, { 'content-type': 'text/plain', ...PAGE_HEADERS });
          res.end('Use the host link.');
          return true;
        }
        const svg = await QRCode.toString(practiceUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        res.writeHead(200, { 'content-type': CONTENT_TYPES['.svg'], 'cache-control': 'no-store' });
        res.end(svg);
        return true;
      }
      if (pathname === '/api/practice/link') {
        if (!asHost) return void json(401, { error: 'Use the host link.' }), true;
        return void json(200, { url: practiceUrl }), true;
      }
      if (!allowed) return void json(401, { error: 'Open the practice link from the host screen.' }), true;

      const parts = pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent);
      if (parts[0] === 'quizzes' && parts.length === 1 && method === 'GET') {
        const list = (await library.list()).filter((q) => q.problems === 0).map(({ id, title, rounds, questions }) => ({ id, title, rounds, questions }));
        return void json(200, list), true;
      }
      if (parts[0] === 'quizzes' && parts[2] === 'media' && parts.length === 4 && method === 'GET') {
        const media = (await practiceQuiz(parts[1]!)).quiz.media.get(parts[3]!);
        if (!media) return void json(404, { error: 'Not found.' }), true;
        sendBytes(req, res, media.data, {
          'content-type': media.contentType,
          'cache-control': 'private, max-age=3600',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          'x-content-type-options': 'nosniff',
        });
        return true;
      }
      if (parts[0] === 'learners' && parts.length === 1 && method === 'GET') return void json(200, await practiceStore.learners()), true;
      if (parts[0] !== 'learners' || !parts[1]) return void json(404, { error: 'Not found.' }), true;

      const name = cleanLearnerName(parts[1]);
      const learner = await practiceStore.load(name);
      const historyOf = () =>
        learner.sessions
          .filter((s) => s.finishedAt)
          .map((s) => ({ id: s.id, quizId: s.quizId, quizTitle: s.quizTitle, mode: s.mode, startedAt: s.startedAt, finishedAt: s.finishedAt, right: Object.values(s.answers).filter((a) => a.correct).length, total: s.order.length, elapsedMs: s.elapsedMs }))
          .reverse();
      /** The current session with its quiz, provided the quiz is still the one it started on. */
      const currentWithQuiz = async () => {
        const session = currentSession(learner);
        if (!session) return undefined;
        try {
          const { hash, quiz } = await practiceQuiz(session.quizId);
          if (hash === session.quizHash) return { session, quiz };
        } catch {
          // The quiz is gone or broken: the session cannot carry on.
        }
        practice.finish(session);
        practice.forgetReview(learner, session.quizId);
        await practiceStore.save(learner);
        return undefined;
      };
      /** Ends a session properly: its summary is kept and the review boxes move on. */
      const close = (session: practice.PracticeSession, quiz: Quiz) => {
        practice.finish(session, quiz);
        practice.updateReview(learner, session, quiz);
      };
      const answerView = async () => {
        const live = await currentWithQuiz();
        return json(200, { name: learner.name, current: live ? practice.view(live.session, live.quiz) : null, history: historyOf(), due: practice.dueReview(learner) });
      };

      if (parts.length === 2 && method === 'GET') return void (await answerView()), true;
      if (parts[2] === 'progress' && parts.length === 3 && method === 'GET') return void json(200, { name: learner.name, ...practice.progress(learner) }), true;
      if (parts[2] === 'export.csv' && parts.length === 3 && method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${learner.name.replace(/[^\w .-]/g, '_')} practice.csv"`, 'cache-control': 'no-store' });
        res.end('﻿' + practice.learnerCsv(learner));
        return true;
      }

      if (parts[2] === 'sessions' && parts.length === 3 && method === 'POST') {
        const body = await readJsonBody(req);
        const quizId = typeof body['quizId'] === 'string' ? body['quizId'] : '';
        const { hash, quiz } = await practiceQuiz(quizId);
        const count = Number(body['count']);
        let only = Array.isArray(body['only']) ? body['only'].filter((i): i is number => Number.isInteger(i) && i >= 0 && i < quiz.questions.length) : undefined;
        let kind: practice.PracticeOptions['kind'];
        if (body['review'] === true) {
          // What is due for another look in this quiz, provided the quiz is still the one those questions came from.
          only = practice.dueReview(learner).find((g) => g.quizId === quizId)?.indices.filter((i) => i < quiz.questions.length) ?? [];
          if (!only.length) throw new PracticeError('Nothing in this quiz is due for review right now.');
          kind = 'review';
        }
        const minutes = body['timeLimitMinutes'] === undefined ? undefined : Number(body['timeLimitMinutes']);
        for (const s of learner.sessions) if (!s.finishedAt) close(s, s.quizId === quizId ? quiz : (await practiceQuiz(s.quizId).catch(() => undefined))?.quiz ?? quiz); // one at a time; a half-done one stays in the history
        learner.sessions.push(startSession(quiz, quizId, hash, { mode: body['mode'] === 'test' ? 'test' : 'learn', shuffle: body['shuffle'] === true, ...(Number.isInteger(count) && count > 0 ? { count } : {}), ...(only?.length ? { only } : {}), ...(minutes !== undefined ? { timeLimitMinutes: minutes } : {}), ...(kind ? { kind } : {}) }));
        await practiceStore.save(learner);
        return void (await answerView()), true;
      }

      if (parts[2] === 'sessions' && parts[3] && (parts[4] === 'results' || parts[4] === 'export.csv') && method === 'GET') {
        const session = learner.sessions.find((s) => s.id === parts[3]);
        if (!session?.finishedAt) return void json(404, { error: 'No such finished session.' }), true;
        const { hash, quiz } = await practiceQuiz(session.quizId);
        if (hash !== session.quizHash) return void json(409, { error: 'The quiz has changed since this session, so its questions cannot be shown.' }), true;
        const r = practice.results(session, quiz);
        if (parts[4] === 'results') return void json(200, r), true;
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${learner.name.replace(/[^\w .-]/g, '_')} - ${r.quizTitle.replace(/[^\w .-]/g, '_')}.csv"`, 'cache-control': 'no-store' });
        res.end('﻿' + practice.resultsCsv(learner, r));
        return true;
      }

      if (parts[2] === 'current' && parts[3] && method === 'POST') {
        const live = await currentWithQuiz();
        if (!live) return void json(404, { error: 'Nothing is in progress. Start a quiz.' }), true;
        const { session, quiz } = live;
        const body = await readJsonBody(req);
        // Exam simulation: once the clock has run out, whatever the learner was about to do, the paper is taken in.
        if (practice.timeUp(session) && parts[3] !== 'abandon') {
          close(session, quiz);
          await practiceStore.save(learner);
          return void json(200, { timeUp: true, results: practice.results(session, quiz) }), true;
        }
        switch (parts[3]) {
          case 'answer': practice.answer(session, quiz, body['value'] as never); break;
          case 'next': practice.move(session, 1); break;
          case 'back': practice.move(session, -1); break;
          case 'skip': practice.skip(session); break;
          case 'flag': practice.toggleFlag(session); break;
          case 'reveal': return void json(200, practice.revealForSelfMarking(session, quiz)), true;
          case 'finish': close(session, quiz); await practiceStore.save(learner); return void json(200, practice.results(session, quiz)), true;
          case 'abandon': learner.sessions = learner.sessions.filter((s) => s !== session); break;
          default: return void json(404, { error: 'Not found.' }), true;
        }
        await practiceStore.save(learner);
        return void (await answerView()), true;
      }
      return void json(404, { error: 'Not found.' }), true;
    } catch (error) {
      if (error instanceof PracticeError) return void json(error.status, { error: error.message }), true;
      if (req.destroyed) return true;
      throw error;
    }
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;

    if (await handleClips(req, res, url)) return;
    if (await handlePractice(req, res, url)) return;

    // Settings: where the quizzes, clips and branding are kept. Changing it takes effect the next time the program starts.
    if (url.pathname === '/api/settings') {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      if (!(isHostKey(presentedKey(req)) && hostAllowed(req))) return json(401, { error: 'Use the host link printed when the quiz program started.' });
      const folder = options.libraryFolder;
      if (!folder) return json(404, { error: 'Settings are not available here.' });
      if (req.method === 'GET') return json(200, { libraryDir: folder.dir, source: folder.source, defaultDir: defaultLibraryDir() });
      if (req.method === 'POST') {
        if (folder.source === 'option' || folder.source === 'environment') {
          return json(409, { error: folder.source === 'option' ? 'The folder was set when the program was started (--quizzes), so it cannot be changed here.' : 'The folder is set by PUBQUIZ_HOME, so it cannot be changed here.' });
        }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { libraryDir?: unknown; copy?: unknown };
          if (typeof body.libraryDir !== 'string') return json(400, { error: 'Type the folder to use.' });
          const result = await changeLibraryDir(folder.dir, body.libraryDir, body.copy !== false);
          return json(200, { ok: true, ...result, restart: true });
        } catch (error) {
          if (error instanceof SettingsError) return json(error.status, { error: error.message });
          return json(400, { error: 'That did not work. Check the folder and try again.' });
        }
      }
      return json(405, { error: 'Not allowed.' });
    }

    if (pathname === '/branding.json' || pathname === '/branding/logo') {
      const branding = options.branding;
      if (pathname === '/branding.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', ...PAGE_HEADERS });
        res.end(JSON.stringify(branding ? await branding.info() : { name: '', tagline: '', accent: '#f5b83d', background: '#14161f', showName: true }));
        return;
      }
      const logo = await branding?.logo();
      if (!logo) {
        res.writeHead(404, NOT_FOUND_HEADERS).end('Not found');
        return;
      }
      res.writeHead(200, {
        'content-type': logo.contentType,
        'cache-control': 'public, max-age=3600',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'x-content-type-options': 'nosniff',
      });
      res.end(logo.data);
      return;
    }

    if (options.library) {
      const handled = await handleApi(req, res, url, {
        library: options.library,
        branding: options.branding,
        isHost: (key, req) => isHostKey(key) && hostAllowed(req),
        runQuiz: runLibraryQuiz,
      });
      if (handled) return;
    }

    if (pathname === '/login') {
      await handleLogin(req, res);
      return;
    }

    if (pathname === '/team-photo' && (req.method === 'POST' || req.method === 'DELETE')) {
      await handlePhotoUpload(req, res);
      return;
    }

    if (pathname.startsWith('/team-photo/') && req.method === 'GET') {
      const id = pathname.slice('/team-photo/'.length);
      const photo = active && active.game.photosEnabled && active.game.getTeam(id) ? active.photos.get(id) : undefined;
      if (!photo) {
        res.writeHead(404, NOT_FOUND_HEADERS).end('Not found');
        return;
      }
      res.writeHead(200, {
        'content-type': photo.contentType,
        // The address carries the version, so a changed photo has a new address and this can be kept for good.
        'cache-control': 'public, max-age=31536000, immutable',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      });
      res.end(photo.data);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    // Is a quiz running? The home page uses this to say so, and to carry on by itself once it starts.
    if (pathname === '/status.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...PAGE_HEADERS });
      res.end(JSON.stringify({ running: Boolean(active), title: active?.quiz.title ?? '' }));
      return;
    }

    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', ...PAGE_HEADERS });
      res.end(instanceId);
      return;
    }

    if (pathname === '/wifi-qr.svg') {
      // The Wi-Fi password is in the code, so only the host and TV screens (which show it anyway) may fetch it.
      const key = presentedKey(req);
      if (!options.wifi || !((isHostKey(key) && hostAllowed(req)) || keyIs(screenKey, key))) {
        res.writeHead(404, NOT_FOUND_HEADERS).end('Not found');
        return;
      }
      const svg = await QRCode.toString(wifiQrText(options.wifi.ssid, options.wifi.password), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'content-type': CONTENT_TYPES['.svg'], 'cache-control': 'no-store', ...PAGE_HEADERS });
      res.end(svg);
      return;
    }

    if (pathname === '/results.csv') {
      if (!isHostKey(presentedKey(req)) || !hostAllowed(req) || !active) {
        res.writeHead(404, NOT_FOUND_HEADERS).end('Not found');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${active.quiz.title.replace(/[^\w -]+/g, '').trim() || 'quiz'} results.csv"`,
        'cache-control': 'no-store',
      });
      res.end(toCsv(active.game.resultsTable()));
      return;
    }

    // The host's own link as a QR code, so the host can open the controls on a phone. Host key only.
    if (pathname === '/host-qr.svg') {
      if (!(isHostKey(presentedKey(req)) && hostAllowed(req))) {
        res.writeHead(401, { 'content-type': 'text/plain', ...PAGE_HEADERS });
        res.end('Use the host link.');
        return;
      }
      const base = network.mode === 'tunnel' && network.state === 'up' && network.publicUrl ? network.publicUrl : baseUrl;
      const svg = await QRCode.toString(`${base}/host${options.openHost ? '' : `#key=${hostKey}`}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'content-type': CONTENT_TYPES['.svg'], 'cache-control': 'no-store' });
      res.end(svg);
      return;
    }

    if (pathname === '/qr.svg') {
      res.writeHead(200, { 'content-type': CONTENT_TYPES['.svg'], 'cache-control': 'private, max-age=3600' });
      res.end(qrSvg);
      return;
    }

    if (pathname.startsWith('/media/')) {
      const media = active?.quiz.media.get(pathname.slice('/media/'.length));
      if (!media) {
        res.writeHead(404, NOT_FOUND_HEADERS).end('Not found');
        return;
      }
      const headers = {
        'content-type': media.contentType,
        'cache-control': 'public, max-age=86400',
        'accept-ranges': 'bytes',
        // SVGs can carry scripts; never let one run with this site's permissions.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'x-content-type-options': 'nosniff',
      };
      // Safari only plays audio from a server that answers byte-range requests.
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (range && (range[1] || range[2])) {
        const size = media.data.length;
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
          res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
          return;
        }
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
        res.end(media.data.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { ...headers, 'content-length': media.data.length });
      res.end(media.data);
      return;
    }

    let relativePath: string;
    try {
      relativePath = ROUTES[pathname] ?? decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    const body = await readPublicFile(relativePath);
    if (!body) {
      res.writeHead(404, NOT_FOUND_HEADERS).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(relativePath)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      ...PAGE_HEADERS,
    });
    res.end(body);
  }

  const httpServer = createServer((req, res) => {
    handleHttp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  // A browser sends the page's origin with the upgrade. It must be this server's own address, by whatever name it
  // was reached (localhost, the Wi-Fi address, the internet link), so another website open in the same browser
  // cannot quietly open a connection. Clients that are not browsers send no origin and are judged on their keys.
  const originAllowed = (origin: string | undefined, hostHeader: string | undefined): boolean => {
    if (!origin) return true;
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    const ownHosts = [hostHeader, baseUrl, network.publicUrl].flatMap((value) => {
      if (!value) return [];
      try {
        return [(value.includes('://') ? new URL(value) : new URL(`http://${value}`)).host.toLowerCase()];
      } catch {
        return [];
      }
    });
    return ownHosts.includes(originHost);
  };
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: 4096,
    verifyClient: (info: { origin: string; req: IncomingMessage }) => originAllowed(info.origin || undefined, info.req.headers.host),
  });

  function ping(conn: Connection): void {
    if (conn.pingSentAt !== undefined && ++conn.missedPings >= MAX_MISSED_PINGS) {
      // Phones that sleep often leave sockets half-open; drop them so the team shows as offline.
      conn.ws.terminate();
      return;
    }
    conn.pingSentAt ??= Date.now();
    conn.ws.ping();
  }

  wss.on('error', (error: Error) => console.error(`WebSocket server error: ${error.message}`));
  wss.on('connection', (ws, req) => {
    const address = clientAddress(req);
    // A frame over maxPayload, or a malformed one, makes ws emit 'error' and close the socket (1009). Without a
    // listener that error is uncaught and takes the whole server down, so anyone with the join link could stop a quiz.
    ws.on('error', (error: Error) => console.warn(`Dropped a connection from ${address}: ${error.message}`));
    const open = perAddress.get(address) ?? 0;
    if (open >= MAX_CONNECTIONS_PER_ADDRESS || connections.size >= MAX_CONNECTIONS) {
      ws.close(1013, 'busy');
      return;
    }
    perAddress.set(address, open + 1);
    const conn: Connection = { ws, address, local: isLocalRequest(req), userAgent: String(req.headers['user-agent'] ?? ''), missedPings: 0, rtts: [], messages: new TokenBucket(MESSAGE_BURST, MESSAGES_PER_SECOND), dropped: 0 };
    connections.add(conn);
    ws.on('pong', () => {
      if (conn.pingSentAt === undefined) return;
      conn.rtts = [...conn.rtts, Date.now() - conn.pingSentAt].slice(-RTT_SAMPLES);
      conn.pingSentAt = undefined;
      conn.missedPings = 0;
    });
    ping(conn);
    ws.on('message', (data) => {
      handleMessage(conn, data.toString()).catch((error: Error) => console.error(`Couldn't handle a message: ${error.message}`));
    });
    ws.on('close', () => {
      const left = (perAddress.get(address) ?? 1) - 1;
      if (left > 0) perAddress.set(address, left);
      else perAddress.delete(address);
      connections.delete(conn);
      if (conn.role === 'team' && conn.teamId && teamConnections.get(conn.teamId) === conn) {
        teamConnections.delete(conn.teamId);
        active?.game.disconnect(conn.teamId);
      }
    });
  });

  // Browsers answer WebSocket pings automatically, which gives each team's round-trip time.
  const heartbeat = setInterval(() => {
    for (const conn of connections) ping(conn);
  }, options.pingIntervalMs ?? PING_INTERVAL_MS);

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(options.port ?? 3000, options.bindHost ?? '0.0.0.0', () => resolveListen());
  });

  const port = (httpServer.address() as AddressInfo).port;
  baseUrl = `http://${options.publicHost ?? lanAddress() ?? 'localhost'}:${port}`;
  if (options.quiz) await startQuiz(options.quiz, options.session);
  else await updateJoinUrl();

  let closing: Promise<void> | undefined;
  return {
    get game() {
      return active?.game;
    },
    get roomCode() {
      return active?.roomCode ?? '';
    },
    port,
    get hostKey() {
      return hostKey;
    },
    get screenKey() {
      return screenKey;
    },
    get practiceKey() {
      return practiceKey;
    },
    get hostUrl() {
      // The key rides after the #: browsers keep that part to themselves, so it never reaches a proxy or a log.
      return `http://localhost:${port}/host#key=${hostKey}`;
    },
    get joinUrl() {
      return joinUrl;
    },
    get lanJoinUrl() {
      return lanUrl();
    },
    instanceId,
    startQuiz,
    endQuiz,
    setNetwork(status) {
      network = status;
      void updateJoinUrl().then(broadcast);
    },
    setShortLinks(links) {
      shortLinks = links;
      broadcast();
    },
    close() {
      closing ??= (async () => {
        clearInterval(heartbeat);
        // Stop without telling phones the quiz ended: after a restart they rejoin and carry on.
        active?.game.dispose();
        await active?.saver?.flush();
        await active?.photos.flush();
        await Promise.all([...resultsWrites]);
        for (const conn of connections) conn.ws.terminate();
        await new Promise<void>((done) => wss.close(() => done()));
        await new Promise<void>((done) => httpServer.close(() => done()));
      })();
      return closing;
    },
  };
}
