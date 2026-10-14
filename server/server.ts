import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleApi } from './api.ts';
import { Game, type Team } from './game.ts';
import type { Library } from './library.ts';
import { lanAddress } from './net.ts';
import { parseClientMessage, type HostIdleView, type HostView, type ServerMessage } from './protocol.ts';
import { loadQuizFile, QuizError, type Quiz } from './quiz.ts';
import { createSaver, hashQuiz, readSession, writeSession, type Session } from './session.ts';
import type { NetworkStatus } from './tunnel.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const ROUTES: Record<string, string> = { '/': 'play.html', '/host': 'host.html' };
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
  role?: 'host' | 'team';
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
    };
  }

  function sendState(conn: Connection): void {
    if (conn.role === 'host') {
      send(conn, { t: 'state', view: hostView() });
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
    releaseTeams();
    await updateJoinUrl();
    broadcast();
  }

  async function startQuiz(quiz: Quiz, session?: SessionOptions): Promise<void> {
    await endQuiz();
    const resume = session?.resume;
    const roomCode = resume?.roomCode ?? newRoomCode();
    const gameOptions = {
      onChange() {
        current.saver?.schedule();
        scheduleBroadcast();
      },
    };
    const game = resume ? Game.restore(quiz, resume.game, gameOptions) : new Game(quiz, gameOptions);
    const current: ActiveQuiz = { quiz, game, roomCode };
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

  function isHostKey(key: string | undefined): boolean {
    if (key === undefined) return false;
    const a = Buffer.from(key);
    const b = Buffer.from(hostKey);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function handleMessage(conn: Connection, raw: string): void {
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

      case 'join': {
        if (conn.role) return send(conn, { t: 'error', message: 'Already joined.' });
        if (!active || !game) return send(conn, { t: 'error', message: 'No quiz is running right now. Ask the quiz master.' });
        if (msg.room.trim().toUpperCase() !== active.roomCode) {
          return send(conn, { t: 'error', message: 'No quiz with that room code. Check the code on the screen.' });
        }
        const result = game.join(msg.name);
        if (!result.ok) return send(conn, { t: 'error', message: result.error });
        attachTeam(conn, result.value);
        return;
      }

      case 'rejoin': {
        if (conn.role) return send(conn, { t: 'error', message: 'Already joined.' });
        const team = game?.rejoin({ token: msg.token, code: msg.code });
        if (!team) return send(conn, { t: 'rejoin-failed' });
        attachTeam(conn, team);
        return;
      }

      case 'answer': {
        if (conn.role !== 'team' || !conn.teamId || !game) return send(conn, { t: 'error', message: 'Join a team first.' });
        const result = game.answer(conn.teamId, msg.value, latencyOf(conn));
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

      case 'end-quiz':
        if (!hostOnly()) return;
        if (!options.library) return send(conn, { t: 'error', message: 'Restart the program to run another quiz.' });
        void endQuiz();
        return;

      case 'network':
        if (hostOnly()) options.onNetworkAction?.(msg.action);
        return;

      case 'kick': {
        if (!hostOnly() || !game) return;
        const teamConn = teamConnections.get(msg.teamId);
        teamConnections.delete(msg.teamId);
        game.kick(msg.teamId);
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

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;

    if (options.library) {
      const handled = await handleApi(req, res, url, {
        library: options.library,
        isHost: isHostKey,
        runQuiz: runLibraryQuiz,
      });
      if (handled) return;
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
      res.writeHead(200, {
        'content-type': media.contentType,
        'cache-control': 'public, max-age=86400',
        // SVGs can carry scripts; never let one run with this site's permissions.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'x-content-type-options': 'nosniff',
      });
      res.end(media.data);
      return;
    }

    const file = resolve(PUBLIC_DIR, ROUTES[pathname] ?? `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
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

  wss.on('connection', (ws) => {
    const conn: Connection = { ws, missedPings: 0, rtts: [] };
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
        for (const conn of connections) conn.ws.terminate();
        await new Promise<void>((done) => wss.close(() => done()));
        await new Promise<void>((done) => httpServer.close(() => done()));
      })();
      return closing;
    },
  };
}
