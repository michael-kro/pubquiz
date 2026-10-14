import { connectSocket, h, LETTERS, ordinal, preload, setDeadline, tick } from './common.js';
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
        preload(state.preloadImage);
        if (!TV) rememberKey();
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
  if (TV || !state || state.phase === 'idle' || editingId() || event.target !== document.body) return;
  if ([' ', 'ArrowRight', 'PageDown', 'Enter'].includes(event.key)) {
    event.preventDefault();
    advance();
  } else if ((event.key === 'p' || event.key === 'P') && state.phase === 'open') {
    socket?.send({ t: state.question?.paused ? 'resume' : 'pause' });
  }
});

function nextLabel(s) {
  const last = s.question && s.question.index + 1 === s.questionCount;
  return {
    lobby: 'Start quiz',
    open: 'Close question',
    closed: 'Reveal answer',
    reveal: 'Show leaderboard',
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
    app.replaceChildren(libraryView(state), notice ? h('div', { class: 'notice', role: 'alert' }, notice) : '');
    return;
  }
  app.replaceChildren(
    h(
      'div',
      { class: 'host-layout' },
      topBar(state),
      h('section', { class: 'stage' }, TV ? null : networkBanner(state), stage(state)),
      teamsPanel(state),
    ),
    notice ? h('div', { class: 'notice', role: 'alert' }, notice) : '',
  );
  tick();
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

function libraryView(s) {
  if (!s.library) {
    return h('section', { class: 'screen center' }, h('h1', {}, 'No quiz running'), h('p', {}, 'Restart the program to run a quiz.'));
  }
  const items = library.items;
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
      h('h1', {}, 'Your quizzes'),
      networkPill(s.network),
      h('span', { class: 'spacer' }),
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
        : h(
            'ul',
            { class: 'quiz-cards' },
            items.map((q) =>
              h(
                'li',
                { class: 'quiz-card' },
                h('h2', {}, q.title),
                h(
                  'p',
                  { class: 'muted' },
                  `${q.rounds} ${q.rounds === 1 ? 'round' : 'rounds'} · ${q.questions} ${q.questions === 1 ? 'question' : 'questions'}`,
                ),
                q.problems
                  ? h('p', { class: 'problem' }, `${q.problems} ${q.problems === 1 ? 'thing' : 'things'} to fix before it can run`)
                  : null,
                q.unfinished ? h('p', { class: 'unfinished' }, `Unfinished: stopped at question ${q.unfinished.question} of ${q.unfinished.total}`) : null,
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

function playSoundsFor(before, after) {
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
      h('span', { class: 'quiz-title' }, s.quizTitle),
      h('span', { class: 'join-hint' }, 'Join: ', h('strong', {}, s.joinUrl.replace(/^https?:\/\//, '')), ' · Room ', h('strong', {}, s.roomCode)),
      soundButton(),
    );
  }
  return h(
    'header',
    { class: 'host-bar' },
    h('span', { class: 'quiz-title' }, s.quizTitle),
    networkPill(s.network),
    soundButton(),
    h('a', { class: 'button', href: `/screen?key=${encodeURIComponent(s.screenKey)}`, target: '_blank', rel: 'noopener', title: 'Open this on the TV or projector' }, 'TV screen ↗'),
    h('span', { class: 'join-hint' }, 'Join: ', h('strong', {}, s.joinUrl.replace(/^https?:\/\//, '')), ' · Room ', h('strong', {}, s.roomCode)),
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
  switch (s.phase) {
    case 'lobby':
      return h(
        'div',
        { class: 'lobby' },
        h('img', { class: 'qr', src: `/qr.svg?v=${s.qrVersion}`, alt: `QR code for ${s.joinUrl}` }),
        h(
          'div',
          {},
          h('h1', {}, 'Scan to join'),
          h('p', { class: 'big' }, s.joinUrl.replace(/^https?:\/\//, '')),
          h('p', {}, 'Room code ', h('span', { class: 'room-code' }, s.roomCode)),
          h('p', { class: 'muted' }, `One phone per team. ${s.teams.length} of ${s.maxTeams} teams joined.`),
          s.network.mode === 'tunnel' && s.network.state === 'starting'
            ? h('p', { class: 'muted small' }, 'Setting up the internet link. Until then, teams need to be on the same Wi-Fi as this laptop.')
            : null,
        ),
      );

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
          h('p', { class: 'question-meta' }, `${q.round} · Question ${q.index + 1} of ${q.total}`),
          s.phase === 'open'
            ? h('span', { class: 'countdown big', 'data-countdown': true })
            : h('span', { class: 'phase-label' }, s.phase === 'closed' ? "Time's up" : 'Answer'),
        ),
        q.paused ? h('p', { class: 'paused-banner', role: 'status' }, '⏸ Paused') : null,
        q.type === 'music' ? h('p', { class: 'music-badge' }, '🎵 Music round: play the track now') : null,
        h('h1', { class: 'question-text' }, q.text),
        q.image
          ? h('img', { class: `question-image host-image${s.review ? ' small' : ''}`, src: q.image, alt: '' })
          : null,
        questionBody(s, q, reveal),
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
        h(
          'h1',
          { class: 'center' },
          final ? 'Final results' : roundBreak ? `End of round ${q.roundNumber}: ${q.round}` : 'Leaderboard',
        ),
        final ? podium(s.standings) : null,
        h(
          'ol',
          { class: 'standings two-col' },
          s.standings.slice(final ? podiumSize(s.standings) : 0).map((row, i) =>
            h(
              'li',
              { style: `animation-delay: ${Math.min(i, 20) * 60}ms` },
              h('span', { class: 'rank' }, ordinal(row.rank)),
              h('span', { class: 'name' }, row.name),
              movement(row),
              h('span', { class: 'score' }, row.score),
            ),
          ),
        ),
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

/** "+950" and an arrow for how far a team moved. */
function movement(row) {
  const parts = [];
  if (row.gained) parts.push(h('span', { class: 'gained' }, `+${row.gained}`));
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
        h('div', { class: 'podium-names' }, teams.map((t) => h('div', { class: 'podium-name' }, t.name))),
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
          h('button', { onclick: () => socket.send({ t: q.paused ? 'resume' : 'pause' }), title: 'P' }, q.paused ? '▶ Resume' : '⏸ Pause'),
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
  return h('div', { class: 'timer-bar' }, h('div', { class: 'timer-fill', style: `animation-duration: ${total}ms; animation-delay: -${Math.max(0, total - q.remainingMs)}ms` }));
}

function questionBody(s, q, reveal) {
  switch (q.type) {
    case 'multiple-choice':
      return h(
        'div',
        { class: 'options' },
        q.options.map((option, i) =>
          h(
            'div',
            { class: `option opt-${i}${reveal ? (i === q.answer ? ' correct' : ' dimmed') : ''}` },
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

function teamsPanel(s) {
  return h(
    'aside',
    { class: 'teams' },
    h('h2', {}, `Teams ${s.teams.length}/${s.maxTeams}`),
    s.teams.length === 0 ? h('p', { class: 'muted small' }, 'No teams yet.') : null,
    h(
      'ul',
      {},
      s.teams.map((team) =>
        h(
          'li',
          { class: team.connected ? '' : 'offline', title: team.connected ? 'Connected' : 'Disconnected' },
          h('span', { class: 'dot', 'aria-label': team.connected ? 'connected' : 'disconnected' }),
          h('span', { class: 'name' }, team.name),
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
  );
}

void start();
