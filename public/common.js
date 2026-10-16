// Shared helpers for the team and host pages. No framework, no build step.

/** Creates an element. Children are added as text, never parsed as HTML, so team names can't inject markup. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
/** 2320 ms becomes "2.32 s". */
export const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;
export const LETTER_GROUPS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'R', 'S', 'T', 'U', 'QV', 'W', 'Y', 'XZ'];

export function ordinal(n) {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** WebSocket that reconnects with backoff, and straight away when a phone wakes up. */
export function connectSocket({ onOpen, onMessage, onStatus }) {
  let ws;
  let attempt = 0;
  let retryTimer;
  let stopped = false;
  let connectTimer;

  function open() {
    clearTimeout(retryTimer);
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);
    // On patchy mobile data a connection attempt can hang; give up and try again.
    const attemptSocket = ws;
    connectTimer = setTimeout(() => {
      if (attemptSocket.readyState === WebSocket.CONNECTING) attemptSocket.close();
    }, 10_000);
    ws.onopen = () => {
      clearTimeout(connectTimer);
      attempt = 0;
      onStatus?.(true);
      onOpen?.();
    };
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      onMessage(message);
    };
    ws.onclose = () => {
      clearTimeout(connectTimer);
      if (attemptSocket !== ws) return;
      onStatus?.(false);
      if (stopped) return;
      retryTimer = setTimeout(open, Math.min(5000, 500 * 2 ** attempt++));
    };
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !stopped && ws.readyState === WebSocket.CLOSED) {
      attempt = 0;
      open();
    }
  });

  open();
  return {
    send(message) {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(message));
      return true;
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      ws.close();
    },
  };
}

// The break screen: a countdown and fun facts that rotate, kept in step on every screen by the server's elapsed time.

const FACT_SECONDS = 14;
let breakInfo = null;
let shownFact = -1;

export function setBreak(info) {
  if (!info) {
    breakInfo = null;
    return;
  }
  const changedBreak = !breakInfo || breakInfo.facts !== info.facts;
  breakInfo = { ...info, at: performance.now() };
  if (changedBreak) shownFact = -1;
}

export function breakPanel(big = false) {
  return h(
    'div',
    { class: `break-panel${big ? ' big' : ''}` },
    h('p', { class: 'break-title' }, '☕ Break time'),
    h('p', { class: 'break-countdown', 'data-break-countdown': true }),
    breakInfo?.facts?.length
      ? h('div', { class: 'break-fact-card' }, h('p', { class: 'break-kicker' }, 'Did you know?'), h('p', { class: 'break-fact', 'data-break-fact': true }))
      : null,
  );
}

/** Updates the break countdown and the fact on show. Called with the other countdowns, several times a second. */
function tickBreak() {
  if (!breakInfo) return;
  const elapsed = breakInfo.elapsedMs + (performance.now() - breakInfo.at);
  for (const el of document.querySelectorAll('[data-break-countdown]')) {
    if (breakInfo.remainingMs === undefined) {
      el.textContent = '';
      continue;
    }
    const left = Math.max(0, breakInfo.remainingMs - (performance.now() - breakInfo.at));
    const seconds = Math.ceil(left / 1000);
    el.textContent = left <= 0 ? 'Back any moment…' : `Back in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  const facts = breakInfo.facts;
  if (!facts?.length) return;
  const index = Math.floor(elapsed / (FACT_SECONDS * 1000)) % facts.length;
  for (const el of document.querySelectorAll('[data-break-fact]')) {
    if (el.dataset.index === String(index)) continue;
    el.dataset.index = String(index);
    el.textContent = facts[index];
    // Restart the fade-in each time the fact changes.
    el.classList.remove('fact-in');
    void el.offsetWidth;
    el.classList.add('fact-in');
  }
}

const preloaded = new Set();

/** Fetches an image ahead of time so it appears instantly when its question opens. */
export function preload(url) {
  if (!url || preloaded.has(url)) return;
  preloaded.add(url);
  new Image().src = url;
}

// Countdown: elements with data-countdown show the seconds left until the current deadline.
let deadline = null;

let frozenMs = null; // While the host has the clock paused.

export function setDeadline(remainingMs, paused = false) {
  deadline = remainingMs == null ? null : performance.now() + remainingMs;
  frozenMs = paused ? remainingMs : null;
}

/** Call after rendering so new countdown elements show the time straight away. */
export function tick() {
  tickBreak();
  const left = frozenMs ?? (deadline == null ? 0 : deadline - performance.now());
  const seconds = Math.max(0, Math.ceil(left / 1000));
  for (const el of document.querySelectorAll('[data-countdown]')) {
    el.textContent = String(seconds);
    el.classList.toggle('urgent', seconds <= 5 && frozenMs === null);
    el.classList.toggle('frozen', frozenMs !== null);
  }
}

setInterval(tick, 200);

// Team photos

const AVATAR_COLOURS = ['#e2574c', '#3a86e0', '#e2a23b', '#3bb273', '#8e5bd4', '#d4559b', '#2aa6b8', '#7c8a3a'];

/** A round picture for a team: its photo, or its initials on a colour taken from its name. */
export function avatar(name, photo, size = 36) {
  const el = h('span', { class: 'avatar', style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px` });
  if (photo) {
    el.append(h('img', { src: photo, alt: '', loading: 'lazy', draggable: 'false' }));
  } else {
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    el.style.background = AVATAR_COLOURS[hash % AVATAR_COLOURS.length];
    el.append([...name.trim()].slice(0, 2).join('').toUpperCase() || '?');
  }
  return el;
}

