import { avatar, brandBlock, brandLogo, breakPanel, connectSocket, flashSpeedster, MEDALS, movement, optionsSize, prizeList, questionMeta, questionPicture, rollStandings, seconds, textSize, h, LETTERS, loadBranding, ordinal, preload, setBreak, setDeadline, tick } from './common.js';
import { mountBranding } from './branding.js';
import { mountEditor } from './editor.js';

const app = document.getElementById('app');
const statusBanner = document.getElementById('status');
/** The TV screen: the same page without any controls, and without answers before the reveal. */
const TV = document.body.classList.contains('tv');
/** On a phone the host screen becomes a remote: a slim header and the buttons in a bar at the bottom, in thumb reach. */
const phoneQuery = window.matchMedia('(max-width: 700px)');
const isPhone = () => !TV && phoneQuery.matches;
phoneQuery.addEventListener?.('change', () => {
  document.body.classList.toggle('phone', isPhone());
  render();
});
document.body.classList.toggle('phone', isPhone());
// A TV is read from across a room: scale everything with the screen, so a 1080p TV gets type about 1.4 times the laptop size.
if (TV) document.documentElement.style.fontSize = 'clamp(13px, min(1.12vw, 1.9vh), 36px)';
const KEY_STORAGE = 'pubquiz.host-key';
const params = new URLSearchParams(location.search);

function storedKey() {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

// The host link carries the key. Without it, a host can type the PIN (if the program was started with one).
let key = params.get('key') ?? (TV ? null : storedKey());
let needPin = false;
let pinError = '';

let state = null;
let fatal = null;
let notice = '';
let noticeTimer;
let library = { items: null, error: '' };
let editor = null; // { id, instance } while the editor is open.

/** Calls the host API. Errors carry the server's message, and `issues` when a quiz can't run. */
async function api(method, path, body) {
  const raw = body instanceof Blob || body instanceof Uint8Array;
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'x-host-key': key, ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    const error = new Error(data?.error ?? (data?.issues ? 'This quiz has problems to fix first.' : `Something went wrong (${res.status}).`));
    error.issues = data?.issues;
    throw error;
  }
  return data;
}

const isBrandingPage = () => !TV && location.hash === '#branding';
let brandingOpen = false;
const editingId = () => /^#edit\/([a-z0-9-]+)$/.exec(location.hash)?.[1];
window.addEventListener('hashchange', () => render());

/** The venues (branding profiles) to switch between, or null when this host has a single branding folder. */
let venues = null;

async function loadVenues() {
  try {
    const info = await api('GET', '/branding');
    venues = info.profiles && info.profiles.length > 1 ? { list: info.profiles, active: info.active } : null;
  } catch {
    venues = null;
  }
}

async function switchVenue(id) {
  try {
    await api('POST', '/branding/active', { id });
    // Every page picks its colours and logo up when it loads, so load this one again.
    location.reload();
  } catch (error) {
    showNotice(error.message);
  }
}

async function loadLibrary() {
  void loadVenues().then(render);
  try {
    library = { items: await api('GET', '/quizzes'), error: '' };
  } catch (error) {
    library = { items: library.items, error: error.message };
  }
  render();
}

let socket = null;

// The TV plays clips the host sends it (its 🔊 sound button needs to have been pressed once, as for any browser).
const tvClip = new Audio();
function showClipToast(text) {
  document.querySelector('.clip-toast')?.remove();
  const toast = h('div', { class: 'clip-toast', role: 'status' }, text);
  document.body.append(toast);
  setTimeout(() => toast.remove(), 3500);
}

function connect() {
  socket = connectSocket({
    onOpen() {
      socket.send({ t: TV ? 'screen' : 'host', key });
    },
    onStatus(connected) {
      statusBanner.hidden = connected || Boolean(fatal) || needPin;
    },
    onMessage(message) {
      if (message.t === 'state') {
        if (!TV && message.view.phase === 'idle' && state?.phase !== 'idle' && message.view.library) void loadLibrary();
        playSoundsFor(state, message.view);
        state = message.view;
        setDeadline(state.question?.remainingMs, state.question?.paused);
        setBreak(state.onBreak);
        if (TV) flashSpeedster(state, true);
        preload(state.preloadImage);
        if (!TV) rememberKey();
      } else if (message.t === 'play-clip' && TV) {
        tvClip.src = message.url;
        void tvClip.play().catch(() => {});
        showClipToast(`🔊 ${message.title}`);
      } else if (message.t === 'stop-clips' && TV) {
        tvClip.pause();
      } else if (message.t === 'host-key') {
        key = message.key;
        rememberKey();
        showNotice('New host key saved in this browser. The old links no longer work; open the TV screen again from the TV screen button.');
      } else if (message.t === 'error') {
        if (state) showNotice(message.message);
        else if (!TV && storedKey() === key) {
          // A saved key that no longer works (the program was reset): ask for the PIN again.
          socket.stop();
          forgetKey();
          void start();
        } else {
          fatal = message.message;
          socket.stop();
        }
      }
      render();
    },
  });
}

function rememberKey() {
  try {
    localStorage.setItem(KEY_STORAGE, key);
  } catch {
    // The link still works; the host just has to type the PIN next time.
    return;
  }
  // Once the browser has it, the secret needn't sit in the address bar (screenshots, shoulder-surfers).
  if (params.has('key')) history.replaceState(null, '', location.pathname + location.hash);
}

function forgetKey() {
  key = null;
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Nothing to forget.
  }
}

async function start() {
  await loadBranding();
  if (key) return connect();
  let open = false;
  try {
    const login = await (await fetch('/login')).json();
    open = login.open === true;
    needPin = login.pin === true;
  } catch {
    needPin = false;
  }
  // Testing mode: the server hands out the key to anyone, so no link or PIN is needed.
  if (open) return submitPin('');
  if (TV) {
    fatal = 'Open the TV link from the host screen.';
    return render();
  }
  if (!needPin) fatal = 'This page needs the host link printed in the terminal when the quiz started.';
  render();
}

async function submitPin(pin) {
  pinError = '';
  try {
    const res = await fetch('/login', { method: 'POST', body: JSON.stringify({ pin, screen: TV }), headers: { 'content-type': 'application/json' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Could not sign in.');
    key = data.key;
    needPin = false;
    if (!TV) rememberKey();
    connect();
  } catch (error) {
    pinError = error.message;
  }
  render();
}

function showNotice(text) {
  notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = '';
    render();
  }, 4000);
}

function advance() {
  socket?.send({ t: 'advance' });
}

// Space, → and PageDown (what presentation clickers send) all move on.
/** Escape closes whichever pop-up is open, the one on top first. Returns whether there was one. */
function closeTopPopup() {
  if (hostQrOpen) hostQrOpen = false;
  else if (headStartOpen) headStartOpen = false;
  else if (clipsOpen) clipsOpen = false;
  else if (settingsOpen) settingsOpen = false;
  else if (codesOpen) codesOpen = false;
  else if (state?.showJoin && !TV) socket?.send({ t: 'show-join', shown: false });
  else if (moreOpen || breakMenuOpen) {
    moreOpen = false;
    breakMenuOpen = false;
  } else return false;
  render();
  return true;
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && closeTopPopup()) {
    event.preventDefault();
    return;
  }
  if (TV || !state || state.phase === 'idle' || editingId() || event.target !== document.body) return;
  if ([' ', 'ArrowRight', 'PageDown', 'Enter'].includes(event.key)) {
    event.preventDefault();
    advance();
  } else if ((event.key === 's' || event.key === 'S') && state.phase === 'reading') {
    socket?.send({ t: 'start-timer' });
  } else if ((event.key === 'y' || event.key === 'Y' || event.key === 'n' || event.key === 'N') && state.phase === 'open' && state.buzzers?.some((b) => b.status === 'answering')) {
    socket?.send({ t: 'judge', correct: event.key.toLowerCase() === 'y' });
  } else if ((event.key === 'p' || event.key === 'P') && state.phase === 'open' && !state.buzzers?.some((b) => b.status === 'answering')) {
    socket?.send({ t: state.question?.paused ? 'resume' : 'pause' });
  }
});

function nextLabel(s) {
  if (s.onBreak) return 'End break';
  if (s.phase === 'lobby' && !s.canStart) return 'Waiting for teams…';
  const last = s.question && s.question.index + 1 === s.questionCount;
  return {
    lobby: 'Start quiz',
    wagering: 'Show question',
    reading: s.reading && s.reading.shown < s.reading.total ? (s.startOnLastAnswer && s.reading.shown === s.reading.total - 1 ? 'Show last answer & start timer' : 'Read next answer') : 'Start timer',
    open: 'Close question',
    closed: 'Reveal answer',
    // Mid-round the next press goes straight on; the full board comes at the end of a round, or on request.
    reveal: s.skipsLeaderboardNext ? 'Next question' : 'Show leaderboard',
    leaderboard: last ? 'Final results' : 'Next question',
    finished: 'Quiz finished',
  }[s.phase];
}

function pinForm() {
  return h(
    'form',
    {
      class: 'screen join',
      onsubmit: (event) => {
        event.preventDefault();
        void submitPin(new FormData(event.target).get('pin'));
      },
    },
    h('h1', {}, 'Quiz master'),
    h('label', {}, 'PIN', h('input', { name: 'pin', type: 'password', autocomplete: 'current-password', required: true, autofocus: true })),
    pinError ? h('p', { class: 'error', role: 'alert' }, pinError) : null,
    h('button', { class: 'primary', type: 'submit' }, 'Open the host screen'),
  );
}

/** Puts the page together, skipping any panel that has nothing to show (a null would be drawn as the word "null"). */
function draw(...nodes) {
  app.replaceChildren(...nodes.filter(Boolean));
}

function render() {
  if (needPin && !key) {
    app.replaceChildren(pinForm());
    return;
  }
  if (fatal) {
    app.replaceChildren(h('section', { class: 'screen center' }, h('h1', {}, "Can't open the host screen"), h('p', {}, fatal)));
    return;
  }
  if (isBrandingPage() && key) {
    if (!brandingOpen) {
      brandingOpen = true;
      mountBranding(app, {
        api,
        onExit() {
          location.hash = '';
        },
      });
    }
    return; // The branding panel draws itself.
  }
  brandingOpen = false;
  const editId = editingId();
  if (editId) {
    if (editor?.id !== editId) openEditor(editId);
    return; // The editor draws itself.
  }
  if (editor) {
    editor.instance?.destroy();
    editor = null;
  }
  if (!state) {
    app.replaceChildren(h('section', { class: 'screen center' }, h('p', { class: 'muted' }, 'Connecting…')));
    return;
  }
  if (TV && state.phase === 'idle') {
    app.replaceChildren(h('section', { class: 'screen center' }, h('h1', {}, 'Quiz night'), h('p', { class: 'muted' }, 'Waiting for the quiz master to start a quiz…')));
    return;
  }
  if (state.phase === 'idle') {
    keepFocus(() => draw(openHostWarning(state), libraryView(state), hostQrOverlay(state), clipsOverlay(), settingsOverlay(), notice ? h('div', { class: 'notice', role: 'alert' }, notice) : null));
    return;
  }
  keepFocus(() => draw(
    openHostWarning(state),
    h(
      'div',
      { class: `host-layout${TV ? ' no-side' : ''}` },
      topBar(state),
      h('section', { class: 'stage' }, TV ? null : networkBanner(state), TV ? null : shortLinksNote(state), stage(state)),
      TV ? null : teamsPanel(state),
    ),
    codesOverlay(state),
    joinOverlay(state),
    hostQrOverlay(state),
    headStartOverlay(state),
    clipsOverlay(),
    settingsOverlay(),
    notice ? h('div', { class: 'notice', role: 'alert' }, notice) : '',
  ));
  tick();
  refreshClipBar();
}

