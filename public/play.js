import { brandBlock, connectSocket, getBranding, h, LETTERS, loadBranding, ordinal, preload, setDeadline, tick } from './common.js';

const TOKEN_KEY = 'pubquiz.team-token';
const app = document.getElementById('app');
const statusBanner = document.getElementById('status');
const live = document.getElementById('live');
let announced = '';

/** Tells screen readers about the big changes: a new question, time up, the result, the standings. */
function announce() {
  let text = '';
  if (ended) text = ended;
  else if (state) {
    const q = state.question;
    const r = state.result;
    text = {
      lobby: "You're in. Waiting for the quiz master to start.",
      open: q && `${q.paused ? 'Paused. ' : ''}Question ${q.index + 1} of ${q.total}. ${q.text}`,
      closed: "Time's up.",
      reveal: r && `${r.correct ? 'Correct' : 'Not correct'}. ${r.points} points. The answer was ${r.answerText}.`,
      leaderboard: `You are ${ordinal(state.rank)} of ${state.teamCount}.`,
      finished: `Final results. You finished ${ordinal(state.rank)} of ${state.teamCount}.`,
    }[state.phase] ?? '';
    text = `${state.phase}:${q?.index}${q?.paused ? 'p' : ''}:${text}`;
  }
  if (text && text !== announced) {
    announced = text;
    live.textContent = text.replace(/^[a-z]+:-?\d*p?:/, '');
  }
}
const params = new URLSearchParams(location.search);

let token = readToken();
let state = null;
let ended = null; // Message shown when this device is done (kicked or replaced).
let joinError = '';
let notice = '';
let noticeTimer;
let lastRenderKey = '';
let pendingJoin = null; // A join or rejoin tapped before the connection was ready.
let connected = false;
let stopped = false; // This page is done with the server (quiz over, kicked or replaced).
const form = { room: (params.get('room') ?? '').toUpperCase(), name: '', code: '', rejoining: false };

// Per-question drafts, reset when a new question opens.
let draftFor = -1;
let pending = null; // An answer sent but not yet confirmed by the server.
let draftText = '';
let draftOrder = []; // Ordering: displayed item indices in the order tapped.

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(value) {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private browsing: the team just can't rejoin after closing the tab.
  }
}

const socket = connectSocket({
  onOpen() {
    if (token) socket.send({ t: 'rejoin', token });
    else if (pendingJoin) socket.send(pendingJoin);
    pendingJoin = null;
    render();
  },
  onStatus(isConnected) {
    connected = isConnected;
    statusBanner.hidden = isConnected || stopped;
    lastRenderKey = '';
    render();
  },
  onMessage(message) {
    switch (message.t) {
      case 'joined':
        writeToken(message.token);
        joinError = '';
        break;
      case 'rejoin-failed':
        if (form.rejoining) {
          joinError = 'No team with that code. Check it on your other phone, or ask the quiz master.';
        } else {
          // The quiz was restarted or the team was removed: start again.
          writeToken(null);
          state = null;
        }
        break;
      case 'state':
        state = message.view;
        if (state.question && state.question.index !== draftFor) {
          draftFor = state.question.index;
          pending = null;
          draftText = '';
          draftOrder = [];
        }
        if (state.phase !== 'open' || state.myAnswerText != null) pending = null;
        setDeadline(state.question?.remainingMs, state.question?.paused);
        trackQuestionTiming(state);
        preload(state.preloadImage);
        break;
      case 'error':
        if (state) showNotice(message.message);
        else joinError = message.message;
        pending = null;
        break;
      case 'kicked':
        writeToken(null);
        ended = 'The quiz master removed your team from this quiz.';
        stopped = true;
        socket.stop();
        break;
      case 'quiz-ended':
        // Keep showing the final results if the quiz finished; otherwise say it's over.
        writeToken(null);
        if (state?.phase !== 'finished') ended = 'The quiz master has ended this quiz. Thanks for playing!';
        stopped = true;
        socket.stop();
        break;
      case 'replaced':
        ended = 'Your team is now playing on another device. Use that one to answer.';
        stopped = true;
        socket.stop();
        break;
    }
    render();
  },
});

function showNotice(text) {
  notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = '';
    render();
  }, 3000);
}

// The phone times its own answer, from the moment the question appeared on its screen. The server
// checks that against what it saw, so this can only ever remove network delay, never claim a faster answer.
let timing = { index: -1, at: 0, valid: false, pausedMs: 0, pausedSince: undefined };

