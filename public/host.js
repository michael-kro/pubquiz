import { avatar, brandBlock, brandLogo, breakPanel, connectSocket, flashSpeedster, MEDALS, movement, optionsSize, prizeList, questionMeta, questionPicture, rollStandings, seconds, textSize, h, LETTERS, loadBranding, ordinal, preload, setBreak, setDeadline, tick } from './common.js';
import { mountBranding } from './branding.js';
import { mountEditor } from './editor.js';

const app = document.getElementById('app');
const statusBanner = document.getElementById('status');
/** The TV screen: the same page without any controls, and without answers before the reveal. */
const TV = document.body.classList.contains('tv');
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

async function loadLibrary() {
  try {
    library = { items: await api('GET', '/quizzes'), error: '' };
  } catch (error) {
    library = { items: library.items, error: error.message };
  }
  render();
}

let socket = null;

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
        if (message.view.phase === 'idle' && state?.phase !== 'idle' && message.view.library) void loadLibrary();
        playSoundsFor(state, message.view);
        state = message.view;
        setDeadline(state.question?.remainingMs, state.question?.paused);
        setBreak(state.onBreak);
        if (TV) flashSpeedster(state, true);
        preload(state.preloadImage);
        if (!TV) rememberKey();
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
  if (TV) {
    fatal = 'Open the TV link from the host screen.';
    return render();
  }
  try {
    needPin = (await (await fetch('/login')).json()).pin === true;
  } catch {
    needPin = false;
  }
  if (!needPin) fatal = 'This page needs the host link printed in the terminal when the quiz started.';
  render();
}