const NETWORK_LABELS = {
  lan: '📶 Local Wi-Fi',
  starting: '🌐 Connecting to the internet…',
  up: '🌐 Internet link',
  down: '⚠️ Internet link down',
};

function networkPill(network, compact = false) {
  const key = network.mode === 'lan' ? 'lan' : network.state;
  // On a phone the pill is just its emoji, with the words as the tooltip and for screen readers.
  if (compact) return h('span', { class: `network-pill compact ${key}`, role: 'img', 'aria-label': NETWORK_LABELS[key].replace(/^\S+\s/, ''), title: `${NETWORK_LABELS[key].replace(/^\S+\s/, '')}${network.message ? `: ${network.message}` : ''}` }, NETWORK_LABELS[key].split(' ')[0]);
  return h('span', { class: `network-pill ${key}`, title: network.message ?? '' }, NETWORK_LABELS[key]);
}

/** The address to show people: the short link if there is one, else the full one, without the https://. */
function joinText(s) {
  return (s.shortLinks?.join ?? s.joinUrl).replace(/^https?:\/\//, '');
}

/** Copies text to the clipboard. Plain http addresses (the laptop's Wi-Fi address) have no clipboard API, so fall back to a hidden text box. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = h('textarea', { value: text, readonly: true, style: 'position:fixed;left:-9999px;top:0' });
    document.body.append(box);
    box.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    box.remove();
    return ok;
  }
}

/** A small button that copies `getText()` and says so for a moment. Host screen only. */
function copyButton(getText, label = 'Copy link') {
  if (TV) return null;
  const button = h('button', {
    type: 'button',
    class: 'copy-link',
    title: 'Copy to the clipboard',
    onclick: async () => {
      const ok = await copyText(getText());
      button.textContent = ok ? '✓ Copied' : 'Press Ctrl+C';
      setTimeout(() => { button.textContent = `📋 ${label}`; }, 1500);
    },
  }, `📋 ${label}`);
  return button;
}

/** The short links on the host screen, for reading out or typing into the TV. */
function shortLinksNote(s) {
  if (TV || !s.shortLinks) return null;
  const { join, tv } = s.shortLinks;
  return h('p', { class: 'short-links muted' }, '🔗 Short links: ', join ? ['teams ', h('strong', {}, join.replace(/^https?:\/\//, '')), ' ', copyButton(() => join)] : null, join && tv ? ' · ' : null, tv ? ['TV page ', h('strong', {}, tv.replace(/^https?:\/\//, '')), ' ', copyButton(() => tv)] : null);
}

/** Shown across the top while the testing switch is on: nobody needs the key to run this quiz. */
function openHostWarning(s) {
  if (TV || !s.openHost) return null;
  return h('div', { class: 'open-host-warning', role: 'alert' }, h('strong', {}, '⚠ Testing mode: the host key is switched off.'), ' Anyone who opens this web address can control the quiz. Restart the app normally before a real quiz.');
}

/** Warning with a way out when the internet link is down, or a way back when the host chose local Wi-Fi. */
function networkBanner(s) {
  const n = s.network;
  if (n.mode === 'tunnel' && n.state === 'down') {
    return h(
      'div',
      { class: 'network-banner', role: 'alert' },
      h('span', {}, h('strong', {}, 'The internet link is down. '), n.message ?? ''),
      h('button', { onclick: () => socket.send({ t: 'network', action: 'use-lan' }) }, 'Switch to local Wi-Fi'),
    );
  }
  if (n.mode === 'lan' && n.tunnelAvailable) {
    return h(
      'div',
      { class: 'network-banner calm' },
      h('span', {}, "Local Wi-Fi only: teams' phones must be on the same Wi-Fi as this laptop."),
      h('button', { onclick: () => socket.send({ t: 'network', action: 'use-tunnel' }) }, 'Use the internet link'),
    );
  }
  return null;
}

function openEditor(id) {
  editor = { id, instance: null };
  app.replaceChildren(h('section', { class: 'screen center' }, h('p', { class: 'muted' }, 'Opening the editor…')));
  mountEditor(app, {
    id,
    hostKey: key,
    api,
    onExit() {
      location.hash = '';
      void loadLibrary();
    },
    onRun() {
      location.hash = '';
    },
  })
    .then((instance) => {
      if (editor?.id === id) editor.instance = instance;
      else instance.destroy();
    })
    .catch((error) => {
      editor = null;
      location.hash = '';
      showNotice(error.message);
    });
}

function endQuiz(s) {
  const midQuiz = !['lobby', 'finished'].includes(s.phase);
  if (midQuiz && !confirm('End this quiz now? Teams are disconnected. You can resume it later from your quizzes.')) return;
  socket.send({ t: 'end-quiz' });
}

async function runQuiz(id, fresh = false) {
  try {
    await api('POST', `/quizzes/${id}/run`, { fresh });
  } catch (error) {
    showNotice(error.issues?.length ? `Can't run it yet: ${error.issues[0]}${error.issues.length > 1 ? ` (and ${error.issues.length - 1} more)` : ''}` : error.message);
    render();
  }
}

async function importQuiz(file) {
  try {
    const result = await api('POST', `/import?name=${encodeURIComponent(file.name)}`, file);
    if (result.issues.length) {
      showNotice(`Imported. ${result.issues.length} ${result.issues.length === 1 ? 'thing needs' : 'things need'} fixing before it can run.`);
      location.hash = `#edit/${result.id}`;
    } else {
      showNotice(`Imported "${file.name}".`);
      await loadLibrary();
    }
  } catch (error) {
    showNotice(error.message);
    render();
  }
}

const VIEW_STORAGE = 'pubquiz.libraryView';
let libraryMode = (() => {
  try {
    return localStorage.getItem(VIEW_STORAGE) === 'list' ? 'list' : 'tiles';
  } catch {
    return 'tiles';
  }
})();
let libraryFilter = '';

function setLibraryMode(mode) {
  libraryMode = mode;
  try {
    localStorage.setItem(VIEW_STORAGE, mode);
  } catch {
    // The choice just isn't remembered.
  }
  render();
}

/** Search box and the tiles/list switch above the quizzes. */
function libraryTools(total) {
  return h(
    'div',
    { class: 'library-tools' },
    h('input', {
      type: 'search',
      class: 'library-search',
      'data-keep': 'library-search',
      placeholder: `Search ${total} ${total === 1 ? 'quiz' : 'quizzes'}`,
      'aria-label': 'Search quizzes',
      value: libraryFilter,
      oninput: (e) => {
        libraryFilter = e.target.value;
        render();
      },
    }),
    // A phone has room for one column either way, so there is nothing to switch between.
    isPhone() ? null : h(
      'div',
      { class: 'view-switch', role: 'group', 'aria-label': 'How to show the quizzes' },
      h('button', { type: 'button', class: libraryMode === 'tiles' ? 'active' : '', 'aria-pressed': String(libraryMode === 'tiles'), title: 'Tiles', onclick: () => setLibraryMode('tiles') }, '▦ Tiles'),
      h('button', { type: 'button', class: libraryMode === 'list' ? 'active' : '', 'aria-pressed': String(libraryMode === 'list'), title: 'List', onclick: () => setLibraryMode('list') }, '☰ List'),
    ),
  );
}

function libraryView(s) {
  if (!s.library) {
    return h('section', { class: 'screen center' }, h('h1', {}, 'No quiz running'), h('p', {}, 'Restart the program to run a quiz.'));
  }
  const items = library.items;
  const needle = libraryFilter.trim().toLowerCase();
  const shown = items?.filter((q) => !needle || q.title.toLowerCase().includes(needle)) ?? [];
  const act = (fn) => async () => {
    try {
      await fn();
    } catch (error) {
      showNotice(error.message);
    }
    await loadLibrary();
  };
  return h(
    'div',
    { class: 'library' },
    h(
      'header',
      { class: 'library-bar' },
      brandLogo('brand-logo small'),
      hostBadge(),
      h('h1', {}, 'Your quizzes'),
      networkPill(s.network),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', onclick: openClips, title: 'Play sound clips whenever you like' }, '🎵 Clips'),
      venues
        ? h(
            'label',
            { class: 'venue-switch', title: 'The venue whose logo and colours every screen shows' },
            '🍺 ',
            h('select', { 'aria-label': 'Venue', onchange: (e) => switchVenue(e.target.value) }, venues.list.map((v) => h('option', { value: v.id, selected: v.id === venues.active }, v.label))),
          )
        : null,
      h('a', { class: 'button', href: '#branding' }, 'Branding'),
      h('button', { type: 'button', onclick: openSettings, title: 'Where your quizzes are kept' }, '⚙ Settings'),
      isPhone() ? null : h('button', { type: 'button', onclick: () => { hostQrOpen = true; render(); }, title: 'A QR code to open this host page on your phone' }, '📲 Host on my phone'),
      h(
        'label',
        { class: 'button' },
        'Import…',
        h('input', {
          type: 'file',
          accept: '.yaml,.yml,.zip',
          hidden: true,
          onchange: (e) => e.target.files[0] && importQuiz(e.target.files[0]),
        }),
      ),
      h(
        'button',
        {
          class: 'primary',
          onclick: async () => {
            try {
              const { id } = await api('POST', '/quizzes');
              location.hash = `#edit/${id}`;
            } catch (error) {
              showNotice(error.message);
            }
          },
        },
        '+ New quiz',
      ),
    ),
    library.error ? h('p', { class: 'error' }, library.error) : null,
    items === null
      ? h('p', { class: 'muted' }, 'Loading…')
      : items.length === 0
        ? h(
            'div',
            { class: 'empty' },
            h('p', { class: 'big' }, 'No quizzes yet.'),
            h('p', { class: 'muted' }, 'Make one with “New quiz”, or import a quiz file (.yaml, or a .zip with pictures).'),
            h(
              'button',
              {
                class: 'primary',
                onclick: act(() => api('POST', '/sample')),
              },
              'Add a sample quiz to try',
            ),
          )
        : [
            libraryTools(items.length),
            shown.length === 0 ? h('p', { class: 'muted' }, `No quizzes match “${libraryFilter.trim()}”.`) : null,
            h(
            'ul',
            { class: `quiz-cards${libraryMode === 'list' && !isPhone() ? ' as-list' : ''}` },
            shown.map((q) =>
              h(
                'li',
                { class: 'quiz-card' },
                h('h2', {}, q.title),
                h(
                  'div',
                  { class: 'card-meta' },
                  h('p', { class: 'muted' }, `${q.rounds} ${q.rounds === 1 ? 'round' : 'rounds'} · ${q.questions} ${q.questions === 1 ? 'question' : 'questions'}`),
                  q.problems ? h('p', { class: 'problem' }, `${q.problems} ${q.problems === 1 ? 'thing' : 'things'} to fix before it can run`) : null,
                  q.unfinished ? h('p', { class: 'unfinished' }, `Unfinished: stopped at question ${q.unfinished.question} of ${q.unfinished.total}`) : null,
                ),
                h(
                  'div',
                  { class: 'card-actions' },
                  q.unfinished
                    ? [
                        h('button', { class: 'primary', disabled: q.problems > 0, onclick: () => runQuiz(q.id) }, 'Resume ▶'),
                        h('button', { disabled: q.problems > 0, onclick: () => confirm('Start again from the beginning? The unfinished scores are lost.') && runQuiz(q.id, true) }, 'Start over'),
                      ]
                    : h('button', { class: 'primary', disabled: q.problems > 0, onclick: () => runQuiz(q.id) }, 'Run ▶'),
                  h('a', { class: 'button', href: `#edit/${q.id}` }, 'Edit'),
                  h('button', { onclick: act(() => api('POST', `/quizzes/${q.id}/duplicate`)) }, 'Duplicate'),
                  // On a phone the card keeps to running and editing; exporting and deleting are laptop jobs.
                  isPhone() ? null : h('a', { class: 'button', href: `/api/quizzes/${q.id}/export.zip?key=${encodeURIComponent(key)}` }, 'Export'),
                  isPhone()
                    ? null
                    : h(
                        'button',
                        { class: 'danger', onclick: act(async () => confirm(`Delete "${q.title}"?`) && (await api('DELETE', `/quizzes/${q.id}`))) },
                        'Delete',
                      ),
                ),
              ),
            ),
          ),
          ],
  );
}

// Sounds: short tones made in the browser, off until someone turns them on (browsers need a click first).
const SOUND_KEY = TV ? 'pubquiz.sound.tv' : 'pubquiz.sound.host';
let soundOn = false;
try {
  soundOn = localStorage.getItem(SOUND_KEY) === '1';
} catch {
  // Sound just starts off.
}
let audio;

function tone(freq, start, length, volume = 0.15, type = 'sine') {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, audio.currentTime + start);
  gain.gain.exponentialRampToValueAtTime(volume, audio.currentTime + start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + start + length);
  osc.connect(gain).connect(audio.destination);
  osc.start(audio.currentTime + start);
  osc.stop(audio.currentTime + start + length + 0.05);
}

const SOUNDS = {
  open: () => [660, 880].forEach((f, i) => tone(f, i * 0.12, 0.2)),
  closed: () => tone(180, 0, 0.5, 0.2, 'square'),
  reveal: () => [523, 659, 784].forEach((f, i) => tone(f, i * 0.1, 0.3)),
  finished: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, i * 0.16, 0.35)),
};

// The question's audio clip is one element that lives outside the page, so redrawing the screen never restarts it.
const clip = new Audio();
clip.preload = 'auto';
let clipFor = -1; // Index of the question the clip was loaded for.
let clipWasPlayingBeforePause = false;
for (const event of ['play', 'pause', 'ended', 'timeupdate']) clip.addEventListener(event, () => document.querySelector('.clip-bar') && refreshClipBar());

function refreshClipBar() {
  const bar = document.querySelector('.clip-bar');
  if (!bar) return;
  bar.querySelector('.clip-toggle').textContent = clip.paused ? '▶ Play clip' : '⏸ Pause clip';
  const t = (n) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
  bar.querySelector('.clip-time').textContent = Number.isFinite(clip.duration) ? `${t(clip.currentTime)} / ${t(clip.duration)}` : '';
}

/** Loads the clip for a new question, plays it by itself if this screen's sound is on, and follows pause and resume. */
function followClip(before, after) {
  const q = after.question;
  if (after.phase === 'idle' || !q?.audio || ['leaderboard', 'finished'].includes(after.phase)) {
    if (!clip.paused) clip.pause();
    if (!q?.audio) clipFor = -1;
    return;
  }
  if (clipFor !== q.index) {
    clipFor = q.index;
    clip.src = q.audio;
    clip.currentTime = 0;
    if (soundOn && after.phase === 'open') clip.play().catch(() => {});
  }
  const wasPaused = before?.question?.paused === true;
  if (q.paused && !wasPaused) {
    clipWasPlayingBeforePause = !clip.paused;
    clip.pause();
  } else if (!q.paused && wasPaused && clipWasPlayingBeforePause) {
    clip.play().catch(() => {});
    clipWasPlayingBeforePause = false;
  }
}

// The reveal clip (a film quote, say) plays once when the answer is shown, and can be replayed.
const revealClip = new Audio();
revealClip.preload = 'auto';
let revealClipFor = -1;

function followRevealClip(after) {
  const q = after.question;
  if (after.phase !== 'reveal' || !q?.revealAudio) {
    if (!revealClip.paused) revealClip.pause();
    if (after.phase !== 'reveal') revealClipFor = -1;
    return;
  }
  if (revealClipFor !== q.index) {
    revealClipFor = q.index;
    revealClip.src = q.revealAudio;
    revealClip.currentTime = 0;
    if (soundOn) revealClip.play().catch(() => {});
  }
}

for (const event of ['play', 'pause', 'ended']) {
  revealClip.addEventListener(event, () => {
    const button = document.querySelector('.reveal-clip-toggle');
    if (button) button.textContent = revealClip.paused ? '▶ Play clip' : '⏸ Stop clip';
  });
}

function revealClipBar(q) {
  if (!q.revealAudio) return null;
  return h(
    'div',
    { class: 'clip-bar reveal-clip' },
    h('span', { class: 'clip-title' }, `🎬 ${q.revealCaption || 'Bonus clip'}`),
    TV
      ? null
      : h(
          'button',
          {
            type: 'button',
            class: 'primary reveal-clip-toggle',
            onclick: () => {
              if (revealClip.paused) {
                revealClip.currentTime = 0;
                void revealClip.play().catch(() => showNotice('The browser blocked the sound. Click the 🔊 button first, then try again.'));
              } else revealClip.pause();
            },
          },
          revealClip.paused ? '▶ Play clip' : '⏸ Stop clip',
        ),
  );
}

function clipBar(q) {
  if (!q.audio) return null;
  return h(
    'div',
    { class: 'clip-bar' },
    h('span', { class: 'clip-title' }, '🎵 Audio clip'),
    h('button', { type: 'button', class: 'clip-toggle', onclick: () => (clip.paused ? clip.play().catch(() => {}) : clip.pause()) }, clip.paused ? '▶ Play clip' : '⏸ Pause clip'),
    h('button', { type: 'button', onclick: () => { clip.currentTime = 0; void clip.play().catch(() => {}); } }, '⟲ Replay clip'),
    h('span', { class: 'clip-time' }),
  );
}

function playSoundsFor(before, after) {
  followClip(before, after);
  followRevealClip(after);
  if (!soundOn || !audio || after.phase === 'idle' || before?.phase === after.phase) return;
  SOUNDS[after.phase]?.();
}

function toggleSound() {
  soundOn = !soundOn;
  try {
    localStorage.setItem(SOUND_KEY, soundOn ? '1' : '0');
  } catch {
    // Not remembered.
  }
  if (soundOn) {
    audio ??= new AudioContext();
    void audio.resume();
    SOUNDS.open();
  }
  render();
}

// A saved "on" setting still needs one click before the browser allows sound.
document.addEventListener(
  'pointerdown',
  () => {
    if (soundOn && !audio) audio = new AudioContext();
    void audio?.resume();
  },
  { once: false },
);

function soundButton() {
  return h(
    'button',
    { class: 'sound-toggle', title: soundOn ? 'Sound on' : 'Sound off', 'aria-label': soundOn ? 'Turn sound off' : 'Turn sound on', 'aria-pressed': String(soundOn), onclick: toggleSound },
    soundOn ? '🔊' : '🔇',
  );
}

/** A label so the host's controls are never mistaken for the TV screen. */
function hostBadge() {
  return h('span', { class: 'host-badge', title: 'This is the host screen: the controls. The TV screen is a separate page.' }, '🎛 HOST');
}

function topBar(s) {
  if (TV) {
    return h(
      'header',
      { class: 'host-bar' },
      brandLogo('brand-logo small'),
      h('span', { class: 'quiz-title' }, s.quizTitle),
      h('span', { class: 'join-hint' }, 'Join: ', h('strong', {}, joinText(s)), ' · Room ', h('strong', {}, s.roomCode)),
      soundButton(),
    );
  }
  if (isPhone()) {
    return h(
      'div',
      { class: 'phone-top' },
      h(
        'header',
        { class: 'host-bar phone-head' },
        h('div', { class: 'phone-head-row' }, hostBadge(), h('span', { class: 'quiz-title', title: s.quizTitle }, s.quizTitle), soundButton()),
        h('div', { class: 'phone-head-row' }, networkPill(s.network, true), s.joiningLocked ? h('span', { class: 'join-hint' }, h('strong', { title: 'Closed to new teams' }, '🔒 Closed to new teams')) : null),
      ),
      h(
        'div',
        { class: 'phone-actions' },
        s.pendingTeams?.length ? h('button', { type: 'button', class: 'pending-pill', onclick: () => socket.send({ t: 'admit-all' }) }, `⏳ ${s.pendingTeams.length} · Admit`) : null,
        breakControl(s, true),
        moreControl(s),
        h('button', { class: 'primary next', onclick: advance, disabled: s.phase === 'finished' || (s.phase === 'lobby' && !s.canStart) }, nextLabel(s)),
      ),
    );
  }
  return h(
    'header',
    { class: 'host-bar' },
    s.canEnd
      ? h('button', { type: 'button', class: 'logo-home', title: 'Back to your quizzes', 'aria-label': 'Back to your quizzes', onclick: () => endQuiz(s) }, brandLogo('brand-logo small'))
      : brandLogo('brand-logo small'),
    hostBadge(),
    h(
      'div',
      { class: 'bar-id' },
      h('span', { class: 'quiz-title', title: s.quizTitle }, s.quizTitle),
      h('span', { class: 'join-hint' }, s.joiningLocked ? h('strong', {}, '🔒 Closed to new teams') : ['Join ', h('strong', {}, joinText(s)), ' ', copyButton(() => s.shortLinks?.join ?? s.joinUrl, 'Copy'), ' · Room ', h('strong', {}, s.roomCode)]),
    ),
    networkPill(s.network),
    soundButton(),
    h('a', { class: 'button', href: `/screen?key=${encodeURIComponent(s.screenKey)}`, target: '_blank', rel: 'noopener', title: 'Open this on the TV or projector' }, 'TV ↗'),
    breakControl(s),
    h('button', { type: 'button', onclick: openClips, title: 'Play sound clips whenever you like' }, '🎵 Clips'),
    s.pendingTeams?.length ? h('button', { type: 'button', class: 'pending-pill', title: 'Let in every team that is waiting', onclick: () => socket.send({ t: 'admit-all' }) }, `⏳ ${s.pendingTeams.length} waiting · Admit`) : null,
    !TV && s.phase === 'reveal' && s.skipsLeaderboardNext
      ? h('button', { onclick: () => socket.send({ t: 'leaderboard' }), title: 'Show the full leaderboard first' }, 'Leaderboard')
      : null,
    moreControl(s),
    h(
      'button',
      { class: 'primary next', onclick: advance, disabled: s.phase === 'finished' || (s.phase === 'lobby' && !s.canStart), title: s.phase === 'lobby' && !s.canStart ? 'The quiz can start once a team has joined' : 'Space or → also works' },
      nextLabel(s),
    ),
  );
}

function stage(s) {
  const q = s.question;
  if (s.onBreak) return breakStage(s);
  switch (s.phase) {
    case 'lobby':
      return h(
        'div',
        { class: 'lobby' },
        s.wifi
          ? h(
              'div',
              { class: 'qr-pair' },
              h('figure', { class: 'qr-step' }, h('img', { class: 'qr', src: `/wifi-qr.svg?key=${encodeURIComponent(TV ? key : s.screenKey)}`, alt: `QR code to join the ${s.wifi.ssid} Wi-Fi network` }), h('figcaption', {}, h('strong', {}, '1. Join the Wi-Fi'), h('br'), s.wifi.ssid, s.wifi.password ? h('br') : null, s.wifi.password ? `Password: ${s.wifi.password}` : null)),
              h('figure', { class: 'qr-step' }, h('img', { class: 'qr', src: `/qr.svg?v=${s.qrVersion}`, alt: `QR code for ${s.joinUrl}` }), h('figcaption', {}, h('strong', {}, '2. Open the quiz'))),
            )
          : h('img', { class: 'qr', src: `/qr.svg?v=${s.qrVersion}`, alt: `QR code for ${s.joinUrl}` }),
        h(
          'div',
          {},
          TV ? brandBlock() : null,
          h('h1', {}, 'Scan to join'),
          h('p', { class: 'big' }, joinText(s), TV ? null : [' ', copyButton(() => s.shortLinks?.join ?? s.joinUrl)]),
          h('p', { class: 'room-code-line' }, 'Room code ', h('span', { class: 'room-code' }, s.roomCode)),
          h('p', { class: 'muted' }, 'One phone per team.'),
          TV ? [entryFeeBanner(s), prizeList(s.prizes, true)] : h('div', { class: 'lobby-extras' }, entryFeeEditor(s), prizesEditor(s)),
          TV
            ? null
            : h(
                'label',
                { class: 'check', title: 'When you press Start quiz, no new teams can join. Teams already in can still rejoin.' },
                h('input', { type: 'checkbox', checked: s.lockOnStart, onchange: (e) => socket.send({ t: 'lock-on-start', on: e.target.checked }) }),
                ' 🔒 Lock the quiz when it starts (no new teams)',
              ),
          TV
            ? null
            : h(
                'label',
                { class: 'check', title: 'The teams appear on the TV as they join. Untick to keep their names off the screen while people arrive.' },
                h('input', { type: 'checkbox', checked: s.tvShowTeams, onchange: (e) => socket.send({ t: 'tv-teams', visible: e.target.checked }) }),
                ' 📺 Show teams on the TV as they join',
              ),
          TV
            ? null
            : h(
                'label',
                { class: 'check', title: 'Normally the Start button waits until a team has joined. Tick this to start with nobody in, for example to try a quiz out.' },
                h('input', { type: 'checkbox', checked: s.allowEmptyStart, onchange: (e) => socket.send({ t: 'allow-empty-start', on: e.target.checked }) }),
                ' ▶ Allow starting with no teams (for trying a quiz out)',
              ),
          s.network.mode === 'tunnel' && s.network.state === 'starting'
            ? h('p', { class: 'muted small' }, 'Setting up the internet link. Until then, teams need to be on the same Wi-Fi as this laptop.')
            : null,
        ),
        TV ? tvTeams(s) : null,
      );

    case 'wagering':
      return h(
        'div',
        { class: 'wager-stage' },
        questionMeta(q, 'center'),
        h('p', { class: 'wager-kicker' }, '🎲 Wager round'),
        h('h1', { class: 'wager-category' }, q.category || 'Place your bets'),
        h('p', { class: 'muted center big' }, 'Teams are betting before they see the question.'),
        s.wagering
          ? h('div', { class: 'progress-wrap' }, h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(Math.max(s.wagering.total, 1)), 'aria-valuenow': String(s.wagering.done) }, h('div', { class: 'progress-fill', style: `width: ${Math.min(100, (s.wagering.done / Math.max(s.wagering.total, 1)) * 100)}%` })), h('p', { class: 'muted center' }, `${s.wagering.done} of ${s.wagering.total} teams have bet`))
          : null,
        !TV && q.hostText ? h('p', { class: 'host-only' }, h('strong', {}, 'Question (teams cannot see it yet): '), q.hostText) : null,
      );

    case 'reading':
    case 'open':
    case 'closed':
    case 'reveal': {
      const reveal = s.phase === 'reveal';
      // The host keeps questions off the TV: it shows the countdown, and the question again only with the answer.
      if (TV && q.hidden && !reveal) {
        return h(
          'div',
          { class: 'question-stage question-hidden' },
          h('div', { class: 'question-top' }, questionMeta(q), s.phase === 'open' ? h('span', { class: 'countdown big', 'data-countdown': true }) : h('span', { class: 'phase-label' }, s.phase === 'closed' ? "Time's up" : '')),
          q.paused ? h('p', { class: 'paused-banner', role: 'status' }, '⏸ Paused') : null,
          q.type === 'music' && !q.audio ? h('p', { class: 'music-badge' }, '🎵 Music round: listen up') : null,
          h('h1', { class: 'hidden-question-title' }, s.phase === 'closed' ? 'Answers are in' : 'Look at your phone'),
          h('p', { class: 'muted center big' }, `Question ${q.index + 1} of ${q.total}`),
          answerProgress(s),
        );
      }
      return h(
        'div',
        { class: 'question-stage' },
        h(
          'div',
          { class: 'question-top' },
          questionMeta(q),
          s.phase === 'open'
            ? h('span', { class: 'countdown big', 'data-countdown': true })
            : h('span', { class: 'phase-label' }, s.phase === 'reading' ? 'Listen to the answers' : s.phase === 'closed' ? "Time's up" : 'Answer'),
        ),
        q.halveOnWrong ? h('p', { class: 'halve-banner', role: 'note' }, '⚠ Halving round: one wrong answer halves a team’s score for this round') : null,
        q.paused ? h('p', { class: 'paused-banner', role: 'status' }, s.buzzers?.some((b) => b.status === 'answering') ? '⏱ The clock is held while a team answers' : '⏸ Paused') : null,
        q.type === 'music' && !q.audio ? h('p', { class: 'music-badge' }, '🎵 Music round: play the track now') : null,
        clipBar(q),
        revealClipBar(q),
        !TV && s.phase === 'reading'
          ? h('p', { class: 'host-only' }, s.reading ? `Read each answer out loud, then press the button to show the next one (${s.reading.shown} of ${s.reading.total} showing).${s.startOnLastAnswer ? ' The timer starts when the last answer shows. ' : ' '}` : 'Ask the question out loud, then start the timer. ', h('button', { type: 'button', onclick: () => socket.send({ t: 'start-timer' }) }, 'Start timer now (S)'))
          : null,
        h('h1', { class: `question-text ${textSize(q.text)}` }, q.text),
        q.image
          ? questionPicture(q, s.phase, `question-image host-image${s.review ? ' small' : ''}`)
          : null,
        !TV && s.phase === 'closed' ? answerReview(s, q) : null,
        questionBody(s, q, reveal),
        reveal ? fastestBlock(s) : null,
        reveal ? wagerBlock(s) : null,
        reveal && s.skipsLeaderboardNext ? miniBoard(s) : null,
        reveal && q.info && q.type !== 'number' && q.type !== 'nearest' ? h('p', { class: 'muted info center' }, q.info) : null,
        s.phase === 'open' ? timerBar(q) : null,
        answerProgress(s),
        TV ? null : questionControls(s),
      );
    }

    case 'leaderboard':
    case 'finished': {
      const final = s.phase === 'finished';
      const roundBreak = !final && q?.lastInRound;
      return h(
        'div',
        { class: 'board' },
        final ? brandBlock() : null,
        h(
          'h1',
          { class: 'center' },
          final ? 'Final results' : roundBreak ? `End of round ${q.roundNumber}: ${q.round}` : 'Leaderboard',
        ),
        final ? podium(s.standings) : null,
        final ? prizeList(s.prizes, TV) : null,
        rollStandings(s.standings.slice(final ? podiumSize(s.standings) : 0), {
          key: `${s.quizTitle}:${s.phase}:${s.question?.index ?? ''}`,
          className: 'two-col',
          columns: (n) => (n > 8 ? 2 : 1),
          rowClass: (row) => (row.rank <= 3 && !final ? 'top-three' : ''),
          cells: (row, score) => [h('span', { class: 'rank' }, ordinal(row.rank)), avatar(row.name, row.photo, 36), h('span', { class: 'name' }, row.name), movement(row), score],
        }),
        final && !TV
          ? h(
              'p',
              { class: 'center' },
              h('a', { class: 'button', href: `/results.csv?key=${encodeURIComponent(key)}`, download: '' }, 'Download results (CSV)'),
            )
          : null,
      );
    }
  }
  return h('div');
}

