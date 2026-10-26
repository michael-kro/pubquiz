// How good is the internet connection for a quiz? Measured through the internet link itself, so it covers the path
// every phone uses: the laptop's own connection, out to the tunnel provider and back.

export type SpeedLevel = 'good' | 'ok' | 'weak';

export interface SpeedCheck {
  state: 'checking' | 'done' | 'failed';
  /** Round trip of a small request through the internet link, median of a few, in ms. */
  latencyMs?: number;
  /** Throughput of a download through the internet link, in Mbit/s. */
  mbps?: number;
  level?: SpeedLevel;
  message: string;
  /** When the check finished. */
  at?: string;
}

/** The size of the download that measures throughput. Big enough to get past the slow start of a connection. */
export const SPEED_BYTES = 2_000_000;
/** The most the speed check endpoint hands out in one go. */
export const SPEED_MAX_BYTES = 4_000_000;

// Through the link, a request crosses the laptop's own connection twice each way, so these are roughly double what a
// phone sees. Quiz messages are small: throughput matters for pictures, sent to every phone at once.
const GOOD = { latencyMs: 250, mbps: 10 };
const WEAK = { latencyMs: 600, mbps: 3 };

export function judgeSpeed(latencyMs: number, mbps: number): { level: SpeedLevel; message: string } {
  if (latencyMs > WEAK.latencyMs || mbps < WEAK.mbps) {
    return { level: 'weak', message: 'Weak: phones may lag or drop out, and pictures will be slow. A phone hotspot may do better; check again after switching.' };
  }
  if (latencyMs <= GOOD.latencyMs && mbps >= GOOD.mbps) {
    return { level: 'good', message: 'Good: fast enough for a full room, pictures included.' };
  }
  return { level: 'ok', message: 'OK for a quiz. Pictures may take a moment to appear on phones.' };
}

export interface MeasureOptions {
  /** Sent with the download, so only this server can ask for it. */
  key: string;
  pings?: number;
  bytes?: number;
  /** Stops the download after this long and judges by what arrived. */
  downloadMs?: number;
  fetch?: typeof fetch;
}

/** Measures round trip and throughput to `publicUrl`. Throws if the link does not answer at all. */
export async function measureSpeed(publicUrl: string, options: MeasureOptions): Promise<SpeedCheck> {
  const doFetch = options.fetch ?? fetch;
  const base = publicUrl.replace(/\/+$/, '');
  const ping = async () => {
    const started = performance.now();
    const res = await doFetch(`${base}/healthz`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    await res.arrayBuffer();
    if (!res.ok) throw new Error(`The internet link answered with HTTP ${res.status}.`);
    return performance.now() - started;
  };

  await ping(); // the first one also sets up the connection; it is not counted
  const times: number[] = [];
  for (let i = 0; i < (options.pings ?? 5); i++) times.push(await ping());
  times.sort((a, b) => a - b);
  const latencyMs = Math.round(times[Math.floor(times.length / 2)]!);

  const bytes = options.bytes ?? SPEED_BYTES;
  const limitMs = options.downloadMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limitMs);
  const started = performance.now();
  let received = 0;
  try {
    const res = await doFetch(`${base}/speedcheck?bytes=${bytes}`, { cache: 'no-store', headers: { 'x-speed-key': options.key }, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`The speed check download failed (HTTP ${res.status}).`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
    }
  } catch (error) {
    // Out of time: judge by what arrived. Anything else is a real failure.
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
  }
  const seconds = Math.max(0.001, (performance.now() - started) / 1000);
  const mbps = Math.round(((received * 8) / seconds / 1_000_000) * 10) / 10;
  return { state: 'done', latencyMs, mbps, ...judgeSpeed(latencyMs, mbps), at: new Date().toISOString() };
}
