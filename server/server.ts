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
import type { BrandingStore } from './branding.ts';
import { clientAddress, TokenBucket, WindowCounter } from './limits.ts';
import { MAX_PHOTO_BYTES, PhotoStore, sniffImage } from './photos.ts';
import { lanAddress, wifiQrText } from './net.ts';
import { parseClientMessage, type HostIdleView, type HostView, type ServerMessage } from './protocol.ts';
import { loadQuizFile, QuizError, type Quiz } from './quiz.ts';
import { createSaver, hashQuiz, readSession, writeSession, type Session } from './session.ts';
import type { NetworkStatus } from './tunnel.ts';

const ROUTES: Record<string, string> = { '/': 'play.html', '/host': 'host.html', '/screen': 'screen.html' };
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

/** Sent with every page: the host key lives in the host page's address, so nothing may leak it as a referrer. */
const PAGE_HEADERS = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; " +
    "connect-src 'self' ws: wss:; media-src 'self' https: http:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

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
  /** Name, colours and logo for every page. */
  branding?: BrandingStore;
  /** The Wi-Fi network teams can join, shown as a QR code beside the join code (for a travel router or hotspot). */
  wifi?: { ssid: string; password?: string };
  /** Let teams add a photo (the host can still switch it off). Default on. */
  photos?: boolean;
  /** Turn off the team-name word filter. */
  nameFilter?: boolean;
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
  hostKey: string;
  screenKey: string;
  hostUrl: string;
  /** The link teams use right now: the internet link when it's up, otherwise the local address. */
  readonly joinUrl: string;
  readonly lanJoinUrl: string;
  /** Random per run; /healthz returns it, so a tunnel check knows it reached this server. */
  instanceId: string;
  startQuiz(quiz: Quiz, session?: SessionOptions): Promise<void>;
  endQuiz(): Promise<void>;
  setNetwork(status: NetworkStatus): void;
  close(): Promise<void>;
}