/** Time's up: the answer, for the host to check (and change) before it goes on the screens. */
function answerReview(s, q) {
  if (q.type === 'buzzer' || q.type === 'picture' || q.type === 'music') return null; // Typed answers have their own review list.
  const edit = (() => {
    if (!q.editable) return null;
    if (q.type === 'multiple-choice') return h('span', { class: 'muted' }, 'Click an option below to change it.');
    const isLetter = q.type === 'letter';
    return h('input', {
      class: 'answer-edit',
      'aria-label': isLetter ? 'Correct letter' : 'Correct number',
      value: String(q.editValue ?? ''),
      maxlength: isLetter ? '1' : '20',
      inputmode: isLetter ? 'text' : 'decimal',
      // Sent when the host finishes typing, not on every key.
      onchange: (e) => {
        const raw = e.target.value.trim().replace(',', '.');
        if (isLetter) socket.send({ t: 'set-answer', value: raw });
        else if (/^-?\d+(\.\d+)?$/.test(raw)) socket.send({ t: 'set-answer', value: Number(raw) });
        else showNotice('Type a number.');
      },
    });
  })();
  return h(
    'div',
    { class: 'answer-review', role: 'status' },
    h('span', { class: 'answer-review-label' }, 'Answer'),
    h('strong', { class: 'answer-review-text' }, q.answerText),
    q.answerEdited ? h('span', { class: 'chip plain' }, 'changed') : null,
    edit,
    h('span', { class: 'muted small answer-review-note' }, 'Only you can see this until you press Reveal answer.'),
  );
}

