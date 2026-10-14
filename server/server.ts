import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { WebSocketServer, type WebSocket } from 'ws';
import { Game, type Team } from './game.ts';
import { createSaver, writeSession, type Session } from './session.ts';
import { lanAddress } from './net.ts';
import { parseClientMessage, type HostView, type ServerMessage } from './protocol.ts';
import type { Quiz } from './quiz.ts';

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

export interface ServerOptions {
  quiz: Quiz;
  port?: number;
  /** Interface to listen on. Defaults to all interfaces so phones can connect. */
  bindHost?: string;
  /** Host name or IP put in the join link. Defaults to the laptop's LAN address. */
  publicHost?: string;
  /** Where to save the quiz as it runs, and optionally a saved session to carry on from. */
  session?: { path: string; quizHash: string; resume?: Session };
  pingIntervalMs?: number;
}

export interface QuizServer {
  game: Game;
  port: number;
  roomCode: string;
  hostKey: string;
  hostUrl: string;
  joinUrl: string;
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

/** Median of recent round trips: steady against the odd slow ping. */
function latencyOf(conn: Connection): number {
  if (conn.rtts.length === 0) return 0;
  const sorted = [...conn.rtts].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export async function createQuizServer(options: ServerOptions): Promise<QuizServer> {
  const resume = options.session?.resume;
  const roomCode = resume?.roomCode ?? Array.from({ length: 4 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');
  const hostKey = resume?.hostKey ?? randomBytes(18).toString('base64url');
  const connections = new Set<Connection>();
  const teamConnections = new Map<string, Connection>();
  let joinUrl = '';
  let qrSvg = '';

  const sessionOptions = options.session;
  const saver = sessionOptions
    ? createSaver(() =>
        writeSession(sessionOptions.path, {
          quizHash: sessionOptions.quizHash,
          roomCode,
          hostKey,
          savedAt: new Date().toISOString(),
          game: game.snapshot(),
        }),
      )
    : undefined;

  let broadcastQueued = false;
  const gameOptions = {
    onChange() {
      saver?.schedule();
      // Several changes in one tick (e.g. last answer closes the question) go out as one update.
      if (broadcastQueued) return;
      broadcastQueued = true;
      queueMicrotask(() => {
        broadcastQueued = false;
        broadcast();
      });
    },
  };
  const game = resume ? Game.restore(options.quiz, resume.game, gameOptions) : new Game(options.quiz, gameOptions);
  saver?.schedule();

  function send(conn: Connection, message: ServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(message));
  }

  function hostView(): HostView {
    return { ...game.hostView(), roomCode, joinUrl };
  }

  function sendState(conn: Connection): void {
    if (conn.role === 'host') {
      send(conn, { t: 'state', view: hostView() });
    } else if (conn.role === 'team' && conn.teamId) {
      const view = game.teamView(conn.teamId);
      if (view) send(conn, { t: 'state', view });
    }
  }

  function broadcast(): void {
    for (const conn of connections) sendState(conn);
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

  function keyMatches(key: string): boolean {
    const a = Buffer.from(key);
    const b = Buffer.from(hostKey);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function handleMessage(conn: Connection, raw: string): void {
    const msg = parseClientMessage(raw);
    if (!msg) return send(conn, { t: 'error', message: 'Unrecognised message.' });

    switch (msg.t) {
      case 'host':
        if (!keyMatches(msg.key)) {
          send(conn, { t: 'error', message: 'Wrong host key. Use the host link printed when the quiz started.' });
          conn.ws.close(4001, 'bad key');
          return;
        }
        conn.role = 'host';
        sendState(conn);
        return;

      case 'join': {
        if (conn.role) return send(conn, { t: 'error', message: 'Already joined.' });
        if (msg.room.trim().toUpperCase() !== roomCode) {
          return send(conn, { t: 'error', message: 'No quiz with that room code. Check the code on the screen.' });
        }
        const result = game.join(msg.name);
        if (!result.ok) return send(conn, { t: 'error', message: result.error });
        attachTeam(conn, result.value);
        return;
      }

      case 'rejoin': {
        if (conn.role) return send(conn, { t: 'error', message: 'Already joined.' });
        const team = game.rejoin(msg.token);
        if (!team) return send(conn, { t: 'rejoin-failed' });
        attachTeam(conn, team);
        return;
      }

      case 'answer': {
        if (conn.role !== 'team' || !conn.teamId) return send(conn, { t: 'error', message: 'Join a team first.' });
        const result = game.answer(conn.teamId, msg.value, latencyOf(conn));
        if (!result.ok) send(conn, { t: 'error', message: result.error });
        return;
      }

      case 'mark': {
        if (conn.role !== 'host') return send(conn, { t: 'error', message: 'Only the host can do that.' });
        const result = game.mark(msg.key, msg.correct);
        if (!result.ok) send(conn, { t: 'error', message: result.error });
        return;
      }

      case 'advance':
        if (conn.role !== 'host') return send(conn, { t: 'error', message: 'Only the host can do that.' });
        game.advance();
        return;

      case 'kick': {
        if (conn.role !== 'host') return send(conn, { t: 'error', message: 'Only the host can do that.' });
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
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');

    if (pathname === '/qr.svg') {
      res.writeHead(200, { 'content-type': CONTENT_TYPES['.svg'], 'cache-control': 'private, max-age=3600' });
      res.end(qrSvg);
      return;
    }

    if (pathname.startsWith('/media/')) {
      const media = options.quiz.media.get(pathname.slice('/media/'.length));
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
    handleHttp(req, res).catch(() => res.writeHead(500).end());
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
        game.disconnect(conn.teamId);
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
  let closing: Promise<void> | undefined;
  const publicHost = options.publicHost ?? lanAddress() ?? 'localhost';
  joinUrl = `http://${publicHost}:${port}/?room=${roomCode}`;
  qrSvg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });

  return {
    game,
    port,
    roomCode,
    hostKey,
    hostUrl: `http://localhost:${port}/host?key=${hostKey}`,
    joinUrl,
    close() {
      closing ??= (async () => {
        clearInterval(heartbeat);
        game.dispose();
        await saver?.flush();
        for (const conn of connections) conn.ws.terminate();
        await new Promise<void>((done) => wss.close(() => done()));
        await new Promise<void>((done) => httpServer.close(() => done()));
      })();
      return closing;
    },
  };
}
