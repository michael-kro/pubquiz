// Gives the quiz a public https:// address, so phones can join over 4G or any Wi-Fi.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { appHome } from './settings.ts';
import type { SpeedCheck } from './speedcheck.ts';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

export type TunnelState = 'starting' | 'up' | 'down';

export interface NetworkStatus {
  /** 'local': no internet link at all (tests, and before the first one is set up). Teams cannot join on 'local' outside the laptop itself. */
  mode: 'local' | 'tunnel';
  state?: TunnelState;
  provider?: string;
  /** The public https:// address, once the tunnel is up. */
  publicUrl?: string;
  /** Shown to the host when something is wrong. */
  message?: string;
  /** The link was closed by the "close by itself" setting, so it stays down until the host opens a new one. */
  closedByTimer?: boolean;
  /** When the link will be closed by itself, if that is set. */
  expiresAt?: string;
  /** The setting behind it: hours after opening (0: never), as the host can change it on the host screen. */
  maxHours?: number;
  /** The last check of the connection's speed through this link, if there was one. */
  speed?: SpeedCheck;
}

export interface RunningTunnel {
  url: string;
  stop(): void;
}

export interface TunnelProvider {
  name: string;
  /** Starts a tunnel to the local port. `onExit` is called if it dies later. */
  start(port: number, onExit: (reason: string) => void): Promise<RunningTunnel>;
}

// cloudflared: free "quick tunnels", no account needed.

const CLOUDFLARED_VERSION = '2026.10.4';
// SHA-256 of each release file, from GitHub's release metadata. The Linux and Windows ones match the release notes;
// the notes' macOS values never match the published .tgz files, in this release or earlier ones.
// Moving to a newer release: take it as soon as it fixes a vulnerability, check the image scan passes, and release.
const CLOUDFLARED_FILES: Record<string, { file: string; sha256: string }> = {
  'darwin-arm64': {
    file: 'cloudflared-darwin-arm64.tgz',
    sha256: '68b6bc4080ac1330234db2a9002d07f98b000537a1bd531a687b660d4160fa7f',
  },
  'darwin-x64': {
    file: 'cloudflared-darwin-amd64.tgz',
    sha256: 'f11fbef4207d715892331917dafd437f032cf4b7137ed64dea3008338c1c613d',
  },
  'linux-x64': {
    file: 'cloudflared-linux-amd64',
    sha256: 'ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42',
  },
  'linux-arm64': {
    file: 'cloudflared-linux-arm64',
    sha256: '2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6',
  },
  'win32-x64': {
    file: 'cloudflared-windows-amd64.exe',
    sha256: '411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8',
  },
};

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const START_TIMEOUT_MS = 45_000;

function onPath(command: string): boolean {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

/**
 * Finds cloudflared: one already installed, one downloaded earlier, or downloads it now.
 * Downloads are checked against a pinned SHA-256 before anything is run.
 */
export async function ensureCloudflared(log: (message: string) => void = () => {}): Promise<string> {
  if (onPath('cloudflared')) return 'cloudflared';

  const release = CLOUDFLARED_FILES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error(`No cloudflared download for ${process.platform}-${process.arch}. Install cloudflared yourself.`);

  const binDir = join(appHome(), 'bin');
  const binary = join(binDir, `cloudflared-${CLOUDFLARED_VERSION}${process.platform === 'win32' ? '.exe' : ''}`);
  if (await stat(binary).then(() => true, () => false)) return binary;

  log(`Downloading cloudflared ${CLOUDFLARED_VERSION} (one-off, about 20–50 MB)…`);
  await installCloudflared(binary);
  log('cloudflared is ready.');
  return binary;
}

/**
 * Downloads this platform's cloudflared to `binary`, checked against its pinned SHA-256 first.
 * The Docker image calls this at build time, so a container never downloads it on the night.
 */
export async function installCloudflared(binary: string): Promise<void> {
  const release = CLOUDFLARED_FILES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error(`No cloudflared download for ${process.platform}-${process.arch}. Install cloudflared yourself.`);
  const binDir = dirname(binary);
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${release.file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't download cloudflared (HTTP ${response.status}).`);
  const data = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(data).digest('hex');
  if (digest !== release.sha256) throw new Error('The cloudflared download failed its checksum check, so it was not used.');

  await mkdir(binDir, { recursive: true });
  // Unpack in a fresh, empty folder next to the destination (so the final move can't cross drives),
  // then move just the binary into place.
  const work = await mkdtemp(join(binDir, '.download-'));
  try {
    const downloaded = join(work, release.file);
    await writeFile(downloaded, data);
    let extracted = downloaded;
    if (release.file.endsWith('.tgz')) {
      const unpacked = join(work, 'unpacked');
      await mkdir(unpacked);
      const tar = spawnSync('tar', ['-xzf', downloaded, '-C', unpacked, 'cloudflared']);
      if (tar.status !== 0) throw new Error(`Couldn't unpack cloudflared: ${tar.stderr.toString()}`);
      extracted = join(unpacked, 'cloudflared');
    }
    await chmod(extracted, 0o755);
    await rename(extracted, binary);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Runs a tunnel process and resolves once `parse` finds its public URL in the output. */
function startProcess(
  command: string,
  args: string[],
  parse: (line: string, found: (url: string) => void) => void,
  onExit: (reason: string) => void,
): Promise<RunningTunnel> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let url: string | undefined;
    let stopped = false;
    const recent: string[] = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`No public address after ${START_TIMEOUT_MS / 1000} seconds. Is the laptop online?`));
    }, START_TIMEOUT_MS);

    const found = (publicUrl: string) => {
      if (url) return;
      url = publicUrl;
      clearTimeout(timeout);
      resolve({
        url,
        stop() {
          stopped = true;
          child.kill();
        },
      });
    };

    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream! }).on('line', (line) => {
        recent.push(line);
        if (recent.length > 5) recent.shift();
        parse(line, found);
      });
    }
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      const reason = `${command} stopped (exit code ${code}). ${recent.at(-1) ?? ''}`.trim();
      if (!url) reject(new Error(reason));
      else if (!stopped) onExit(reason);
    });
  });
}