interface Connection {
  ws: WebSocket;
  role?: 'host' | 'team' | 'screen';
  address: string;
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
  const hostKey = options.hostKey ?? options.session?.resume?.hostKey ?? randomBytes(18).toString('base64url');
  const connections = new Set<Connection>();
  const teamConnections = new Map<string, Connection>();
  const instanceId = randomBytes(9).toString('base64url');
  const joinGuesses = new WindowCounter(MAX_JOIN_GUESSES_PER_MINUTE, 60_000);
  const photoUploads = new WindowCounter(5, 60_000);
  const perAddress = new Map<string, number>();
  // Derived from the host key, so a TV left on /screen reconnects after a restart.
  const screenKey = createHmac('sha256', hostKey).update('screen').digest('base64url').slice(0, 24);
  let active: ActiveQuiz | undefined;
  let baseUrl = '';
  let joinUrl = '';
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
    if (!active) return { phase: 'idle', library: Boolean(options.library), network };
    return {
      ...active.game.hostView(),
      roomCode: active.roomCode,
      joinUrl,
      lanJoinUrl: lanUrl(),
      qrVersion,
      network,
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
    return {
      ...view,
      question: view.question && !revealed ? { ...view.question, answerText: '', answer: undefined, info: undefined } : view.question,
      review: revealed ? view.review : undefined,
      // A list of guesses with how far off each was gives the answer away.
      guesses: revealed ? view.guesses : undefined,
      teams: view.teams.map((t) => ({ ...t, code: '' })),
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
      onChange() {
        current.saver?.schedule();
        if (game.phase === 'finished' && session && !current.resultsWritten) {
          current.resultsWritten = true;
          void saveResults(session.path, game);
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

  function handleMessage(conn: Connection, raw: string): void {
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
        if (msg.room.trim().toUpperCase() !== active.roomCode) {
          joinGuesses.add(conn.address);
          return send(conn, { t: 'error', message: 'No quiz with that room code. Check the code on the screen.' });
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
        if (hostOnly()) game?.advance();
        return;

      case 'leaderboard': {
        if (!hostOnly() || !game) return;
        const result = game.showLeaderboard();
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
    if (req.method === 'GET') return json(200, { pin: Boolean(options.hostPin) });
    if (req.method !== 'POST' || !options.hostPin) return json(404, { error: 'Not found.' });

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
    if (typeof pin === 'string' && keyIs(options.hostPin, pin.trim())) {
      failures.delete(address);
      return json(200, { key: hostKey });
    }
    const entry = mine && mine.resetAt > now ? mine : { count: 0, resetAt: now + FAILURE_WINDOW_MS };
    entry.count++;
    failures.set(address, entry);
    totalFailures.count++;
    return json(401, { error: 'Wrong PIN.' });
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;

    if (pathname === '/branding.json' || pathname === '/branding/logo') {
      const branding = options.branding;
      if (pathname === '/branding.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', ...PAGE_HEADERS });
        res.end(JSON.stringify(branding ? await branding.info() : { name: '', tagline: '', accent: '#f5b83d', background: '#14161f', showName: true }));
        return;
      }
      const logo = await branding?.logo();
      if (!logo) {
        res.writeHead(404).end('Not found');
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
        isHost: isHostKey,
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
        res.writeHead(404).end('Not found');
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

    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(instanceId);
      return;
    }

    if (pathname === '/wifi-qr.svg') {
      // The Wi-Fi password is in the code, so only the host and TV screens (which show it anyway) may fetch it.
      const key = url.searchParams.get('key') ?? undefined;
      if (!options.wifi || !(isHostKey(key) || keyIs(screenKey, key))) {
        res.writeHead(404).end('Not found');
        return;
      }
      const svg = await QRCode.toString(wifiQrText(options.wifi.ssid, options.wifi.password), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'content-type': CONTENT_TYPES['.svg'], 'cache-control': 'no-store', ...PAGE_HEADERS });
      res.end(svg);
      return;
    }

    if (pathname === '/results.csv') {
      if (!isHostKey(url.searchParams.get('key') ?? undefined) || !active) {
        res.writeHead(404).end('Not found');
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

    if (pathname === '/qr.svg') {
      res.writeHead(200, { 'content-type': CONTENT_TYPES['.svg'], 'cache-control': 'private, max-age=3600' });
      res.end(qrSvg);
      return;
    }

    if (pathname.startsWith('/media/')) {
      const media = active?.quiz.media.get(pathname.slice('/media/'.length));
      if (!media) {
        res.writeHead(404).end('Not found');
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
      res.writeHead(404).end('Not found');
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
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 4096 });

  function ping(conn: Connection): void {
    if (conn.pingSentAt !== undefined && ++conn.missedPings >= MAX_MISSED_PINGS) {
      // Phones that sleep often leave sockets half-open; drop them so the team shows as offline.
      conn.ws.terminate();
      return;
    }
    conn.pingSentAt ??= Date.now();
    conn.ws.ping();
  }

  wss.on('connection', (ws, req) => {
    const address = clientAddress(req);
    const open = perAddress.get(address) ?? 0;
    if (open >= MAX_CONNECTIONS_PER_ADDRESS || connections.size >= MAX_CONNECTIONS) {
      ws.close(1013, 'busy');
      return;
    }
    perAddress.set(address, open + 1);
    const conn: Connection = { ws, address, missedPings: 0, rtts: [], messages: new TokenBucket(MESSAGE_BURST, MESSAGES_PER_SECOND), dropped: 0 };
    connections.add(conn);
    ws.on('pong', () => {
      if (conn.pingSentAt === undefined) return;
      conn.rtts = [...conn.rtts, Date.now() - conn.pingSentAt].slice(-RTT_SAMPLES);
      conn.pingSentAt = undefined;
      conn.missedPings = 0;
    });
    ping(conn);
    ws.on('message', (data) => handleMessage(conn, data.toString()));
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
    hostKey,
    screenKey,
    hostUrl: `http://localhost:${port}/host?key=${hostKey}`,
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
    close() {
      closing ??= (async () => {
        clearInterval(heartbeat);
        // Stop without telling phones the quiz ended: after a restart they rejoin and carry on.
        active?.game.dispose();
        await active?.saver?.flush();
        await active?.photos.flush();
        for (const conn of connections) conn.ws.terminate();
        await new Promise<void>((done) => wss.close(() => done()));
        await new Promise<void>((done) => httpServer.close(() => done()));
      })();
      return closing;
    },
  };
}
