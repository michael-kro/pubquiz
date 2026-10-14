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

export const LETTERS = ['A', 'B', 'C', 'D'];

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

  function open() {
    clearTimeout(retryTimer);
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);
    ws.onopen = () => {
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

// Countdown: elements with data-countdown show the seconds left until the current deadline.
let deadline = null;

export function setDeadline(remainingMs) {
  deadline = remainingMs == null ? null : performance.now() + remainingMs;
}

/** Call after rendering so new countdown elements show the time straight away. */
export function tick() {
  const seconds = deadline == null ? 0 : Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
  for (const el of document.querySelectorAll('[data-countdown]')) {
    el.textContent = String(seconds);
    el.classList.toggle('urgent', seconds <= 5);
  }
}

setInterval(tick, 200);