async function submitPin(pin) {
  pinError = '';
  try {
    const res = await fetch('/login', { method: 'POST', body: JSON.stringify({ pin }), headers: { 'content-type': 'application/json' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Could not sign in.');
    key = data.key;
    needPin = false;
    rememberKey();
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
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && codesOpen) {
    codesOpen = false;
    render();
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
    keepFocus(() => app.replaceChildren(libraryView(state), notice ? h('div', { class: 'notice', role: 'alert' }, notice) : ''));
    return;
  }
  keepFocus(() => app.replaceChildren(
    h(
      'div',
      { class: `host-layout${TV && state.teamsHidden ? ' no-side' : ''}` },
      topBar(state),
      h('section', { class: 'stage' }, TV ? null : networkBanner(state), stage(state)),
      TV && state.teamsHidden ? null : teamsPanel(state),
    ),
    codesOverlay(state),
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

function networkPill(network) {
  const key = network.mode === 'lan' ? 'lan' : network.state;
  return h('span', { class: `network-pill ${key}`, title: network.message ?? '' }, NETWORK_LABELS[key]);
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
    h(
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
      h('h1', {}, 'Your quizzes'),
      networkPill(s.network),
      h('span', { class: 'spacer' }),
      h('a', { class: 'button', href: '#branding' }, 'Branding'),
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
            { class: `quiz-cards${libraryMode === 'list' ? ' as-list' : ''}` },
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
                  h('a', { class: 'button', href: `/api/quizzes/${q.id}/export.zip?key=${encodeURIComponent(key)}` }, 'Export'),
                  h(
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

function topBar(s) {
  if (TV) {
    return h(
      'header',
      { class: 'host-bar' },
      brandLogo('brand-logo small'),
      h('span', { class: 'quiz-title' }, s.quizTitle),
      h('span', { class: 'join-hint' }, 'Join: ', h('strong', {}, s.joinUrl.replace(/^https?:\/\//, '')), ' · Room ', h('strong', {}, s.roomCode)),
      soundButton(),
    );
  }
  return h(
    'header',
    { class: 'host-bar' },
    s.canEnd
      ? h('button', { type: 'button', class: 'logo-home', title: 'Back to your quizzes', 'aria-label': 'Back to your quizzes', onclick: () => endQuiz(s) }, brandLogo('brand-logo small'))
      : brandLogo('brand-logo small'),
    h('span', { class: 'quiz-title' }, s.quizTitle),
    networkPill(s.network),
    soundButton(),
    h('a', { class: 'button', href: `/screen?key=${encodeURIComponent(s.screenKey)}`, target: '_blank', rel: 'noopener', title: 'Open this on the TV or projector' }, 'TV screen ↗'),
    h('span', { class: 'join-hint' }, s.joiningLocked ? h('strong', {}, '🔒 Closed to new teams') : ['Join: ', h('strong', {}, s.joinUrl.replace(/^https?:\/\//, '')), ' · Room ', h('strong', {}, s.roomCode)]),
    breakControl(s),
    s.pendingTeams?.length ? h('button', { type: 'button', class: 'pending-pill', title: 'Let in every team that is waiting', onclick: () => socket.send({ t: 'admit-all' }) }, `⏳ ${s.pendingTeams.length} waiting · Admit`) : null,
    TV
      ? null
      : h('button', {
          type: 'button',
          class: 'link-button',
          title: 'Make a new host key. The old host link and the TV screen link stop working.',
          onclick: () => {
            if (confirm('Make a new host key? The old host link and the TV screen stop working until you open the new TV link.')) socket.send({ t: 'rotate-key' });
          },
        }, '🔑 New key'),
    !TV && s.phase === 'reveal' && s.skipsLeaderboardNext
      ? h('button', { onclick: () => socket.send({ t: 'leaderboard' }), title: 'Show the full leaderboard first' }, 'Leaderboard')
      : null,
    s.canEnd ? h('button', { class: 'end', onclick: () => endQuiz(s) }, s.phase === 'finished' ? 'Back to quizzes' : 'End quiz') : null,
    h(
      'button',
      { class: 'primary next', onclick: advance, disabled: s.phase === 'finished', title: 'Space or → also works' },
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
          brandBlock(),
          h('h1', {}, 'Scan to join'),
          h('p', { class: 'big' }, s.joinUrl.replace(/^https?:\/\//, '')),
          h('p', {}, 'Room code ', h('span', { class: 'room-code' }, s.roomCode)),
          h('p', { class: 'muted' }, `One phone per team. ${s.teams.length} of ${s.maxTeams} teams joined.`),
          TV ? [entryFeeBanner(s), prizeList(s.prizes, true)] : [entryFeeEditor(s), prizesEditor(s)],
          TV
            ? null
            : h(
                'label',
                { class: 'check', title: 'When you press Start quiz, no new teams can join. Teams already in can still rejoin.' },
                h('input', { type: 'checkbox', checked: s.lockOnStart, onchange: (e) => socket.send({ t: 'lock-on-start', on: e.target.checked }) }),
                ' 🔒 Lock the quiz when it starts (no new teams)',
              ),
          s.network.mode === 'tunnel' && s.network.state === 'starting'
            ? h('p', { class: 'muted small' }, 'Setting up the internet link. Until then, teams need to be on the same Wi-Fi as this laptop.')
            : null,
        ),
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
    h('span', { class: 'muted small' }, 'Only you can see this until you press Reveal answer.'),
  );
}

// The break screen: big fun facts for the TV, and the same (with a way back) for the host.

function breakStage(s) {
  return h('div', { class: 'break-stage' }, brandBlock(), breakPanel(true), TV ? null : h('p', { class: 'muted center' }, 'Press End break (or Space) when you are ready to carry on.'));
}

let breakMenuOpen = false;
document.addEventListener('click', (event) => {
  if (breakMenuOpen && !event.target.closest?.('.break-menu-wrap')) {
    breakMenuOpen = false;
    render();
  }
});

/** The Break button and its choice of lengths, shown between questions. */
function breakControl(s) {
  if (TV || s.onBreak || !['lobby', 'reveal', 'leaderboard'].includes(s.phase)) return null;
  const start = (minutes) => {
    breakMenuOpen = false;
    socket.send({ t: 'break', minutes });
  };
  return h(
    'span',
    { class: 'break-menu-wrap' },
    h('button', { 'aria-haspopup': 'true', 'aria-expanded': String(breakMenuOpen), onclick: () => { breakMenuOpen = !breakMenuOpen; render(); }, title: 'Show a break screen with fun facts' }, '☕ Break'),
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
function questionControls(s) {
  const q = s.question;
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
function entryFeeBanner(s) {
  if (!s.entryFee) return null;
  return h('p', { class: 'entry-fee big' }, '💷 Entry fee: ', h('strong', {}, s.entryFee), s.requireAdmission ? h('span', { class: 'muted' }, ' · pay the quiz master, then you are in') : null);
}

/** The optional entry fee, and whether teams must be admitted (once they've paid), set on the start screen. */
let feeTimer;
function entryFeeEditor(s) {
  return h(
    'fieldset',
    { class: 'prizes-editor fee-editor' },
    h('legend', {}, 'Entry fee (optional)'),
    h(
      'label',
      {},
      h('span', { class: 'prize-medal' }, '💷'),
      h('input', {
        class: 'fee-input',
        'data-keep': 'entry-fee',
        maxlength: '40',
        placeholder: 'e.g. £5 per team',
        'aria-label': 'Entry fee',
        value: s.entryFee ?? '',
        oninput: (e) => {
          clearTimeout(feeTimer);
          const fee = e.target.value;
          feeTimer = setTimeout(() => socket.send({ t: 'set-entry-fee', fee }), 400);
        },
        onblur: (e) => {
          clearTimeout(feeTimer);
          if (e.target.value.trim() !== (state?.entryFee ?? '')) socket.send({ t: 'set-entry-fee', fee: e.target.value });
        },
      }),
    ),
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

let codesOpen = false;

/** A big, easy-to-read list of every team and its rejoin code, for when a phone dies or someone changes device. */
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
    h('h2', {}, `Teams ${s.teams.length}/${s.maxTeams}`),
    TV && s.teamsHidden ? h('p', { class: 'muted' }, `${s.standings.length} ${s.standings.length === 1 ? 'team is' : 'teams are'} playing`) : null,
    s.teams.length === 0 && !s.teamsHidden ? h('p', { class: 'muted small' }, 'No teams yet.') : null,
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
          { class: 'check photos-toggle', title: 'New teams wait on their phone until you press Admit, so you can check they have paid.' },
          h('input', { type: 'checkbox', checked: s.requireAdmission, onchange: (e) => socket.send({ t: 'require-admission', on: e.target.checked }) }),
          ' Teams wait to be admitted (paid)',
        ),
    TV
      ? null
      : h(
          'label',
          { class: 'check photos-toggle', title: 'Stop new teams joining. Teams already in can still rejoin with their code.' },
          h('input', { type: 'checkbox', checked: s.joiningLocked, onchange: (e) => socket.send({ t: 'lock-joining', locked: e.target.checked }) }),
          ' 🔒 Lock the quiz (no new teams)',
        ),
    TV
      ? null
      : h(
          'label',
          { class: 'check photos-toggle', title: 'Show the list of teams on the TV screen' },
          h('input', { type: 'checkbox', checked: s.tvShowTeams, onchange: (e) => socket.send({ t: 'tv-teams', visible: e.target.checked }) }),
          ' Show teams on the TV',
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
          { class: 'check photos-toggle', title: 'Let teams add a photo that shows on the screens' },
          h('input', { type: 'checkbox', checked: s.photosEnabled, onchange: (e) => socket.send({ t: 'photos', enabled: e.target.checked }) }),
          ' Team photos',
        ),
    TV ? null : h('button', { type: 'button', class: 'codes-button', onclick: () => { codesOpen = true; render(); } }, '🔑 Team codes'),
  );
}

void start();