export function cloudflaredProvider(binary: string): TunnelProvider {
  return {
    name: 'Cloudflare',
    start(port, onExit) {
      return startProcess(
        binary,
        ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
        (line, found) => {
          const match = QUICK_TUNNEL_URL.exec(line);
          if (match && !match[0].startsWith('https://api.')) found(match[0]);
        },
        onExit,
      );
    },
  };
}

/** ngrok, for hosts who already have an ngrok account set up. */
export function ngrokProvider(): TunnelProvider {
  return {
    name: 'ngrok',
    start(port, onExit) {
      return startProcess(
        'ngrok',
        ['http', String(port), '--log', 'stdout', '--log-format', 'json'],
        (line, found) => {
          try {
            const entry = JSON.parse(line) as { url?: string };
            if (entry.url?.startsWith('https://')) found(entry.url);
          } catch {
            // Not a JSON log line.
          }
        },
        onExit,
      );
    },
  };
}

export interface TunnelManagerOptions {
  provider: TunnelProvider | (() => Promise<TunnelProvider>);
  port: number;
  /** Fetches /healthz through the public URL; true when it reached this server. */
  check: (publicUrl: string) => Promise<boolean>;
  onStatus: (status: NetworkStatus) => void;
  healthIntervalMs?: number;
  retryDelaysMs?: number[];
  /** Waits this long before the first reachability check, so phones and laptop don't cache a "no such name" answer. */
  firstCheckDelayMs?: number;
  /** How often to check while waiting for a new tunnel to become reachable. */
  startCheckIntervalMs?: number;
  /** Gives up on a tunnel that never becomes reachable, and starts a new one. */
  reachTimeoutMs?: number;
  /** Closes the link by itself this long after start() (a quiz night does not need it open till morning). */
  maxUptimeMs?: number;
  /** Called once the link has been closed for that reason, so the host can be told and offered a new one. */
  onExpire?: () => void;
}

/**
 * Keeps a tunnel running: restarts it if the process dies or the public address stops
 * reaching this server, and reports each change so the host can see it.
 */
export class TunnelManager {
  private readonly options: TunnelManagerOptions;
  private tunnel: RunningTunnel | undefined;
  private providerName = 'tunnel';
  private healthTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;
  /** When the link is due to close by itself: set at start(), kept across restarts within that window. */
  private expiresAt: number | undefined;
  private windowStartedAt = 0;
  /** The link that is up right now, so a changed limit can be re-reported and rescheduled. */
  private up: { url: string; current: () => boolean } | undefined;
  private attempt = 0;
  private generation = 0;
  private active = false;

  constructor(options: TunnelManagerOptions) {
    this.options = options;
    if (typeof options.provider !== 'function') this.providerName = options.provider.name;
  }

  start(): void {
    this.stop();
    this.active = true;
    this.attempt = 0;
    this.windowStartedAt = Date.now();
    this.expiresAt = this.options.maxUptimeMs ? this.windowStartedAt + this.options.maxUptimeMs : undefined;
    void this.connect();
  }

