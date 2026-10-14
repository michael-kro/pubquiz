import { connectSocket, h, LETTERS, ordinal, preload, setDeadline, tick } from './common.js';
import { mountEditor } from './editor.js';

const app = document.getElementById('app');
const statusBanner = document.getElementById('status');
const key = new URLSearchParams(location.search).get('key');

let state = null;
let fatal = key ? null : 'This page needs the host link printed in the terminal when the quiz started.';
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

const socket = key
  ? connectSocket({
      onOpen() {
        socket.send({ t: 'host', key });
      },
      onStatus(connected) {
        statusBanner.hidden = connected || Boolean(fatal);
      },
      onMessage(message) {
        if (message.t === 'state') {
          if (message.view.phase === 'idle' && state?.phase !== 'idle' && message.view.library) void loadLibrary();
          state = message.view;
          setDeadline(state.question?.remainingMs);
          preload(state.preloadImage);
        } else if (message.t === 'error') {
          if (state) showNotice(message.message);
          else {
            fatal = message.message;
            socket.stop();
          }
        }
        render();
      },
    })
  : null;

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
  if (!state || state.phase === 'idle' || editingId() || event.target !== document.body) return;
  if ([' ', 'ArrowRight', 'PageDown', 'Enter'].includes(event.key)) {
    event.preventDefault();
    advance();
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

function render() {
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
  if (state.phase === 'idle') {
    app.replaceChildren(libraryView(state), notice ? h('div', { class: 'notice', role: 'alert' }, notice) : '');
    return;
  }
  app.replaceChildren(
    h(
      'div',
      { class: 'host-layout' },
      topBar(state),
      h('section', { class: 'stage' }, networkBanner(state), stage(state)),
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

function topBar(s) {
  return h(
    'header',
    { class: 'host-bar' },
    h('span', { class: 'quiz-title' }, s.quizTitle),
    networkPill(s.network),
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
        q.type === 'music' ? h('p', { class: 'music-badge' }, '🎵 Music round: play the track now') : null,
        h('h1', { class: 'question-text' }, q.text),
        q.image
          ? h('img', { class: `question-image host-image${s.review ? ' small' : ''}`, src: q.image, alt: '' })
          : null,
        questionBody(s, q, reveal),
        h('p', { class: 'muted center' }, `${s.answeredCount} of ${s.connectedCount} connected teams answered`),
      );
    }

    case 'leaderboard':
    case 'finished': {
      const winners = s.standings.filter((row) => row.rank === 1);
      return h(
        'div',
        {},
        h('h1', { class: 'center' }, s.phase === 'finished' ? 'Final results' : 'Leaderboard'),
        s.phase === 'finished' && winners.length
          ? h('p', { class: 'center big' }, `🏆 ${winners.map((w) => w.name).join(' & ')} ${winners.length > 1 ? 'win' : 'wins'}!`)
          : null,
        h(
          'ol',
          { class: 'standings two-col' },
          s.standings.map((row) =>
            h(
              'li',
              {},
              h('span', { class: 'rank' }, ordinal(row.rank)),
              h('span', { class: 'name' }, row.name),
              h('span', { class: 'score' }, row.score),
            ),
          ),
        ),
      );
    }
  }
  return h('div');
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
        s.phase === 'closed' ? reviewPanel(s, q) : null,
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
          s.phase === 'open' && team.answered ? h('span', { class: 'tick', 'aria-label': 'answered' }, '✓') : null,
          h('span', { class: 'score' }, team.score),
          h(
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

render();