function trackQuestionTiming(s) {
  const q = s.question;
  if (!q || s.phase !== 'open') return;
  if (q.index !== timing.index) {
    // Only trust it if we saw the question from (nearly) the start; after a page reload we didn't.
    timing = { index: q.index, at: performance.now(), valid: q.remainingMs >= q.seconds * 1000 - 2000, pausedMs: 0, pausedSince: undefined };
  }
  if (q.paused && timing.pausedSince === undefined) timing.pausedSince = performance.now();
  if (!q.paused && timing.pausedSince !== undefined) {
    timing.pausedMs += performance.now() - timing.pausedSince;
    timing.pausedSince = undefined;
  }
}

function elapsedMs() {
  if (!state?.question || timing.index !== state.question.index || !timing.valid || timing.pausedSince !== undefined) return undefined;
  return Math.max(0, Math.round(performance.now() - timing.at - timing.pausedMs));
}

function sendAnswer(value) {
  if (socket.send({ t: 'answer', value, elapsedMs: elapsedMs() })) {
    pending = value;
    render();
  } else {
    showNotice('Not connected. Try again in a moment.');
    render();
  }
}

/**
 * Re-renders only when something visible changed. Other teams' activity sends us updates too,
 * and rebuilding the page would drop focus from the answer box and close the phone keyboard.
 */
function render() {
  const { remainingMs, ...question } = state?.question ?? {};
  const key = JSON.stringify([state && { ...state, question, preloadImage: 0 }, ended, joinError, notice, pending, draftOrder, !!token, pendingJoin, connected, getBranding()]);
  if (key === lastRenderKey) return;
  lastRenderKey = key;
  // If someone is typing, keep the keyboard open across the rebuild.
  const typing = document.activeElement?.matches?.('input[name]') ? document.activeElement : null;
  const caret = typing?.selectionStart;
  app.replaceChildren(view(), notice ? h('div', { class: 'notice', role: 'alert' }, notice) : '');
  announce();
  if (typing) {
    const input = app.querySelector(`input[name="${typing.name}"]`);
    input?.focus();
    input?.setSelectionRange(caret, caret);
  }
  tick();
}

function view() {
  if (ended) return h('section', { class: 'screen center' }, h('h1', {}, 'Thanks for playing'), h('p', {}, ended));
  if (!state) return token ? h('section', { class: 'screen center' }, h('p', { class: 'muted' }, 'Connecting…')) : joinForm();

  return h(
    'div',
    { class: 'team-layout' },
    h(
      'header',
      { class: 'team-bar' },
      h('span', { class: 'team-name' }, state.teamName),
      h('span', { class: 'team-score' }, `${state.score} pts`),
    ),
    phaseView(state),
    h(
      'p',
      { class: 'team-code' },
      'Team code ',
      h('strong', {}, state.teamCode),
      ': enter it on another phone to carry on as this team.',
    ),
  );
}

function rejoinForm() {
  const submit = (event) => {
    event.preventDefault();
    joinError = '';
    submitWhenConnected({ t: 'rejoin', code: form.code });
    lastRenderKey = '';
    render();
  };
  return h(
    'form',
    { class: 'screen join', onsubmit: submit },
    h('h1', {}, 'Rejoin your team'),
    h('p', { class: 'muted' }, 'Your team code is at the bottom of the screen on the phone your team was using.'),
    h(
      'label',
      {},
      'Team code',
      h('input', {
        name: 'team-code',
        value: form.code,
        autocomplete: 'off',
        autocapitalize: 'characters',
        maxlength: '6',
        required: true,
        autofocus: true,
        oninput: (e) => (form.code = e.target.value.toUpperCase()),
      }),
    ),
    joinError ? h('p', { class: 'error', role: 'alert' }, joinError) : null,
    h('button', { class: 'primary', type: 'submit', disabled: Boolean(pendingJoin) }, joinButtonLabel('Rejoin')),
    h('button', { class: 'link-button', type: 'button', onclick: () => switchForm(false) }, 'Join as a new team instead'),
  );
}

/** Sends now, or as soon as the connection opens: a slow phone shouldn't make the team tap twice. */
function submitWhenConnected(message) {
  if (!socket.send(message)) pendingJoin = message;
}

function joinButtonLabel(label) {
  return pendingJoin ? 'Connecting…' : label;
}

function switchForm(rejoining) {
  form.rejoining = rejoining;
  joinError = '';
  lastRenderKey = '';
  render();
}

