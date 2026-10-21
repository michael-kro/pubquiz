// Practice mode: one learner, one quiz, their own pace. No host, no teams, no clock that stops anything.
// The server keeps the session (practice.ts); this page shows the current question and sends what the learner does.
import { brandBlock, h, LETTER_GROUPS, LETTERS, loadBranding } from './common.js';

const KEY_STORAGE = 'pubquiz.practice.key';
const LEARNER_STORAGE = 'pubquiz.practice.learner';
const hashParams = new URLSearchParams(location.hash.slice(1));

const stored = (name) => {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
};
const store = (name, value) => {
  try {
    if (value === null) localStorage.removeItem(name);
    else localStorage.setItem(name, value);
  } catch {
    // Fine: it just asks again next time.
  }
};

// The key rides in the fragment (#key=…), which browsers never send to any server; once kept, it leaves the address bar.
let key = hashParams.get('key') ?? stored(KEY_STORAGE);
const preselectQuiz = hashParams.get('quiz');
if (hashParams.has('key')) {
  store(KEY_STORAGE, key);
  history.replaceState(null, '', location.pathname);
}

let learner = stored(LEARNER_STORAGE) ?? '';
let screen = learner ? 'home' : 'learner'; // learner | home | question | results
let learners = [];
let quizzes = null;
let overview = null; // { name, current, history }
let results = null;
let picking = preselectQuiz; // quiz id whose options are open
let options = { mode: 'learn', count: 'all', shuffle: false };
let busy = false;
let error = '';
let notice = '';
let noticeTimer;
let reveal = null; // buzzer: the answer, once asked for
let draftText = '';
let draftOrder = [];
let fetchedAt = Date.now();
let locked = false; // the key was refused

const app = document.getElementById('app');
const live = document.getElementById('live');
const blobUrls = new Map();

async function api(method, path, body) {
  const res = await fetch(`/api/practice${path}`, {
    method,
    headers: { 'x-practice-key': key ?? '', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401) {
    locked = true;
    render();
  }
  if (!res.ok) throw new Error(data?.error ?? `Something went wrong (${res.status}).`);
  return data;
}

/** A picture fetched with the key and shown from a blob URL, so the key never sits in an address. */
function imageWithKey(path) {
  if (blobUrls.has(path)) return blobUrls.get(path);
  blobUrls.set(path, '');
  fetch(path, { headers: { 'x-practice-key': key ?? '' } })
    .then((res) => (res.ok ? res.blob() : Promise.reject(new Error('no picture'))))
    .then((blob) => {
      blobUrls.set(path, URL.createObjectURL(blob));
      render();
    })
    .catch(() => blobUrls.set(path, ''));
  return '';
}

function showNotice(text) {
  notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = '';
    render();
  }, 3500);
  render();
}

const say = (text) => {
  if (live) live.textContent = text;
};

async function act(fn) {
  if (busy) return;
  busy = true;
  error = '';
  render();
  try {
    await fn();
  } catch (e) {
    error = e.message;
  } finally {
    busy = false;
    render();
  }
}

async function refresh() {
  if (!learner) return;
  overview = await api('GET', `/learners/${encodeURIComponent(learner)}`);
  fetchedAt = Date.now();
  if (overview.current) {
    if (screen !== 'question') resetDrafts();
    screen = 'question';
  } else if (screen === 'question') screen = 'home';
  if (quizzes === null) quizzes = await api('GET', '/quizzes');
}

function resetDrafts() {
  draftText = '';
  draftOrder = [];
  reveal = null;
}

/** Sends one action on the current session and shows what came back. */
const doAction = (action, body) =>
  act(async () => {
    const before = overview?.current?.question?.index;
    const data = await api('POST', `/learners/${encodeURIComponent(learner)}/current/${action}`, body ?? {});
    if (action === 'finish') {
      results = data;
      overview = { ...overview, current: null };
      screen = 'results';
      await refresh().catch(() => {});
      screen = 'results';
      return;
    }
    if (action === 'reveal') {
      reveal = data;
      return;
    }
    overview = data;
    fetchedAt = Date.now();
    if (overview.current?.question?.index !== before) resetDrafts();
    if (!overview.current) screen = 'home';
    const q = overview.current?.question;
    if (q?.feedback) say(q.feedback.correct ? 'Correct' : `Not quite. The answer was ${q.feedback.answer}`);
  });