// The break screen: big fun facts for the TV, and the same (with a way back) for the host.

function breakStage(s) {
  return h('div', { class: 'break-stage' }, brandBlock(), breakPanel(true), TV ? null : h('p', { class: 'muted center' }, 'Press End break (or Space) when you are ready to carry on.'));
}

let breakMenuOpen = false;
document.addEventListener('click', (event) => {
  if ((breakMenuOpen || moreOpen) && !event.target.closest?.('.break-menu-wrap')) {
    breakMenuOpen = false;
    moreOpen = false;
    render();
  }
});

/** The Break button and its choice of lengths, shown between questions. */
let moreOpen = false;

/** Rarely used actions, tucked into a menu so the top bar stays on one line. */
function moreControl(s) {
  const items = [
    ...(isPhone() && s.phase === 'reveal' && s.skipsLeaderboardNext ? [['🏆 Show leaderboard', () => socket.send({ t: 'leaderboard' })]] : []),
    ...(isPhone() ? [['🎵 Clips', openClips]] : [['📲 Host on my phone', () => { hostQrOpen = true; }]]),
    ...(isPhone() ? [['📋 Copy join link', async () => showNotice((await copyText(s.shortLinks?.join ?? s.joinUrl)) ? 'Join link copied.' : 'Could not copy the link.')]] : []),
    ['📱 Show join QR code', () => socket.send({ t: 'show-join', shown: true })],
    ...(s.canEndRound ? [['⏭ End round', () => endRound(s)]] : []),
    ...(s.canEnd ? [[s.phase === 'finished' ? '⏎ Back to quizzes' : '⏹ End quiz', () => endQuiz(s)]] : []),
    ['🔑 New host key', () => {
      if (confirm('Make a new host key? The old host link and the TV screen stop working until you open the new TV link.')) socket.send({ t: 'rotate-key' });
    }],
  ];
  return h(
    'span',
    { class: 'break-menu-wrap more-menu-wrap' },
    h('button', { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': String(moreOpen), title: 'More actions', 'aria-label': 'More actions', onclick: () => { moreOpen = !moreOpen; render(); } }, isPhone() ? '⋯' : '⋯ More'),
    moreOpen
      ? h('div', { class: 'break-menu', role: 'menu' }, items.map(([label, run]) => h('button', { role: 'menuitem', onclick: () => { moreOpen = false; run(); render(); } }, label)))
      : null,
  );
}

function breakControl(s, compact = false) {
  if (TV || s.onBreak || !['lobby', 'reveal', 'leaderboard'].includes(s.phase)) return null;
  const start = (minutes) => {
    breakMenuOpen = false;
    socket.send({ t: 'break', minutes });
  };
  return h(
    'span',
    { class: 'break-menu-wrap' },
    h('button', { 'aria-haspopup': 'true', 'aria-expanded': String(breakMenuOpen), onclick: () => { breakMenuOpen = !breakMenuOpen; render(); }, title: 'Show a break screen with fun facts', 'aria-label': 'Break' }, compact ? '☕' : '☕ Break'),
    breakMenuOpen
      ? h(
          'div',
          { class: 'break-menu', role: 'menu' },
          [[5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [undefined, 'No timer']].map(([minutes, label]) =>
            h('button', { role: 'menuitem', onclick: () => start(minutes) }, label),
          ),
        )
      : null,
  );
}

/** Wager rounds: what each team bet and whether it paid off. */
function wagerBlock(s) {
  if (!s.wagers?.length) return null;
  return h(
    'ul',
    { class: 'wager-list' },
    s.wagers.map((w) =>
      h(
        'li',
        {},
        h('span', {}, '🎲'),
        h('span', { class: 'name' }, w.name),
        h('span', { class: 'muted' }, w.amount === 0 ? 'bet nothing' : `bet ${w.amount}`),
        w.amount === 0 ? null : h('span', { class: w.won ? 'won' : 'lost' }, `${w.won ? '+' : '−'}${w.amount}`),
      ),
    ),
  );
}

/** The top five, shown with the answer when the next press goes straight on to the next question. */
function miniBoard(s) {
  const top = s.standings.slice(0, 5);
  if (top.length === 0) return null;
  return h(
    'div',
    {},
    h('p', { class: 'mini-board-title' }, 'Top of the table'),
    h(
      'ol',
      { class: 'mini-board' },
      top.map((row) =>
        h('li', {}, h('span', { class: 'rank' }, ordinal(row.rank)), avatar(row.name, row.photo, 30), h('span', { class: 'name' }, row.name), movement(row), h('span', { class: 'score' }, row.score)),
      ),
    ),
  );
}

/** The quickest correct teams, with what the speed bonus gave them. */
function fastestBlock(s) {
  const names = ['Fastest', '2nd fastest', '3rd fastest'];
  if (s.fastest?.length) {
    return h(
      'ul',
      { class: 'fastest' },
      s.fastest.map((f) =>
        h('li', {}, h('span', { class: 'bolt' }, '⚡'), avatar(f.name, f.photo, 44), h('span', { class: 'fastest-name' }, f.name), h('span', { class: 'muted' }, `${names[f.place - 1]} · ${seconds(f.ms)}`), h('span', { class: 'gained' }, `+${f.points}`)),
      ),
    );
  }
  // No speed bonus on this quiz: still name the quickest right answer.
  if (!s.speedster) return null;
  return h(
    'ul',
    { class: 'fastest' },
    h('li', {}, h('span', { class: 'bolt' }, '⚡'), avatar(s.speedster.name, s.speedster.photo, 44), h('span', { class: 'fastest-name' }, s.speedster.name), h('span', { class: 'muted' }, `Fastest right answer · ${seconds(s.speedster.ms)}`)),
  );
}

/** "+950" and an arrow for how far a team moved. */

/** Teams on the podium: everyone ranked 1st to 3rd, so ties are never left off. */
function podiumSize(standings) {
  return standings.filter((row) => row.rank <= 3).length;
}

function podium(standings) {
  const places = [2, 1, 3]; // Shown 2nd, 1st, 3rd, with the winner in the middle.
  return h(
    'div',
    { class: 'podium' },
    places.map((place) => {
      const teams = standings.filter((row) => row.rank === place);
      if (teams.length === 0) return h('div', { class: 'podium-spot empty' });
      return h(
        'div',
        { class: `podium-spot place-${place}` },
        h(
          'div',
          { class: 'podium-names' },
          teams.map((t) =>
            h('div', { class: 'podium-team' }, avatar(t.name, t.photo, teams.length === 1 ? (place === 1 ? 110 : 84) : 56), h('div', { class: 'podium-name' }, t.name)),
          ),
        ),
        h('div', { class: 'podium-score' }, `${teams[0].score} pts`),
        h('div', { class: 'podium-step' }, ordinal(place)),
      );
    }),
  );
}

/** Pause, add time and skip, for the question in progress. */
/** Ends the round early, after checking: whatever is on screen unrevealed and the rest of the round are skipped. */
function endRound(s) {
  const revealed = s.phase === 'reveal';
  const ok = confirm(
    revealed
      ? 'End this round now? The rest of its questions are skipped and the round leaderboard shows.'
      : 'End this round now? The question on screen and the rest of the round are skipped (nobody scores on them) and the round leaderboard shows.',
  );
  if (ok) socket.send({ t: 'end-round' });
}

function questionControls(s) {
  const q = s.question;
  if (s.phase === 'reveal' && s.canEndRound) {
    return h('div', { class: 'question-controls' }, h('button', { class: 'danger', onclick: () => endRound(s), title: 'Skip the rest of this round and show its leaderboard' }, '⏭ End round'));
  }
  if (s.phase !== 'open' && s.phase !== 'closed') return null;
  return h(
    'div',
    { class: 'question-controls' },
    s.phase === 'open'
      ? [
          // While a team is answering a Buzzin' question the clock is held by the game; judging them releases it.
          s.buzzers?.some((b) => b.status === 'answering')
            ? null
            : h('button', { onclick: () => socket.send({ t: q.paused ? 'resume' : 'pause' }), title: 'P' }, q.paused ? '▶ Resume' : '⏸ Pause'),
          h('button', { onclick: () => socket.send({ t: 'extend', seconds: 10 }) }, '+10 s'),
        ]
      : null,
    h(
      'button',
      {
        class: 'danger',
        title: 'Throw this question away: nobody scores on it',
        onclick: () => confirm('Skip this question? Nobody scores on it.') && socket.send({ t: 'skip' }),
      },
      'Skip question',
    ),
    s.canEndRound ? h('button', { class: 'danger', onclick: () => endRound(s), title: 'Skip the rest of this round and show its leaderboard' }, '⏭ End round') : null,
  );
}

function answerProgress(s) {
  const total = Math.max(s.connectedCount, 1);
  return h(
    'div',
    { class: 'progress-wrap' },
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(s.answeredCount) },
      h('div', { class: 'progress-fill', style: `width: ${Math.min(100, (s.answeredCount / total) * 100)}%` })),
    h('p', { class: 'muted center' }, `${s.answeredCount} of ${s.connectedCount} connected teams answered`),
  );
}

function timerBar(q) {
  if (q.remainingMs == null) return null;
  const total = q.seconds * 1000;
  // Start part-way through the animation, so the bar is right after any re-render.
  // While the host has the clock paused the bar is held at that frame, then carries on from it.
  return h(
    'div',
    { class: 'timer-bar' },
    h('div', { class: 'timer-fill', style: `animation-duration: ${total}ms; animation-delay: -${Math.max(0, total - q.remainingMs)}ms; animation-play-state: ${q.paused ? 'paused' : 'running'}` }),
  );
}

function questionBody(s, q, reveal) {
  switch (q.type) {
    case 'multiple-choice':
      return h(
        'div',
        { class: `options ${optionsSize(q.options)}` },
        q.options.map((option, i) =>
          h(
            'div',
            {
              class: `option opt-${i}${reveal ? (i === q.answer ? ' correct' : ' dimmed') : !TV && s.phase === 'closed' ? (i === q.answer ? ' marked-correct' : ' pickable') : ''}`,
              // Time's up: the host can click a different option to change which one is right, before revealing.
              onclick: !TV && s.phase === 'closed' ? () => socket.send({ t: 'set-answer', value: i }) : undefined,
              title: !TV && s.phase === 'closed' ? (i === q.answer ? 'The current answer' : 'Click to make this the answer') : undefined,
            },
            h('span', { class: 'letter' }, LETTERS[i]),
            h('span', { class: 'option-text' }, option),
            s.distribution ? h('span', { class: 'count' }, s.distribution[i]) : null,
          ),
        ),
      );

    case 'ordering':
      return h(
        'div',
        {},
        h(
          'ol',
          { class: 'order-list' },
          (reveal ? q.answerText.split(' → ') : q.items).map((item) => h('li', {}, item)),
        ),
        reveal ? null : h('p', { class: 'muted center' }, 'Teams put these in order.'),
        s.summary ? h('p', { class: 'center big' }, s.summary) : null,
      );

    case 'buzzer': {
      const current = s.buzzers?.find((b) => b.status === 'answering');
      const winner = s.buzzers?.find((b) => b.status === 'right');
      return h(
        'div',
        {},
        h('p', { class: 'muted center' }, 'Teams buzz in. The first to buzz answers out loud.'),
        current
          ? h(
              'div',
              { class: 'buzz-card live' },
              h('p', { class: 'muted' }, 'Buzzed first'),
              h('p', { class: 'who' }, current.name),
              TV ? h('p', { class: 'muted' }, 'is answering…') : h('p', { class: 'answer-for-host' }, 'Looking for: ', h('strong', {}, q.answerText)),
              TV
                ? null
                : h(
                    'div',
                    { class: 'judge-buttons' },
                    h('button', { class: 'right', onclick: () => socket.send({ t: 'judge', correct: true }), title: 'Y' }, '✓ Correct'),
                    h('button', { class: 'wrong', onclick: () => socket.send({ t: 'judge', correct: false }), title: 'N' }, '✗ Wrong'),
                  ),
            )
          : winner
            ? h('div', { class: 'buzz-card' }, h('p', { class: 'muted' }, 'Got it'), h('p', { class: 'who' }, winner.name))
            : s.phase === 'open'
              ? h('div', { class: 'buzz-card' }, h('p', { class: 'who muted' }, 'Waiting for a buzz…'))
              : null,
        reveal ? h('p', { class: 'center big answer-reveal' }, 'Answer: ', h('strong', {}, q.answerText)) : null,
        s.buzzers?.length
          ? h(
              'ul',
              { class: 'buzz-list' },
              s.buzzers.map((b) =>
                h(
                  'li',
                  {},
                  h('span', { class: b.status === 'right' ? 'right' : b.status === 'wrong' ? 'wrong' : 'muted' }, { right: '✓', wrong: '✗', answering: '🔔', queued: '⏳' }[b.status]),
                  h('span', { class: 'name' }, b.name),
                  h('span', { class: 'muted' }, { right: 'Correct', wrong: 'Wrong', answering: 'Answering', queued: 'Waiting' }[b.status]),
                ),
              ),
            )
          : null,
      );
    }

    case 'number':
    case 'nearest':
      return h(
        'div',
        { class: 'center' },
        h('p', { class: 'muted' }, q.type === 'nearest' ? 'Teams type a number. The closest guess wins.' : 'Teams type a number.'),
        reveal ? h('p', { class: 'center big answer-reveal' }, 'Answer: ', h('strong', {}, q.answerText)) : null,
        q.info && reveal ? h('p', { class: 'muted info' }, q.info) : null,
        s.summary ? h('p', { class: 'letter-counts' }, h('span', {}, s.summary)) : null,
        s.guesses?.length
          ? h(
              'ul',
              { class: 'guesses' },
              s.guesses.map((g) =>
                h('li', { class: g.winner ? 'win' : '' }, h('strong', {}, g.value), h('span', { class: 'muted' }, g.off), h('span', { class: 'guess-teams' }, g.teams.join(', '))),
              ),
            )
          : null,
      );

    case 'letter':
      return h(
        'div',
        { class: 'center' },
        h('p', { class: 'muted' }, 'Teams tap the first letter of the answer.'),
        reveal ? h('p', { class: 'letter-reveal' }, h('span', { class: 'big-letter' }, q.answerText[0]), q.answerText.slice(3)) : null,
        s.summary ? h('p', { class: 'letter-counts' }, s.summary.split(/\s{2,}/).map((count) => h('span', {}, count))) : null,
      );

    case 'picture':
    case 'music':
      if (s.phase === 'open') return null;
      return h(
        'div',
        {},
        reveal ? h('p', { class: 'center big answer-reveal' }, 'Answer: ', h('strong', {}, q.answerText)) : null,
        s.phase === 'closed' && !TV ? reviewPanel(s, q) : null,
      );
  }
  return null;
}

/** Typed answers, grouped, for the host to tick or untick before revealing. */
function reviewPanel(s, q) {
  if (!s.review?.length) return h('p', { class: 'center muted' }, 'No answers to mark.');
  return h(
    'div',
    { class: 'review' },
    h(
      'p',
      { class: 'review-help' },
      'Mark the answers, then reveal. Accepted: ',
      h('strong', {}, q.answerText),
      '. Exact and close matches start ticked.',
    ),
    h(
      'ul',
      {},
      s.review.map((group) =>
        h(
          'li',
          { class: group.correct ? 'is-correct' : 'is-wrong' },
          h(
            'button',
            {
              class: 'mark',
              'aria-pressed': String(group.correct),
              title: group.correct ? 'Marked right. Click to mark wrong.' : 'Marked wrong. Click to mark right.',
              onclick: () => socket.send({ t: 'mark', key: group.key, correct: !group.correct }),
            },
            group.correct ? '✓' : '✗',
          ),
          h('span', { class: 'review-text' }, group.text),
          group.match === 'close' ? h('span', { class: 'tag' }, 'close match') : null,
          h('span', { class: 'review-teams muted' }, group.teams.join(', ')),
        ),
      ),
    ),
  );
}

/** The entry fee, large, for the TV start screen. */
/** The teams that have joined, popping onto the TV's wait screen one by one. */
const seenOnTv = new Set();
function tvTeams(s) {
  if (s.teamsHidden || !s.teams.length) return null;
  const chips = s.teams.map((t) => {
    const fresh = !seenOnTv.has(t.id);
    seenOnTv.add(t.id);
    return h('li', { class: `tv-team${fresh ? ' fresh' : ''}${t.connected ? '' : ' offline'}` }, avatar(t.name, t.photo, 40), h('span', { class: 'tv-team-name' }, t.name));
  });
  return h('div', { class: 'tv-teams' }, h('p', { class: 'tv-teams-title' }, `${s.teams.length} ${s.teams.length === 1 ? 'team' : 'teams'} in`), h('ul', {}, chips));
}

function entryFeeBanner(s) {
  if (!s.entryFee) return null;
  return h('p', { class: 'entry-fee big' }, '💷 Entry fee: ', h('strong', {}, s.entryFee), s.requireAdmission ? h('span', { class: 'muted' }, ' · pay the quiz master to get in') : null);
}

/** The optional entry fee, and whether teams must be admitted (once they've paid), set on the start screen. */
let feeTimer;
/** "£5 per team" back into its parts. Anything else (an older free-text fee) shows as no amount. */
function parseFee(text) {
  const m = /^£?\s*(\d{1,4})\s*(?:per\s+(person|team))?/i.exec(text ?? '');
  return { amount: m ? m[1] : '', unit: (m?.[2] ?? 'person').toLowerCase() };
}

function entryFeeEditor(s) {
  const { amount, unit } = parseFee(s.entryFee);
  // The fee is always pounds, a whole number, and per team or per person: the app words it as "£5 per team".
  const send = () => {
    const digits = (document.querySelector('.fee-amount')?.value ?? '').replace(/\D/g, '').slice(0, 4);
    const per = document.querySelector('.fee-unit')?.value === 'team' ? 'team' : 'person';
    const fee = digits === '' ? '' : `£${Number(digits)} per ${per}`;
    if (fee !== (state?.entryFee ?? '')) socket.send({ t: 'set-entry-fee', fee });
  };
  return h(
    'fieldset',
    { class: 'prizes-editor fee-editor' },
    h('legend', {}, 'Entry fee (optional)'),
    h(
      'div',
      { class: 'fee-row' },
      h('span', { class: 'fee-currency', 'aria-hidden': 'true' }, '£'),
      h('input', {
        class: 'fee-amount',
        'data-keep': 'entry-fee',
        type: 'text',
        inputmode: 'numeric',
        pattern: '[0-9]*',
        maxlength: '4',
        placeholder: '0',
        'aria-label': 'Entry fee in pounds, a whole number',
        value: amount,
        oninput: (e) => {
          // Whole pounds only: anything that is not a digit is dropped as it is typed.
          const clean = e.target.value.replace(/\D/g, '').slice(0, 4);
          if (clean !== e.target.value) e.target.value = clean;
          clearTimeout(feeTimer);
          feeTimer = setTimeout(send, 400);
        },
        onblur: () => {
          clearTimeout(feeTimer);
          send();
        },
      }),
      h(
        'select',
        { class: 'fee-unit', 'aria-label': 'Charged per team or per person', onchange: send },
        h('option', { value: 'person', selected: unit === 'person' }, 'per person'),
        h('option', { value: 'team', selected: unit === 'team' }, 'per team'),
      ),
    ),
    s.entryFee && !amount ? h('p', { class: 'muted small' }, `Currently: ${s.entryFee}. Type an amount to replace it.`) : null,
    h(
      'label',
      { class: 'check', title: 'New teams wait on their phone until you press Admit, so you can check they have paid.' },
      h('input', { type: 'checkbox', checked: s.requireAdmission, onchange: (e) => socket.send({ t: 'require-admission', on: e.target.checked }) }),
      ' Teams wait to be admitted (tick once they have paid)',
    ),
  );
}

/** Teams that have joined and are waiting for the host to confirm payment. */
function pendingPanel(s) {
  if (TV || !s.pendingTeams?.length) return null;
  return h(
    'div',
    { class: 'pending-teams' },
    h('h3', { class: 'panel-heading pending-heading' }, `Waiting to be admitted (${s.pendingTeams.length})`),
    h(
      'ul',
      {},
      s.pendingTeams.map((t) =>
        h(
          'li',
          { class: t.connected ? '' : 'offline' },
          h('span', { class: 'dot', 'aria-label': t.connected ? 'connected' : 'disconnected' }),
          h('span', { class: 'name' }, t.name),
          h('button', { type: 'button', class: 'primary admit', onclick: () => socket.send({ t: 'admit', teamId: t.id }) }, 'Admit'),
          h('button', { type: 'button', class: 'kick', title: `Turn ${t.name} away`, 'aria-label': `Turn ${t.name} away`, onclick: () => confirm(`Turn "${t.name}" away?`) && socket.send({ t: 'kick', teamId: t.id }) }, '×'),
        ),
      ),
    ),
    s.pendingTeams.length > 1 ? h('button', { type: 'button', class: 'admit-all', onclick: () => socket.send({ t: 'admit-all' }) }, 'Admit all') : null,
  );
}

/** The optional prizes for 1st to 3rd, typed on the start screen and shown to everyone as they type. */
let prizeTimer;
function prizesEditor(s) {
  const current = [0, 1, 2].map((i) => s.prizes?.[i] ?? '');
  const send = () => {
    const values = [...document.querySelectorAll('.prize-input')].map((input) => input.value);
    // A redraw can blur a box; only save when the text really differs from what the game has.
    const saved = [0, 1, 2].map((i) => state?.prizes?.[i] ?? '');
    if (values.every((v, i) => v.trim() === saved[i])) return;
    socket.send({ t: 'set-prizes', prizes: values });
  };
  return h(
    'fieldset',
    { class: 'prizes-editor' },
    h('legend', {}, 'Prizes (optional)'),
    [0, 1, 2].map((i) =>
      h(
        'label',
        {},
        h('span', { class: 'prize-medal' }, MEDALS[i]),
        h('input', {
          class: 'prize-input',
          'data-keep': `prize-${i}`,
          maxlength: '60',
          placeholder: ['1st prize', '2nd prize', '3rd prize'][i],
          'aria-label': ['First', 'Second', 'Third'][i] + ' prize',
          value: current[i],
          oninput: () => {
            clearTimeout(prizeTimer);
            prizeTimer = setTimeout(send, 400);
          },
          onblur: () => {
            clearTimeout(prizeTimer);
            send();
          },
        }),
      ),
    ),
  );
}

/** Redraws the page without dropping what the host is in the middle of typing. */
function keepFocus(draw) {
  const el = document.activeElement;
  const id = el?.dataset?.keep;
  const value = el?.value;
  const at = el?.selectionStart;
  draw();
  if (!id) return;
  const next = document.querySelector(`[data-keep="${id}"]`);
  if (!next) return;
  next.value = value;
  next.focus();
  if (at != null) next.setSelectionRange(at, at);
}

// Settings: where the quizzes, clips and branding are kept.
let settingsOpen = false;
let settingsInfo = null;
let settingsDraft = '';
let settingsCopy = true;
let settingsNote = '';
let settingsError = '';

async function openSettings() {
  settingsOpen = true;
  settingsNote = '';
  settingsError = '';
  render();
  try {
    settingsInfo = await api('GET', '/settings');
    settingsDraft = settingsInfo.libraryDir;
  } catch (error) {
    settingsError = error.message;
  }
  render();
}

async function saveSettings() {
  settingsNote = '';
  settingsError = '';
  try {
    const result = await api('POST', '/settings', { libraryDir: settingsDraft, copy: settingsCopy });
    settingsNote = `Saved. ${result.copied ? `${result.copied} items copied to ${result.dir}. ` : ''}Close this program and start it again to use ${result.dir}.`;
  } catch (error) {
    settingsError = error.message;
  }
  render();
}

const SOURCE_TEXT = {
  option: 'set when the program was started (--quizzes)',
  environment: 'set by the PUBQUIZ_HOME setting',
  saved: 'chosen in this Settings panel',
  default: 'the default',
};

function settingsOverlay() {
  if (TV || !settingsOpen) return null;
  const close = () => {
    settingsOpen = false;
    render();
  };
  const fixed = settingsInfo && (settingsInfo.source === 'option' || settingsInfo.source === 'environment');
  return h(
    'div',
    { class: 'codes-overlay', role: 'dialog', 'aria-label': 'Settings', onclick: (e) => e.target === e.currentTarget && close() },
    h(
      'div',
      { class: 'codes-card settings-card' },
      h('div', { class: 'codes-head' }, h('h2', {}, '⚙ Settings'), h('button', { type: 'button', onclick: close }, 'Close')),
      settingsInfo === null && !settingsError ? h('p', { class: 'muted' }, 'Loading…') : null,
      settingsInfo
        ? [
            h('h3', {}, 'Where your quizzes are kept'),
            h('p', { class: 'muted' }, 'Quizzes, pictures, sound clips, branding and saved games all live in one folder, so it is the one thing to back up or copy to another computer.'),
            h('p', {}, h('strong', { class: 'folder-path' }, settingsInfo.libraryDir), h('span', { class: 'muted' }, ` (${SOURCE_TEXT[settingsInfo.source]})`)),
            ...(fixed
              ? [h('p', { class: 'muted' }, 'This one cannot be changed here. Start the program without that setting to choose a folder in the app.')]
              : [
                  h('label', {}, 'Use this folder instead', h('input', { class: 'folder-input', 'data-keep': 'settings-folder', value: settingsDraft, spellcheck: 'false', placeholder: settingsInfo.defaultDir, oninput: (e) => { settingsDraft = e.target.value; } })),
                  h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: settingsCopy, onchange: (e) => { settingsCopy = e.target.checked; } }), ' Copy my current quizzes, clips and branding there first (recommended)'),
                  h('div', { class: 'settings-actions' }, h('button', { type: 'button', class: 'primary', onclick: saveSettings }, 'Save folder')),
                  h('p', { class: 'muted small' }, 'The change applies the next time you start the program. Your current folder is left as it is.'),
                ]),
          ]
        : null,
      settingsNote ? h('p', { class: 'settings-note', role: 'status' }, settingsNote) : null,
      settingsError ? h('p', { class: 'error', role: 'alert' }, settingsError) : null,
    ),
  );
}