const PHOTO_SIDE = 256;

/** Crops a picture to a square and shrinks it, so uploads are small and fast on mobile data. Returns a JPEG blob. */
export async function prepareTeamPhoto(file) {
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo.');
  // "from-image" applies the camera's rotation, so portrait photos aren't sideways.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PHOTO_SIDE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, PHOTO_SIDE, PHOTO_SIDE);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PHOTO_SIDE, PHOTO_SIDE);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  if (!blob) throw new Error("Couldn't read that photo.");
  return blob;
}

// Branding: a name, tagline, logo and two colours, from /branding.json.

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, amount) => rgbToHex(hexToRgb(a).map((v, i) => v + (hexToRgb(b)[i] - v) * amount));

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Works out every colour the pages use from the two chosen ones, so text stays readable on any pair. */
export function paletteFor(background, accent) {
  const dark = luminance(background) < 0.4;
  const text = dark ? '#f4f1ea' : '#1b1d26';
  const accentText = contrast(accent, '#1a1406') >= contrast(accent, '#ffffff') ? '#1a1406' : '#ffffff';
  return {
    '--bg': background,
    '--surface': mix(background, dark ? '#ffffff' : '#000000', dark ? 0.07 : 0.05),
    '--surface-2': mix(background, dark ? '#ffffff' : '#000000', dark ? 0.15 : 0.1),
    '--text': text,
    '--muted': mix(text, background, 0.38),
    '--accent': accent,
    '--accent-text': accentText,
    colorScheme: dark ? 'dark' : 'light',
  };
}

export function applyPalette(background, accent) {
  const palette = paletteFor(background, accent);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(palette)) {
    if (name.startsWith('--')) root.style.setProperty(name, value);
  }
  root.style.colorScheme = palette.colorScheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
}

let branding = { name: '', tagline: '', accent: '#f5b83d', background: '#14161f', showName: true };