const startSession = (quizId, only) =>
  act(async () => {
    const count = options.count === 'all' ? undefined : Number(options.count);
    overview = await api('POST', `/learners/${encodeURIComponent(learner)}/sessions`, { quizId, mode: options.mode, shuffle: options.shuffle, ...(count ? { count } : {}), ...(only ? { only } : {}) });
    fetchedAt = Date.now();
    picking = null;
    resetDrafts();
    screen = 'question';
  });

const fmtTime = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---------- screens ----------

function learnerScreen() {
  let draft = '';
  const submit = (event) => {
    event.preventDefault();
    const name = draft.trim();
    if (!name) return;
    chooseLearner(name);
  };
  return h(
    'section',
    { class: 'screen pr-shell' },
    brandBlock(),
    h('h1', {}, '🎓 Practice'),
    h('p', { class: 'muted' }, 'Work through a quiz at your own pace. No timer, no teams: just you and the questions.'),
    learners.length
      ? h(
          'div',
          { class: 'pr-learners' },
          h('p', { class: 'muted small' }, 'Carry on as'),
          h('div', { class: 'pr-chips' }, learners.map((l) => h('button', { type: 'button', class: 'chip', onclick: () => chooseLearner(l.name) }, l.name))),
        )
      : null,
    h(
      'form',
      { class: 'pr-name-form', onsubmit: submit },
      h('label', {}, learners.length ? 'Or type a new name' : "What's your name?", h('input', { name: 'learner', autocomplete: 'off', maxlength: '40', required: true, autofocus: true, oninput: (e) => (draft = e.target.value) })),
      h('button', { class: 'primary', type: 'submit' }, 'Start practising'),
    ),
    error ? h('p', { class: 'error', role: 'alert' }, error) : null,
  );
}

function chooseLearner(name) {
  learner = name;
  store(LEARNER_STORAGE, name);
  screen = 'home';
  act(refresh);
}

function homeScreen() {
  const current = overview?.current;
  return h(
    'section',
    { class: 'screen pr-shell' },
    topBar(),
    current ? h('div', { class: 'pr-card pr-carry-on' }, h('h2', {}, 'Carry on?'), h('p', {}, h('strong', {}, current.quizTitle), ` · question ${current.position + 1} of ${current.total}`), h('div', { class: 'pr-actions' }, h('button', { class: 'primary', onclick: () => { screen = 'question'; render(); } }, 'Carry on ▶'), h('button', { onclick: () => doAction('finish') }, 'Finish now'), h('button', { class: 'danger', onclick: () => confirm('Throw this attempt away?') && doAction('abandon') }, 'Throw it away'))) : null,
    h('h2', {}, 'Pick a quiz'),
    quizzes === null
      ? h('p', { class: 'muted' }, 'Loading…')
      : quizzes.length === 0
        ? h('p', { class: 'muted' }, 'There are no quizzes ready yet. Ask the quiz master to make one.')
        : h(
            'ul',
            { class: 'pr-quiz-list' },
            quizzes.map((q) =>
              h(
                'li',
                { class: `pr-quiz${picking === q.id ? ' open' : ''}` },
                h('div', { class: 'pr-quiz-row' }, h('div', {}, h('h3', {}, q.title), h('p', { class: 'muted small' }, `${q.rounds} ${q.rounds === 1 ? 'round' : 'rounds'} · ${q.questions} questions`)), h('button', { class: picking === q.id ? '' : 'primary', onclick: () => { picking = picking === q.id ? null : q.id; render(); } }, picking === q.id ? 'Close' : 'Practise')),
                picking === q.id ? optionsPanel(q) : null,
              ),
            ),
          ),
    overview?.history?.length ? historyList() : null,
    error ? h('p', { class: 'error', role: 'alert' }, error) : null,
  );
}