function joinForm() {
  if (form.rejoining) return rejoinForm();
  const submit = (event) => {
    event.preventDefault();
    joinError = '';
    submitWhenConnected({ t: 'join', room: form.room, name: form.name });
    lastRenderKey = '';
    render();
  };
  const hasRoomFromLink = Boolean(params.get('room'));

  return h(
    'form',
    { class: 'screen join', onsubmit: submit },
    brandBlock(),
    h('h1', {}, 'Join the quiz'),
    hasRoomFromLink
      ? null
      : h(
          'label',
          {},
          'Room code',
          h('input', {
            name: 'room',
            value: form.room,
            autocomplete: 'off',
            autocapitalize: 'characters',
            maxlength: '4',
            required: true,
            oninput: (e) => (form.room = e.target.value.toUpperCase()),
          }),
        ),
    h(
      'label',
      {},
      'Team name',
      h('input', {
        name: 'team-name',
        value: form.name,
        autocomplete: 'off',
        maxlength: '24',
        required: true,
        autofocus: true,
        oninput: (e) => (form.name = e.target.value),
      }),
    ),
    joinError ? h('p', { class: 'error', role: 'alert' }, joinError) : null,
    h('button', { class: 'primary', type: 'submit', disabled: Boolean(pendingJoin) }, joinButtonLabel('Join')),
    h('p', { class: 'muted small' }, 'One phone per team.'),
    h('button', { class: 'link-button', type: 'button', onclick: () => switchForm(true) }, 'Already joined? Rejoin with your team code'),
  );
}

function questionHeader(q) {
  return h('p', { class: 'question-meta' }, `${q.round} · Question ${q.index + 1} of ${q.total}`);
}

function questionImage(q) {
  return q.image ? h('img', { class: 'question-image', src: q.image, alt: '' }) : null;
}

function phaseView(s) {
  const q = s.question;
  switch (s.phase) {
    case 'lobby':
      return h(
        'section',
        { class: 'screen center' },
        brandBlock(),
        h('h1', {}, "You're in!"),
        h('p', {}, 'Waiting for the quiz master to start.'),
        h('p', { class: 'muted' }, `${s.teamCount} ${s.teamCount === 1 ? 'team has' : 'teams have'} joined`),
      );

    case 'open': {
      const answered = s.myAnswerText != null || pending != null;
      const locked = answered || Boolean(q.paused);
      return h(
        'section',
        { class: 'screen' },
        h('div', { class: 'question-top' }, questionHeader(q), h('span', { class: 'countdown', 'data-countdown': true })),
        q.paused ? h('p', { class: 'paused-banner', role: 'status' }, '⏸ Paused by the quiz master. The clock is stopped.') : null,
        q.type === 'music' ? h('p', { class: 'music-badge' }, '🎵 Listen to the music') : null,
        h('h2', { class: 'question-text' }, q.text),
        questionImage(q),
        answerInput(s, q, locked),
        answered
          ? h(
              'p',
              { class: 'center muted' },
              s.myAnswerText && q.type !== 'multiple-choice' && q.type !== 'letter'
                ? ['Locked in: ', h('strong', {}, s.myAnswerText), '. ']
                : 'Answer locked in. ',
              'Waiting for the other teams…',
            )
          : null,
      );
    }

    case 'closed':
      return h(
        'section',
        { class: 'screen center' },
        questionHeader(q),
        h('h1', {}, "Time's up!"),
        s.myAnswerText != null
          ? h('p', {}, 'You answered ', h('strong', {}, myAnswerLabel(s)))
          : h('p', {}, 'No answer from your team this time.'),
        h('p', { class: 'muted' }, q.type === 'picture' || q.type === 'music' ? 'The quiz master is marking answers…' : 'Waiting for the reveal…'),
      );

    case 'reveal': {
      const r = s.result;
      const answered = s.myAnswerText != null;
      const answerLabel = r.correctIndex != null ? `${LETTERS[r.correctIndex]}: ${r.answerText}` : r.answerText;
      return h(
        'section',
        { class: `screen center result ${r.correct ? 'right' : r.points > 0 ? 'partial' : 'wrong'}` },
        questionHeader(q),
        h('h1', {}, r.correct ? 'Correct!' : !answered ? 'No answer' : r.points > 0 ? 'Close!' : 'Wrong'),
        r.points > 0 ? h('p', { class: 'points' }, `+${r.points}`) : null,
        r.detail && answered ? h('p', {}, r.detail) : null,
        r.correct ? null : h('p', {}, q.type === 'ordering' ? 'The order was ' : 'The answer was ', h('strong', {}, answerLabel)),
        answered && !r.correct ? h('p', { class: 'muted' }, 'You said ', myAnswerLabel(s)) : null,
      );
    }

    case 'leaderboard':
    case 'finished': {
      const final = s.phase === 'finished';
      return h(
        'section',
        { class: 'screen' },
        final ? brandBlock() : null,
        h('h1', { class: 'center' }, final ? 'Final results' : 'Leaderboard'),
        h('p', { class: 'center big' }, `${final ? 'You finished' : "You're"} ${ordinal(s.rank)} of ${s.teamCount}`),
        standingsList(s.standings, s.teamId, final ? Infinity : 10),
      );
    }
  }
  return h('section', { class: 'screen' });
}