/** Loads and applies the branding. Never fails: a missing or slow answer just means the default look. */
export async function loadBranding() {
  try {
    const res = await fetch('/branding.json', { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      const info = await res.json();
      if (/^#[0-9a-f]{6}$/i.test(info.accent) && /^#[0-9a-f]{6}$/i.test(info.background)) {
        branding = info;
        applyPalette(info.background, info.accent);
      }
    }
  } catch {
    // The default look is fine.
  }
  return branding;
}

export const getBranding = () => branding;

/** Switches to new branding straight away (after the host edits it). */
export function setBranding(info) {
  branding = info;
  applyPalette(info.background, info.accent);
  document.title = info.name || document.title;
}

/** The logo as an image, or nothing when there isn't one. */
export function brandLogo(className = 'brand-logo') {
  return branding.logo ? h('img', { class: className, src: branding.logo, alt: branding.name ? `${branding.name} logo` : 'Logo' }) : null;
}

/** Logo, name and tagline stacked, for the start and end screens. */
export function brandBlock() {
  const { name, tagline } = branding;
  if (!branding.logo && !name && !tagline) return null;
  return h(
    'div',
    { class: 'brand-block' },
    brandLogo('brand-logo big'),
    name && branding.showName !== false ? h('p', { class: 'brand-name' }, name) : null,
    tagline ? h('p', { class: 'brand-tagline' }, tagline) : null,
  );
}

/** A short burst of confetti, skipped for people who prefer less motion. */
export function confetti(count = 36) {
  try {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch {
    return;
  }
  const colours = ['#ffd23f', '#3bceac', '#ee6352', '#59a5d8', '#f78fb3'];
  const layer = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  for (let i = 0; i < count; i++) {
    layer.append(h('i', { style: `left:${Math.random() * 100}%;background:${colours[i % colours.length]};animation-duration:${1.6 + Math.random() * 1.4}s;animation-delay:${Math.random() * 0.4}s` }));
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 3500);
}

let lastFlashKey = '';

/** On the reveal, flashes the photo (or initials) of the team with the quickest right answer, once per question. */
export function flashSpeedster(state, big = false) {
  if (state.phase !== 'reveal' || !state.speedster || !state.question) return;
  const key = `${state.quizTitle}:${state.question.index}`;
  if (key === lastFlashKey) return;
  lastFlashKey = key;
  const { name, photo, ms } = state.speedster;
  const overlay = h(
    'div',
    { class: `speedster${big ? ' big' : ''}`, role: 'status', onclick: () => overlay.remove() },
    h('div', { class: 'speedster-card' }, h('p', { class: 'speedster-kicker' }, '⚡ Fastest right answer'), avatar(name, photo, big ? 320 : 200), h('p', { class: 'speedster-name' }, name), h('p', { class: 'speedster-time' }, seconds(ms))),
  );
  document.body.append(overlay);
  setTimeout(() => overlay.classList.add('out'), 3200);
  setTimeout(() => overlay.remove(), 3700);
}

export const MEDALS = ['🥇', '🥈', '🥉'];

/** The prizes for 1st, 2nd and 3rd as a short list; nothing at all if none were set. */
export function prizeList(prizes, big = false) {
  const rows = (prizes ?? []).map((text, i) => (text ? h('li', {}, h('span', { class: 'prize-medal' }, MEDALS[i]), h('span', { class: 'prize-text' }, text)) : null)).filter(Boolean);
  if (rows.length === 0) return null;
  return h('div', { class: `prizes${big ? ' big' : ''}` }, h('p', { class: 'prizes-title' }, 'Prizes'), h('ul', {}, rows));
}

/** "+950" and an arrow for how far a team moved. */
export function movement(row) {
  const parts = [];
  if (row.gained) parts.push(h('span', { class: row.gained < 0 ? 'gained lost' : 'gained' }, row.gained > 0 ? `+${row.gained}` : String(row.gained)));
  if (row.moved) {
    parts.push(
      h(
        'span',
        { class: row.moved > 0 ? 'up' : 'down', 'aria-label': `${row.moved > 0 ? 'up' : 'down'} ${Math.abs(row.moved)}` },
        `${row.moved > 0 ? '▲' : '▼'}${Math.abs(row.moved)}`,
      ),
    );
  }
  return h('span', { class: 'movement' }, parts);
}

// A leaderboard that rolls in from the bottom: last place first, climbing to the top, each score counting up.
const ROLL_STEP_MS = 140;
const ROLL_COUNT_MS = 900;
let rollKey = '';
let rollStart = 0;
let rollFrame = 0;
let rollDone;

function finishRoll() {
  cancelAnimationFrame(rollFrame);
  for (const el of document.querySelectorAll('.standings .score[data-to]')) el.textContent = el.dataset.to;
  document.querySelector('.standings.rolling')?.classList.remove('rolling');
}

/** Counts each score up from what it was to what it is, as its row arrives. */
function rollTick() {
  const scores = document.querySelectorAll('.standings.rolling .score[data-from]');
  let running = false;
  const now = performance.now() - rollStart;
  for (const el of scores) {
    if (el.dataset.from === '') continue;
    const from = Number(el.dataset.from);
    const to = Number(el.dataset.to);
    const t = Math.min(1, Math.max(0, (now - Number(el.dataset.start)) / ROLL_COUNT_MS));
    el.textContent = String(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
    if (t < 1) running = true;
  }
  if (running || now < scores.length * ROLL_STEP_MS + ROLL_COUNT_MS) rollFrame = requestAnimationFrame(rollTick);
}

/**
 * The standings list. It rolls in once each time `key` changes (a redraw part way through carries on where it was),
 * and is skipped for people who prefer less motion. `cells(row, scoreElement)` builds what goes in each row.
 */
export function rollStandings(rows, { key, className = '', columns = () => 1, rowClass = () => '', cells }) {
  if (key !== rollKey) {
    rollKey = key;
    rollStart = performance.now();
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const elapsed = performance.now() - rollStart;
  const total = rows.length * ROLL_STEP_MS + ROLL_COUNT_MS + 600;
  const animate = !reduced && elapsed < total;
  const cols = columns(rows.length);
  const list = h(
    'ol',
    { class: `standings ${className}${animate ? ' rolling' : ''}`, style: `--rows: ${Math.ceil(rows.length / cols)}; --cols: ${cols}` },
    rows.map((row, i) => {
      const order = rows.length - 1 - i; // the last row appears first
      const from = row.gained ? row.score - row.gained : row.score;
      const score = h('span', { class: 'score', 'data-from': animate ? String(from) : '', 'data-to': String(row.score), 'data-start': String(order * ROLL_STEP_MS) }, animate ? String(from) : String(row.score));
      return h('li', { class: rowClass(row), style: animate ? `animation-delay: ${order * ROLL_STEP_MS - elapsed}ms` : '' }, cells(row, score));
    }),
  );
  if (animate) {
    cancelAnimationFrame(rollFrame);
    rollFrame = requestAnimationFrame(rollTick);
    // Whatever the frames did, the board always ends on the true scores.
    clearTimeout(rollDone);
    rollDone = setTimeout(finishRoll, total - elapsed + 50);
  }
  return list;
}

/** "Round name" with the question's place in the round, "3/10", on its own line beneath it. */
export function questionMeta(q, extra = '') {
  return h(
    'p',
    { class: `question-meta ${extra}`.trim(), 'aria-label': `${q.round}, question ${q.roundQuestion} of ${q.roundQuestions}` },
    h('span', { class: 'round-name', 'aria-hidden': 'true' }, q.round),
    h('strong', { class: 'q-count', 'aria-hidden': 'true' }, `${q.roundQuestion}/${q.roundQuestions}`),
  );
}

/** A size class for long question text, so a paragraph doesn't fill several screens. */
export const textSize = (text = '') => (text.length > 600 ? 'text-xxl' : text.length > 350 ? 'text-xl' : text.length > 180 ? 'text-lg' : '');

/** Class for a block of answer options when any of them is long, so they get smaller type and tighter boxes. */
export const optionsSize = (options = []) => (Math.max(0, ...options.map((o) => o.length)) > 70 ? 'long-options' : '');

// A picture hidden behind black tiles that drop away, in a random order, as the time runs out.
const UNCOVER_COLS = 8;
const UNCOVER_ROWS = 6;

/** The same tile order on every screen for a given question: a small seeded shuffle. */
function uncoverOrder(seed) {
  let x = (seed + 1) * 2654435761 >>> 0;
  const rand = () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = Array.from({ length: UNCOVER_COLS * UNCOVER_ROWS }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * The question's picture. With `q.uncover` it sits under black tiles that disappear over the countdown:
 * all covered while the question is being read out, a tile at a time while it is open, and none once time is up.
 */
export function questionPicture(q, phase, className = 'question-image', alt = '') {
  const img = h('img', { class: className, src: q.image, alt });
  if (!q.uncover) return img;
  const order = uncoverOrder(q.index);
  const total = order.length;
  const tiles = Array.from({ length: total }, () => h('i', { class: 'tile' }));
  order.forEach((tile, k) => {
    tiles[tile].dataset.at = String(0.04 + 0.86 * (k / (total - 1)));
  });
  const wrap = h(
    'div',
    { class: 'uncover', 'data-seconds': String(q.seconds), 'data-phase': phase, style: `--cols: ${UNCOVER_COLS}; --rows: ${UNCOVER_ROWS}` },
    img,
    h('div', { class: 'tiles', 'aria-hidden': 'true' }, tiles),
  );
  updateUncover(wrap);
  return wrap;
}

function updateUncover(wrap) {
  const phase = wrap.dataset.phase;
  const seconds = Number(wrap.dataset.seconds);
  let done;
  if (phase === 'open') {
    const left = frozenMs ?? (deadline == null ? seconds * 1000 : deadline - performance.now());
    done = Math.min(1, Math.max(0, 1 - left / (seconds * 1000)));
  } else done = phase === 'reading' || phase === 'wagering' ? 0 : 1;
  for (const tile of wrap.querySelectorAll('.tile')) tile.classList.toggle('gone', done >= Number(tile.dataset.at));
}

setInterval(() => {
  for (const wrap of document.querySelectorAll('.uncover')) updateUncover(wrap);
}, 250);