function optionsPanel(q) {
  const radio = (name, value, label, hint) =>
    h('label', { class: 'pr-choice' }, h('input', { type: 'radio', name, value, checked: options[name] === value, onchange: () => { options[name] = value; render(); } }), h('span', {}, h('strong', {}, label), hint ? h('span', { class: 'muted small' }, ` ${hint}`) : null));
  const counts = ['all', '10', '20'].filter((c) => c === 'all' || Number(c) < q.questions);
  return h(
    'div',
    { class: 'pr-options' },
    h('fieldset', {}, h('legend', {}, 'How'), radio('mode', 'learn', 'Learn as I go', 'the answer and why, after each question'), radio('mode', 'test', 'Test myself', 'marked at the end')),
    h('fieldset', {}, h('legend', {}, 'How many'), counts.map((c) => radio('count', c, c === 'all' ? `All ${q.questions}` : c))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: options.shuffle, onchange: (e) => (options.shuffle = e.target.checked) }), ' Mix the questions up'),
    h('button', { class: 'primary', disabled: busy, onclick: () => startSession(q.id) }, 'Start ▶'),
  );
}

function historyList() {
  return h(
    'div',
    { class: 'pr-history' },
    h('h2', {}, 'Before'),
    h(
      'ul',
      {},
      overview.history.slice(0, 12).map((s) =>
        h(
          'li',
          {},
          h('button', { class: 'link-button', onclick: () => act(async () => { results = await api('GET', `/learners/${encodeURIComponent(learner)}/sessions/${s.id}/results`); screen = 'results'; }) }, s.quizTitle),
          h('span', { class: 'muted small' }, ` · ${fmtDate(s.finishedAt)} · ${s.mode === 'test' ? 'test' : 'learn'}`),
          h('strong', { class: 'pr-score' }, `${s.right}/${s.total}`),
        ),
      ),
    ),
  );
}

function topBar(extra) {
  return h(
    'div',
    { class: 'pr-top' },
    h('div', { class: 'pr-who' }, h('span', { class: 'muted small' }, 'Practising as '), h('strong', {}, learner), ' ', h('button', { class: 'link-button small', onclick: () => { learner = ''; store(LEARNER_STORAGE, null); overview = null; screen = 'learner'; act(async () => { learners = await api('GET', '/learners'); }); } }, 'change')),
    extra ?? null,
  );
}