// The soundboard: clips the host can play whenever they like, here or on the TV.
let clipsOpen = false;
let clipList = null;
let clipFilter = '';
let clipBusy = '';
const soundboard = new Audio();
let playingClip = '';
for (const event of ['play', 'pause', 'ended']) {
  soundboard.addEventListener(event, () => {
    if (event !== 'play') playingClip = '';
    else playingClip = decodeURIComponent((soundboard.src.match(/\/clip\/([^?]+)/) ?? [])[1] ?? '');
    if (clipsOpen) render();
  });
}

async function loadClips() {
  try {
    clipList = await api('GET', '/clips');
  } catch (error) {
    clipList = [];
    showNotice(error.message);
  }
  render();
}

function openClips() {
  clipsOpen = true;
  if (clipList === null) void loadClips();
  else render();
}

function closeClips() {
  clipsOpen = false;
  render();
}

function playHere(clip) {
  if (playingClip === clip.name) {
    soundboard.pause();
    return;
  }
  soundboard.src = `/clip/${encodeURIComponent(clip.name)}?key=${encodeURIComponent(key)}`;
  void soundboard.play().catch(() => showNotice('The browser blocked the sound. Click anywhere on the page, then try again.'));
}

async function uploadClips(files) {
  for (const file of files) {
    clipBusy = `Adding ${file.name}…`;
    render();
    try {
      await api('POST', `/clips?name=${encodeURIComponent(file.name)}`, file);
    } catch (error) {
      showNotice(`${file.name}: ${error.message}`);
    }
  }
  clipBusy = '';
  await loadClips();
}