function myAnswerLabel(s) {
  return s.myChoice != null ? `${LETTERS[s.myChoice]}: ${s.myAnswerText}` : s.myAnswerText;
}

function answerInput(s, q, locked) {
  switch (q.type) {
    case 'multiple-choice': {
      const chosen = s.myChoice ?? pending;
      return h(
        'div',
        { class: 'options' },
        q.options.map((option, i) =>
          h(
            'button',
            { class: `option opt-${i}${chosen === i ? ' chosen' : ''}`, disabled: locked, onclick: () => sendAnswer(i) },
            h('span', { class: 'letter' }, LETTERS[i]),
            h('span', {}, option),
          ),
        ),
      );
    }

    case 'picture':
    case 'music': {
      if (locked) return null;
      const submit = (event) => {
        event.preventDefault();
        if (draftText.trim()) sendAnswer(draftText.trim());
      };
      return h(
        'form',
        { class: 'text-answer', onsubmit: submit },
        h('input', {
          name: 'answer',
          'aria-label': 'Your answer',
          placeholder: 'Type your answer',
          value: draftText,
          maxlength: '100',
          autocomplete: 'off',
          enterkeyhint: 'send',
          oninput: (e) => (draftText = e.target.value),
        }),
        h('button', { class: 'primary', type: 'submit' }, 'Submit answer'),
      );
    }

    case 'letter': {
      const chosen = s.myAnswerText ?? pending;
      return h(
        'div',
        {},
        h('p', { class: 'muted small center' }, 'Tap the first letter of the answer. Skip "The"; people go by first name (J for John Lennon).'),
        h(
          'div',
          { class: 'keypad' },
          [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) =>
            h(
              'button',
              { class: `key${chosen === letter ? ' chosen' : ''}`, disabled: locked, onclick: () => sendAnswer(letter) },
              letter,
            ),
          ),
        ),
      );
    }

    case 'ordering': {
      if (locked) return null;
      const remaining = q.items.map((_, i) => i).filter((i) => !draftOrder.includes(i));
      return h(
        'div',
        { class: 'ordering' },
        h('p', { class: 'muted small' }, 'Tap the items in order, first to last. Tap a placed item to take it back.'),
        h(
          'ol',
          { class: 'placed' },
          q.items.map((_, slot) => {
            const item = draftOrder[slot];
            return item == null
              ? h('li', { class: 'slot empty' }, h('span', { class: 'slot-number' }, slot + 1))
              : h(
                  'li',
                  { class: 'slot' },
                  h(
                    'button',
                    {
                      class: 'placed-item',
                      'aria-label': `Position ${slot + 1}: ${q.items[item]}. Tap to remove.`,
                      onclick: () => {
                        draftOrder = draftOrder.filter((i) => i !== item);
                        render();
                      },
                    },
                    h('span', { class: 'slot-number' }, slot + 1),
                    h('span', {}, q.items[item]),
                    h('span', { class: 'remove', 'aria-hidden': 'true' }, '×'),
                  ),
                );
          }),
        ),
        remaining.length
          ? h(
              'div',
              { class: 'pool' },
              remaining.map((i) =>
                h(
                  'button',
                  {
                    class: 'pool-item',
                    onclick: () => {
                      draftOrder = [...draftOrder, i];
                      render();
                    },
                  },
                  q.items[i],
                ),
              ),
            )
          : null,
        h(
          'button',
          { class: 'primary', disabled: draftOrder.length !== q.items.length, onclick: () => sendAnswer(draftOrder) },
          draftOrder.length === q.items.length ? 'Submit order' : `Place ${q.items.length - draftOrder.length} more`,
        ),
      );
    }
  }
  return null;
}

function standingsList(rows, myTeamId, limit) {
  const shown = rows.filter((row, i) => i < limit || row.teamId === myTeamId);
  return h(
    'ol',
    { class: 'standings' },
    shown.map((row) =>
      h(
        'li',
        { class: row.teamId === myTeamId ? 'me' : '' },
        h('span', { class: 'rank' }, row.rank),
        h('span', { class: 'name' }, row.name),
        h('span', { class: 'score' }, row.score),
      ),
    ),
  );
}

// Colours and logo first, so the page never flashes the default look.
loadBranding().then((b) => {
  if (b.name) document.title = b.name;
  render();
});
render();