function questionScreen() {
  const v = overview.current;
  const q = v.question;
  const answered = Boolean(q.given);
  const feedback = q.feedback;
  const last = v.position === v.total - 1;
  const timer = h('span', { id: 'pr-timer', class: 'muted small', title: 'Time spent (nothing happens when it runs)' }, fmtTime(v.elapsedMs + (Date.now() - fetchedAt)));
  return h(
    'section',
    { class: 'screen pr-shell' },
    h(
      'div',
      { class: 'pr-top' },
      h('button', { class: 'link-button', onclick: () => { screen = 'home'; render(); } }, '‹ Quizzes'),
      h('div', { class: 'pr-meta' }, h('strong', {}, `${v.position + 1} of ${v.total}`), ' · ', timer),
      h('button', { class: `pr-flag${q.flagged ? ' on' : ''}`, title: 'Flag this one to look at again', 'aria-pressed': String(q.flagged), onclick: () => doAction('flag') }, q.flagged ? '★ Flagged' : '☆ Flag'),
    ),
    h('div', { class: 'pr-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(v.total), 'aria-valuenow': String(v.answered) }, h('span', { style: `width:${(100 * v.answered) / v.total}%` })),
    h(
      'div',
      { class: 'pr-card pr-question' },
      h('p', { class: 'pr-round muted small' }, q.round, v.mode === 'test' ? ' · test' : null),
      h('h2', { class: 'question-text' }, q.text),
      q.imageUrl ? h('img', { class: 'question-image pr-image', src: imageWithKey(q.imageUrl), alt: '' }) : null,
      q.audioUrl ? h('audio', { controls: true, preload: 'none', src: imageWithKey(q.audioUrl) }) : null,
      q.skipped && !answered ? h('p', { class: 'muted small' }, 'You skipped this one. You can still answer it.') : null,
      feedback ? feedbackCard(q) : answerInput(q, answered && v.mode === 'learn'),
      v.mode === 'test' && answered ? h('p', { class: 'muted small center' }, 'Your answer: ', h('strong', {}, q.given.label), '. Answer again to change it.') : null,
    ),
    h(
      'div',
      { class: 'pr-actions' },
      h('button', { disabled: busy || v.position === 0, onclick: () => doAction('back') }, '← Back'),
      feedback || (v.mode === 'test' && answered)
        ? last
          ? h('button', { class: 'primary', disabled: busy, onclick: () => doAction('finish') }, 'Finish ✓')
          : h('button', { class: 'primary', disabled: busy, onclick: () => doAction('next') }, 'Next →')
        : last
          ? h('button', { disabled: busy, onclick: () => doAction('finish') }, 'Finish without answering')
          : h('button', { disabled: busy, onclick: () => doAction('skip') }, 'Skip →'),
    ),
    v.answered === v.total && !last ? h('p', { class: 'center' }, h('button', { class: 'link-button', onclick: () => doAction('finish') }, 'Finish now')) : null,
    error ? h('p', { class: 'error', role: 'alert' }, error) : null,
  );
}

function feedbackCard(q) {
  const f = q.feedback;
  return h(
    'div',
    { class: `pr-feedback ${f.correct ? 'right' : 'wrong'}`, role: 'status' },
    h('h3', {}, f.correct ? '✓ Correct!' : q.type === 'buzzer' ? 'Not this time' : '✗ Not quite'),
    f.correct && q.type !== 'ordering' ? null : h('p', {}, 'You said: ', h('strong', {}, q.given.label)),
    h('p', {}, q.type === 'ordering' ? 'The order: ' : 'The answer: ', h('strong', {}, f.answer)),
    f.detail ? h('p', { class: 'muted small' }, f.detail) : null,
    f.info ? h('p', { class: 'pr-info' }, '💡 ', f.info) : null,
  );
}

const send = (value) => doAction('answer', { value });

function answerInput(q, lockedIn) {
  switch (q.type) {
    case 'multiple-choice':
      return h(
        'div',
        { class: 'options' },
        q.options.map((option, i) => h('button', { class: `option opt-${i}${q.given?.value === i ? ' chosen' : ''}`, disabled: busy || lockedIn, onclick: () => send(i) }, h('span', { class: 'letter' }, LETTERS[i]), h('span', {}, option))),
      );
    case 'picture':
    case 'music':
      return h(
        'form',
        { class: 'text-answer', onsubmit: (e) => { e.preventDefault(); if (draftText.trim()) send(draftText.trim()); } },
        h('input', { name: 'answer', 'aria-label': 'Your answer', placeholder: 'Type your answer', value: draftText, maxlength: '100', autocomplete: 'off', autofocus: true, oninput: (e) => (draftText = e.target.value) }),
        h('button', { class: 'primary', type: 'submit', disabled: busy }, 'Check'),
      );
    case 'letter':
      return h(
        'div',
        {},
        h('p', { class: 'muted small center' }, 'Tap the first letter of the answer (skip "The").'),
        h('div', { class: q.keypad === 'single' ? 'keypad' : 'keypad grouped' }, (q.keypad === 'single' ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'] : LETTER_GROUPS).map((letter) => h('button', { class: `key${q.given?.value === letter ? ' chosen' : ''}`, disabled: busy || lockedIn, onclick: () => send(letter) }, letter))),
      );
    case 'number':
    case 'nearest':
      return h(
        'form',
        { class: 'text-answer', onsubmit: (e) => { e.preventDefault(); const n = Number(draftText.trim().replace(',', '.')); if (/^-?\d+([.,]\d+)?$/.test(draftText.trim())) send(n); else showNotice('Type a number.'); } },
        q.type === 'nearest' ? h('p', { class: 'muted small center' }, 'As close as you can.') : null,
        h('input', { name: 'answer', inputmode: 'decimal', 'aria-label': 'Your answer', placeholder: 'Type a number', value: draftText, maxlength: '20', autocomplete: 'off', autofocus: true, oninput: (e) => (draftText = e.target.value) }),
        h('button', { class: 'primary', type: 'submit', disabled: busy }, 'Check'),
      );
    case 'ordering': {
      if (draftOrder.length !== q.items.length) draftOrder = q.items.map((_, i) => i);
      const move = (from, to) => {
        if (to < 0 || to >= draftOrder.length) return;
        const next = [...draftOrder];
        [next[from], next[to]] = [next[to], next[from]];
        draftOrder = next;
        render();
      };
      return h(
        'div',
        { class: 'ordering reorder' },
        h('p', { class: 'muted small center' }, 'Put them in order, first at the top.'),
        h(
          'ol',
          { class: 'reorder-list' },
          draftOrder.map((item, position) =>
            h(
              'li',
              { class: 'reorder-item' },
              h('span', { class: 'slot-number' }, position + 1),
              h('span', { class: 'reorder-text' }, q.items[item]),
              h('button', { type: 'button', class: 'move', 'aria-label': `Move ${q.items[item]} up`, disabled: position === 0, onclick: () => move(position, position - 1) }, '▲'),
              h('button', { type: 'button', class: 'move', 'aria-label': `Move ${q.items[item]} down`, disabled: position === draftOrder.length - 1, onclick: () => move(position, position + 1) }, '▼'),
            ),
          ),
        ),
        h('button', { class: 'primary', disabled: busy, onclick: () => send(draftOrder) }, 'Check this order'),
      );
    }
    case 'buzzer':
      // Nobody to buzz against: think of the answer, look, and be honest.
      return reveal
        ? h(
            'div',
            { class: 'pr-selfmark' },
            h('p', {}, 'The answer: ', h('strong', {}, reveal.answer)),
            reveal.info ? h('p', { class: 'pr-info' }, '💡 ', reveal.info) : null,
            h('p', { class: 'muted small' }, 'Did you have it?'),
            h('div', { class: 'pr-actions' }, h('button', { class: 'primary', disabled: busy, onclick: () => send('right') }, '✓ I got it'), h('button', { disabled: busy, onclick: () => send('wrong') }, "✗ I didn't")),
          )
        : h('div', { class: 'pr-selfmark' }, h('p', { class: 'muted' }, 'Say the answer out loud or in your head, then check.'), h('button', { class: 'primary', disabled: busy, onclick: () => doAction('reveal') }, 'Show me the answer'));
  }
  return null;
}

function resultsScreen() {
  const r = results;
  const grade = r.percent >= 80 ? 'Brilliant!' : r.percent >= 60 ? 'Good going.' : r.percent >= 40 ? 'Getting there.' : 'Keep at it.';
  return h(
    'section',
    { class: 'screen pr-shell' },
    topBar(),
    h(
      'div',
      { class: 'pr-card pr-results' },
      h('p', { class: 'muted' }, r.quizTitle, ' · ', r.mode === 'test' ? 'test' : 'learn', ' · ', fmtTime(r.elapsedMs)),
      h('p', { class: 'pr-pct' }, `${r.percent}%`),
      h('p', { class: 'big' }, `${r.right} of ${r.total} right. ${grade}`),
      r.byRound.length > 1
        ? h('ul', { class: 'pr-rounds' }, r.byRound.map((b) => h('li', { class: 'pr-bar' }, h('span', { class: 'pr-bar-name' }, b.round), h('span', { class: 'track' }, h('span', { class: 'fill', style: `width:${b.total ? (100 * b.right) / b.total : 0}%` })), h('span', { class: 'pr-bar-score' }, `${b.right}/${b.total}`))))
        : null,
      h(
        'div',
        { class: 'pr-actions' },
        r.missed.length ? h('button', { class: 'primary', disabled: busy, onclick: () => { options.mode = 'learn'; startSession(r.quizId, r.missed); } }, `Retry the ${r.missed.length} I missed`) : h('button', { class: 'primary', disabled: busy, onclick: () => startSession(r.quizId) }, 'Again ▶'),
        h('button', { onclick: () => { screen = 'home'; act(refresh); } }, 'Other quizzes'),
      ),
    ),
    h('h2', {}, 'Every question'),
    h(
      'ol',
      { class: 'pr-review' },
      r.review.map((item) =>
        h(
          'li',
          { class: item.correct ? 'right' : 'wrong' },
          h('p', { class: 'pr-review-q' }, h('span', { class: 'mark', 'aria-label': item.correct ? 'right' : 'wrong' }, item.correct ? '✓' : '✗'), ' ', item.text, item.flagged ? h('span', { class: 'muted small' }, ' ★') : null),
          item.correct ? null : h('p', { class: 'muted small' }, item.skipped ? 'Skipped' : `You said: ${item.given}`),
          h('p', { class: 'small' }, item.type === 'ordering' ? 'Order: ' : 'Answer: ', h('strong', {}, item.answer)),
          item.info ? h('p', { class: 'pr-info small' }, '💡 ', item.info) : null,
        ),
      ),
    ),
    error ? h('p', { class: 'error', role: 'alert' }, error) : null,
  );
}

function lockedScreen() {
  return h('section', { class: 'screen center pr-shell' }, brandBlock(), h('h1', {}, 'This practice link has stopped working'), h('p', { class: 'muted' }, 'Ask the quiz master for a new one: it is under 🎓 Practice on the host screen.'));
}

function render() {
  const view = locked ? lockedScreen() : screen === 'learner' ? learnerScreen() : screen === 'question' && overview?.current ? questionScreen() : screen === 'results' && results ? resultsScreen() : homeScreen();
  // Keep what the learner is typing when a re-render happens under their fingers.
  const focused = document.activeElement;
  const focusName = focused?.name;
  const caret = focused && 'selectionStart' in focused ? focused.selectionStart : null;
  app.replaceChildren(...[view, notice ? h('div', { class: 'notice', role: 'alert' }, notice) : null].filter(Boolean));
  if (focusName) {
    const again = app.querySelector(`[name="${focusName}"]`);
    if (again) {
      again.focus();
      if (caret !== null && 'setSelectionRange' in again) again.setSelectionRange(caret, caret);
    }
  }
}

// Keyboard: 1–6 picks an option, Enter goes on once there is feedback, arrows move.
document.addEventListener('keydown', (event) => {
  if (screen !== 'question' || !overview?.current || event.target.closest('input, textarea, select')) return;
  const q = overview.current.question;
  if (!q) return;
  if (q.type === 'multiple-choice' && !q.given && /^[1-6]$/.test(event.key)) {
    const i = Number(event.key) - 1;
    if (i < q.options.length) send(i);
  } else if ((event.key === 'Enter' || event.key === 'ArrowRight') && (q.feedback || (overview.current.mode === 'test' && q.given))) {
    doAction(overview.current.position === overview.current.total - 1 ? 'finish' : 'next');
  } else if (event.key === 'ArrowLeft' && overview.current.position > 0) doAction('back');
});

setInterval(() => {
  const el = document.getElementById('pr-timer');
  if (el && overview?.current) el.textContent = fmtTime(overview.current.elapsedMs + (Date.now() - fetchedAt));
}, 1000);

await loadBranding().catch(() => {});
if (!key) locked = true;
render();
act(async () => {
  if (locked) return;
  learners = await api('GET', '/learners');
  if (learner) await refresh();
});