const CLIPS_HERE_STORAGE = 'pubquiz.clips-play-here';
/** Whether the clips list offers "play on this device". Saved per device; a phone remote has it off until asked, since the sound should come from the TV. */
function clipsPlayHere() {
  try {
    const saved = localStorage.getItem(CLIPS_HERE_STORAGE);
    if (saved !== null) return saved === '1';
  } catch {
    // Fall through to the default.
  }
  return !isPhone();
}
function setClipsPlayHere(on) {
  try {
    localStorage.setItem(CLIPS_HERE_STORAGE, on ? '1' : '0');
  } catch {
    // The choice just lasts until the page is reloaded.
  }
  if (!on) soundboard.pause();
}

/** The soundboard panel: search, play here or on the TV, add and delete clips. */
function clipsOverlay() {
  if (TV || !clipsOpen) return null;
  const needle = clipFilter.trim().toLowerCase();
  const shown = (clipList ?? []).filter((c) => !needle || c.title.toLowerCase().includes(needle));
  const playHereOn = clipsPlayHere();
  // On a phone remote (play-here off) the clip's name is itself the button that plays it on the TV.
  const tapToPlay = isPhone() && !playHereOn;
  return h(
    'div',
    { class: 'codes-overlay clips-overlay', role: 'dialog', 'aria-label': 'Clips', onclick: (e) => e.target === e.currentTarget && closeClips() },
    h(
      'div',
      { class: 'codes-card clips-card' },
      h(
        'div',
        { class: 'codes-head' },
        h('h2', {}, '🎵 Clips'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', onclick: () => { soundboard.pause(); socket.send({ t: 'stop-clips' }); }, title: 'Stop the sound here and on the TV' }, '⏹ Stop all'),
        h('button', { type: 'button', onclick: closeClips }, 'Close'),
      ),
      h(
        'div',
        { class: 'clips-tools' },
        h('input', { type: 'search', class: 'library-search', 'data-keep': 'clip-search', placeholder: `Search ${(clipList ?? []).length} clips`, 'aria-label': 'Search clips', value: clipFilter, oninput: (e) => { clipFilter = e.target.value; render(); } }),
        h('label', { class: 'button' }, '+ Add clips', h('input', { type: 'file', accept: 'audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,.mp3,.m4a,.aac,.ogg,.opus,.wav', multiple: true, hidden: true, onchange: (e) => e.target.files.length && uploadClips([...e.target.files]) })),
      ),
      h(
        'label',
        { class: 'check', title: 'Off: clips only play on the TV screen. On: each clip also has a button that plays it on this device.' },
        h('input', { type: 'checkbox', checked: playHereOn, onchange: (e) => { setClipsPlayHere(e.target.checked); render(); } }),
        ' Show “play on this device”',
      ),
      clipBusy ? h('p', { class: 'muted' }, clipBusy) : null,
      clipList === null ? h('p', { class: 'muted' }, 'Loading…') : null,
      clipList && clipList.length === 0 ? h('p', { class: 'muted' }, 'No clips yet. Add mp3, m4a, ogg or wav files (up to 20 MB each) and play them whenever you like.') : null,
      clipList && clipList.length > 0 && shown.length === 0 ? h('p', { class: 'muted' }, `No clips match “${clipFilter.trim()}”.`) : null,
      h(
        'ul',
        { class: 'clips-list' },
        shown.map((clip) =>
          h(
            'li',
            { class: playingClip === clip.name ? 'playing' : '' },
            tapToPlay
              ? h('button', { type: 'button', class: 'clip-tap', title: 'Play on the TV screen (its 🔊 sound must be on)', onclick: () => socket.send({ t: 'play-clip', name: clip.name }) }, clip.title)
              : h('span', { class: 'clip-name' }, clip.title),
            playHereOn ? h('button', { type: 'button', class: 'primary', onclick: () => playHere(clip), title: 'Play on this device' }, playingClip === clip.name ? '⏸ Stop' : '▶ Play') : null,
            tapToPlay ? null : h('button', { type: 'button', class: playHereOn ? '' : 'primary', onclick: () => socket.send({ t: 'play-clip', name: clip.name }), title: 'Play on the TV screen (its 🔊 sound must be on)' }, playHereOn ? '📺 TV' : '📺 Play'),
            isPhone() ? null : h('button', { type: 'button', class: 'kick', 'aria-label': `Delete ${clip.title}`, title: 'Delete this clip', onclick: async () => {
              if (!confirm(`Delete the clip “${clip.title}”?`)) return;
              try {
                await api('DELETE', `/clips/${encodeURIComponent(clip.name)}`);
              } catch (error) {
                showNotice(error.message);
              }
              await loadClips();
            } }, '🗑'),
          ),
        ),
      ),
    ),
  );
}

let codesOpen = false;

/** A big, easy-to-read list of every team and its rejoin code, for when a phone dies or someone changes device. */
let hostQrOpen = false;

/** A QR code of this host page's own address, to scan with the host's phone. Shows on the laptop only. */
function hostQrOverlay(s) {
  if (TV || !hostQrOpen) return null;
  const close = () => {
    hostQrOpen = false;
    render();
  };
  return h(
    'div',
    { class: 'codes-overlay', role: 'dialog', 'aria-label': 'Host on your phone', onclick: (e) => e.target === e.currentTarget && close() },
    h(
      'div',
      { class: 'codes-card join-card' },
      h('h2', {}, 'Host from your phone'),
      h('img', { class: 'qr', src: `/host-qr.svg?key=${encodeURIComponent(key)}&v=${s.qrVersion ?? 0}`, alt: 'QR code for the host page' }),
      h('p', { class: 'muted' }, 'Scan this with your phone camera. ', s.openHost ? '' : 'The code contains the host key, so keep it to yourself. '),
      h('p', { class: 'muted' }, s.network?.mode === 'tunnel' && s.network.state === 'up' ? 'It uses the internet link, so it works on any network.' : 'It uses this laptop’s Wi-Fi address, so the phone must be on the same Wi-Fi.'),
      h('button', { type: 'button', onclick: close }, 'Close'),
    ),
  );
}

/** The join QR code, put up over the host and TV screens on request (for latecomers) and taken down again. */
function joinOverlay(s) {
  if (!s.showJoin || s.phase === 'lobby' || s.phase === 'idle') return null;
  const close = () => socket.send({ t: 'show-join', shown: false });
  return h(
    'div',
    { class: 'codes-overlay join-overlay', role: 'dialog', 'aria-label': 'Join the quiz', onclick: (e) => !TV && e.target === e.currentTarget && close() },
    h(
      'div',
      { class: 'codes-card join-card' },
      h('img', { class: 'qr', src: `/qr.svg?v=${s.qrVersion}`, alt: `QR code for ${s.joinUrl}` }),
      h('h1', {}, 'Scan to join'),
      h('p', { class: 'big' }, joinText(s)),
      copyButton(() => s.shortLinks?.join ?? s.joinUrl),
      h('p', {}, 'Room code ', h('span', { class: 'room-code' }, s.roomCode)),
      TV ? null : h('button', { type: 'button', onclick: close }, 'Hide QR code'),
    ),
  );
}

let headStartOpen = false;

/** Head starts: seconds taken off a team's answer time, so a slower player (a young child, say) can still win the speed points. */
function headStartOverlay(s) {
  if (TV || !headStartOpen) return null;
  const close = () => {
    headStartOpen = false;
    render();
  };
  const teams = [...s.teams].sort((a, b) => a.name.localeCompare(b.name));
  const set = (team, value) => socket.send({ t: 'head-start', teamId: team.id, seconds: Math.max(0, Math.min(30, Number(value) || 0)) });
  return h(
    'div',
    { class: 'codes-overlay', role: 'dialog', 'aria-label': 'Head starts', onclick: (e) => e.target === e.currentTarget && close() },
    h(
      'div',
      { class: 'codes-card' },
      h('div', { class: 'codes-head' }, h('h2', {}, '⏱ Head starts'), h('button', { type: 'button', onclick: close }, 'Close')),
      h('p', { class: 'muted' }, 'A head start is taken off a team’s answer time when working out who was fastest, so a slower player can still win the speed points. Giving one team 5 seconds has the same effect as adding 5 seconds to every other team. It applies to answers given from now on, and the team still has only the normal time to answer.'),
      teams.length === 0 ? h('p', { class: 'muted' }, 'No teams yet.') : null,
      h(
        'ul',
        { class: 'codes-list head-start-list' },
        teams.map((t) =>
          h(
            'li',
            { class: t.connected ? '' : 'offline' },
            h('span', { class: 'dot' }),
            avatar(t.name, t.photo, 36),
            h('span', { class: 'codes-name' }, t.name),
            h('input', { type: 'number', min: '0', max: '30', step: '0.5', inputmode: 'decimal', class: 'head-start-input', 'data-keep': `hs-${t.id}`, 'aria-label': `Head start for ${t.name}, in seconds`, value: String(t.headStart || 0), onchange: (e) => set(t, e.target.value) }),
            h('span', { class: 'muted' }, 's'),
          ),
        ),
      ),
      teams.some((t) => t.headStart > 0) ? h('button', { type: 'button', onclick: () => teams.forEach((t) => t.headStart > 0 && set(t, 0)) }, 'Clear all head starts') : null,
    ),
  );
}

function codesOverlay(s) {
  if (TV || !codesOpen) return null;
  const close = () => {
    codesOpen = false;
    render();
  };
  const teams = [...s.teams].sort((a, b) => Number(a.connected) - Number(b.connected) || a.name.localeCompare(b.name));
  return h(
    'div',
    { class: 'codes-overlay', role: 'dialog', 'aria-label': 'Team codes', onclick: (e) => e.target === e.currentTarget && close() },
    h(
      'div',
      { class: 'codes-card' },
      h('div', { class: 'codes-head' }, h('h2', {}, 'Team codes'), h('button', { type: 'button', onclick: close }, 'Close')),
      h('p', { class: 'muted' }, 'A team that lost its phone joins on a new one: tap "Already joined? Rejoin with your team code" and type its code. Disconnected teams are at the top.'),
      teams.length === 0 ? h('p', { class: 'muted' }, 'No teams yet.') : null,
      h(
        'ul',
        { class: 'codes-list' },
        teams.map((t) => h('li', { class: t.connected ? '' : 'offline' }, h('span', { class: 'dot' }), avatar(t.name, t.photo, 36), h('span', { class: 'codes-name' }, t.name), h('strong', { class: 'codes-code' }, t.code)),
        ),
      ),
    ),
  );
}

function teamsPanel(s) {
  return h(
    'aside',
    { class: 'teams' },
    pendingPanel(s),
    h('h2', {}, `Teams ${s.teams.length}`),
    s.teams.length === 0 ? h('p', { class: 'muted small' }, 'No teams yet.') : null,
    h(
      'ul',
      {},
      s.teams.map((team) =>
        h(
          'li',
          { class: team.connected ? '' : 'offline', title: team.connected ? 'Connected' : 'Disconnected' },
          h('span', { class: 'dot', 'aria-label': team.connected ? 'connected' : 'disconnected' }),
          avatar(team.name, team.photo, 26),
          h('span', { class: 'name' }, team.name),
          !TV && team.photo ? h('button', { class: 'remove-photo', title: `Remove ${team.name}'s photo`, 'aria-label': `Remove ${team.name}'s photo`, onclick: () => confirm(`Remove ${team.name}'s photo?`) && socket.send({ t: 'remove-photo', teamId: team.id }) }, '🚫') : null,
          !TV && team.code ? h('span', { class: 'team-code-small', title: 'Team code: lets this team carry on from another phone' }, team.code) : null,
          !TV && team.headStart > 0 ? h('span', { class: 'head-start-badge', title: `${team.name} has a ${team.headStart} second head start` }, `⏱ ${team.headStart}s`) : null,
          s.phase === 'open' && team.answered ? h('span', { class: 'tick', 'aria-label': 'answered' }, '✓') : null,
          h('span', { class: 'score' }, team.score),
          TV ? null : h(
            'button',
            {
              class: 'kick',
              title: `Remove ${team.name}`,
              'aria-label': `Remove ${team.name}`,
              onclick: () => {
                if (confirm(`Remove "${team.name}" from the quiz? Their score will be lost.`)) {
                  socket.send({ t: 'kick', teamId: team.id });
                }
              },
            },
            '×',
          ),
        ),
      ),
    ),
    TV ? null : h('h3', { class: 'panel-heading' }, 'Options'),
    TV
      ? null
      : h(
          'label',
          { class: 'check max-teams', title: 'The most teams that can join. Changing it never removes a team that is already in. The quiz has been tested with 30.' },
          'Max teams',
          h('input', {
            class: 'max-teams-input',
            'data-keep': 'max-teams',
            type: 'text',
            inputmode: 'numeric',
            pattern: '[0-9]*',
            maxlength: '3',
            'aria-label': 'Most teams that can join',
            value: String(s.maxTeams),
            oninput: (e) => {
              const clean = e.target.value.replace(/\D/g, '').slice(0, 3);
              if (clean !== e.target.value) e.target.value = clean;
            },
            onchange: (e) => {
              const max = Number(e.target.value);
              if (Number.isInteger(max) && max >= 1) socket.send({ t: 'set-max-teams', max: Math.min(100, max) });
              else e.target.value = String(state?.maxTeams ?? 30);
            },
          }),
        ),
    TV
      ? null
      : h(
          'label',
          { class: 'check photos-toggle', title: 'New teams wait on their phone until you press Admit, so you can check they have paid.' },
          h('input', { type: 'checkbox', checked: s.requireAdmission, onchange: (e) => socket.send({ t: 'require-admission', on: e.target.checked }) }),
          ' Teams wait to be admitted (paid)',
        ),
    // On the start screen the "lock when it starts" box is enough; this one appears once the quiz is under way (or if it is already locked).
    TV || (s.phase === 'lobby' && !s.joiningLocked)
      ? null
      : h(
          'label',
          { class: 'check photos-toggle', title: 'Stop new teams joining. Teams already in can still rejoin with their code.' },
          h('input', { type: 'checkbox', checked: s.joiningLocked, onchange: (e) => socket.send({ t: 'lock-joining', locked: e.target.checked }) }),
          ' 🔒 Lock joining now (no new teams)',
        ),
    TV
      ? null
      : h(
          'label',
          { class: 'check photos-toggle', title: 'Every question waits while you ask it (multiple choice: reveal the answers one by one), then you start the timer' },
          h('input', { type: 'checkbox', checked: s.readOut, onchange: (e) => socket.send({ t: 'read-out', on: e.target.checked }) }),
          ' Ask the question before the timer starts',
        ),
    TV || !s.readOut
      ? null
      : h(
          'label',
          { class: 'check photos-toggle', title: 'Multiple choice: the timer starts by itself when you show the last answer' },
          h('input', { type: 'checkbox', checked: s.startOnLastAnswer, onchange: (e) => socket.send({ t: 'start-on-last', on: e.target.checked }) }),
          ' Start the timer on the last answer',
        ),
    TV
      ? null
      : h(
          'label',
          { class: 'check photos-toggle', title: 'Off: the timer always counts down to zero, even when every team has answered' },
          h('input', { type: 'checkbox', checked: s.closeEarly, onchange: (e) => socket.send({ t: 'close-early', on: e.target.checked }) }),
          ' Close early when all have answered',
        ),
    TV
      ? null
      : h(
          'label',
          { class: 'check photos-toggle', title: 'Off: the TV shows the countdown but not the question, so a delay between the TV and the phones cannot help anyone. The answer still shows on the TV.' },
          h('input', { type: 'checkbox', checked: s.tvShowQuestions, onchange: (e) => socket.send({ t: 'tv-questions', visible: e.target.checked }) }),
          ' Show questions on the TV',
        ),
    TV
      ? null
      : h(
          'label',
          { class: 'check photos-toggle', title: 'Let teams add a photo that shows on the screens' },
          h('input', { type: 'checkbox', checked: s.photosEnabled, onchange: (e) => socket.send({ t: 'photos', enabled: e.target.checked }) }),
          ' Team photos',
        ),
    TV ? null : h('button', { type: 'button', class: 'codes-button', onclick: () => { headStartOpen = true; render(); }, title: 'Take seconds off a slower player’s answer time, so they can still win the speed points' }, '⏱ Head starts'),
    TV ? null : h('button', { type: 'button', class: 'codes-button', onclick: () => { codesOpen = true; render(); } }, '🔑 Team codes'),
  );
}

void start();
