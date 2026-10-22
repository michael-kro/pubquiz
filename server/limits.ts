// Protection against a few badly behaved clients: message floods, join guessing, odd team names.
import type { IncomingMessage } from 'node:http';
import { networkInterfaces } from 'node:os';

/** Lets `capacity` actions happen at once, then `perSecond` more each second. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly perSecond: number;
  private readonly now: () => number;

  constructor(capacity: number, perSecond: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Counts events per key inside a sliding window, e.g. wrong join attempts per address. */
export class WindowCounter {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length) this.hits.set(key, recent);
    else this.hits.delete(key);
    return recent;
  }

  /** True once `key` has used up its allowance. */
  blocked(key: string): boolean {
    return this.recent(key).length >= this.limit;
  }

  add(key: string): void {
    this.hits.set(key, [...this.recent(key), this.now()]);
  }

  clear(key: string): void {
    this.hits.delete(key);
  }
}

/**
 * True for a host name (with or without a port) that can only be a machine on this network: an address, localhost,
 * a .local / .lan name or a single-word name. A public domain is never local, however it was pointed.
 */
export function looksLocalName(hostWithPort: string): boolean {
  const host = hostWithPort.toLowerCase().replace(/:\d+$/, '');
  if (host.startsWith('[')) return true; // an IPv6 address
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (!host.includes('.')) return true;
  return /\.(localhost|local|lan|home\.arpa|internal)$/.test(host);
}

const LOOPBACK = /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/;

/**
 * Who is really connecting. Through a tunnel every request comes from this laptop itself, with the
 * visitor's address in a header; that header is only believed when the connection is local, so
 * nobody on the network can pretend to be someone else.
 */
/**
 * True when the request comes from the machine running the quiz itself, not through the internet tunnel
 * (which always adds forwarding headers) and not from another device on the network.
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) return false;
  const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (LOOPBACK.test(remote) || LOOPBACK.test(`::ffff:${remote}`)) return true;
  return Object.values(networkInterfaces()).some((list) => list?.some((i) => i.address === remote));
}

export function clientAddress(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (!LOOPBACK.test(remote)) return remote;
  const forwarded = req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first && first.length <= 64 ? first : remote;
}

// Team names

export const MAX_NAME_LENGTH = 24;
/** Control characters, zero-width and direction-changing characters, and the like: they hide or flip text. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}⠀ᅟᅠㅤﾠ]/gu;

// Whole words only after tidying, so ordinary names (Scunthorpe, Essex, Hancock) are never caught.
const BLOCKED_WORDS = new Set([
  'fuck', 'fucker', 'fucking', 'fuckers', 'motherfucker', 'shit', 'shitty', 'bullshit', 'cunt', 'cunts', 'twat', 'twats',
  'wanker', 'wankers', 'bastard', 'bastards', 'bitch', 'bitches', 'dick', 'dicks', 'dickhead', 'cock', 'cocks',
  'piss', 'pissed', 'arse', 'arsehole', 'asshole', 'assholes', 'prick', 'pricks', 'slut', 'sluts', 'whore', 'whores',
  'nazi', 'nazis', 'rapist', 'rapists', 'rape',
]);
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };

function tidyForFilter(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[0134578@$!]/g, (c) => LEET[c] ?? c)
    .replace(/[^a-z]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

/** Tidies a team name and says whether it is allowed. */
export function checkTeamName(raw: string, { filterWords = true }: { filterWords?: boolean } = {}): NameCheck {
  const name = raw.replace(INVISIBLE, '').trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, error: 'Enter a team name.' };
  if ([...name].length > MAX_NAME_LENGTH) return { ok: false, error: `Team names can be at most ${MAX_NAME_LENGTH} characters.` };
  if (filterWords) {
    const words = tidyForFilter(name);
    // Also catch a word split up with spaces or dots, like "s h i t", by checking the joined text of short pieces.
    const spelled = words.length > 2 && words.every((w) => w.length === 1) ? [words.join('')] : [];
    if ([...words, ...spelled].some((w) => BLOCKED_WORDS.has(w))) {
      return { ok: false, error: "Let's keep team names family friendly. Pick another." };
    }
  }
  return { ok: true, name };
}