  stop(): void {
    this.active = false;
    this.generation++;
    clearInterval(this.healthTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.expiryTimer);
    this.tunnel?.stop();
    this.tunnel = undefined;
    this.up = undefined;
  }

  /** Once the link is up, arranges for it to close when its time is up. */
  private scheduleExpiry(current: () => boolean): void {
    clearTimeout(this.expiryTimer);
    if (this.expiresAt === undefined) return;
    this.expiryTimer = setTimeout(() => {
      if (!current()) return;
      this.stop();
      this.options.onExpire?.();
    }, Math.max(0, this.expiresAt - Date.now()));
    this.expiryTimer.unref();
  }

  /**
   * Changes how long a link may stay open, from the host screen. The window still counts from when this link was
   * opened; a link already past the new limit closes straight away. With no limit, a scheduled close is cancelled.
   */
  setMaxUptime(ms: number | undefined): void {
    this.options.maxUptimeMs = ms;
    if (!this.active) return;
    this.expiresAt = ms ? this.windowStartedAt + ms : undefined;
    if (this.up) {
      this.report({ state: 'up', publicUrl: this.up.url, ...(this.expiresAt ? { expiresAt: new Date(this.expiresAt).toISOString() } : {}) });
      this.scheduleExpiry(this.up.current);
    }
  }

  private report(status: Omit<NetworkStatus, 'mode' | 'provider'>): void {
    this.options.onStatus({ mode: 'tunnel', provider: this.providerName, ...status });
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const current = () => this.active && generation === this.generation;
    this.report({ state: 'starting' });
    try {
      const provider =
        typeof this.options.provider === 'function' ? await this.options.provider() : this.options.provider;
      if (!current()) return;
      if (provider.name !== this.providerName) {
        this.providerName = provider.name;
        this.report({ state: 'starting' });
      }
      const tunnel = await provider.start(this.options.port, (reason) => {
        if (current()) this.retry(reason);
      });
      if (!current()) {
        tunnel.stop();
        return;
      }
      this.tunnel = tunnel;
      // Only hand out the address once it really reaches this laptop: a phone that looks up a brand-new
      // name too early can remember "no such site" for a minute or more.
      this.report({ state: 'starting', message: 'Checking the internet link works…' });
      if (!(await this.waitUntilReachable(tunnel.url, current))) {
        if (current()) this.retry("The internet link didn't become reachable.");
        return;
      }
      this.attempt = 0;
      this.up = { url: tunnel.url, current };
      this.report({ state: 'up', publicUrl: tunnel.url, ...(this.expiresAt ? { expiresAt: new Date(this.expiresAt).toISOString() } : {}) });
      this.watchHealth(tunnel.url, current);
      this.scheduleExpiry(current);
    } catch (error) {
      if (current()) this.retry((error as Error).message);
    }
  }

  private async waitUntilReachable(url: string, current: () => boolean): Promise<boolean> {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref());
    const deadline = Date.now() + (this.options.reachTimeoutMs ?? 90_000);
    await sleep(this.options.firstCheckDelayMs ?? 5_000);
    while (current() && Date.now() < deadline) {
      if (await this.options.check(url).catch(() => false)) return current();
      await sleep(this.options.startCheckIntervalMs ?? 3_000);
    }
    return false;
  }

  /** Checks the public address regularly; two failures in a row means it's gone. */
  private watchHealth(url: string, current: () => boolean): void {
    let failures = 0;
    clearInterval(this.healthTimer);
    this.healthTimer = setInterval(async () => {
      const ok = await this.options.check(url).catch(() => false);
      if (!current()) return;
      if (ok) {
        failures = 0;
      } else if (++failures >= 2) {
        this.retry('The internet link stopped reaching this laptop.');
      }
    }, this.options.healthIntervalMs ?? 15_000);
    this.healthTimer.unref();
  }

  private retry(reason: string): void {
    clearInterval(this.healthTimer);
    this.tunnel?.stop();
    this.tunnel = undefined;
    this.up = undefined;
    const delays = this.options.retryDelaysMs ?? [2_000, 5_000, 10_000, 30_000];
    const delay = delays[Math.min(this.attempt++, delays.length - 1)]!;
    this.report({ state: 'down', message: `${reason} Retrying in ${Math.round(delay / 1000)} s.` });
    const generation = this.generation;
    this.retryTimer = setTimeout(() => {
      if (this.active && generation === this.generation) void this.connect();
    }, delay);
    this.retryTimer.unref();
  }
}
