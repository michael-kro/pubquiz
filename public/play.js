import { connectSocket, h, LETTERS, ordinal, setDeadline, tick } from './common.js';

const TOKEN_KEY = 'pubquiz.team-token';
const app = document.getElementById('app');
const statusBanner = document.getElementById('status');
const params = new URLSearchParams(location.search);

let token = readToken();
let state = null;
let ended = null; // Message shown when this device is done (kicked or replaced).
let joinError = '';
let notice = '';
let noticeTimer;
let pendingChoice = null;
const form = { room: (params.get('room') ?? '').toUpperCase(), name: '' };

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
    render();
  },
  onStatus(connected) {
    statusBanner.hidden = connected || Boolean(ended);
  },
  onMessage(message) {
    switch (message.t) {
      case 'joined':
        writeToken(message.token);
        joinError = '';
        break;
      case 'rejoin-failed':
        // The quiz was restarted or the team was removed: start again.
        writeToken(null);
        state = null;
        break;
      case 'state':
        state = message.view;
        if (state.phase !== 'open' || state.myAnswer != null) pendingChoice = null;
        setDeadline(state.question?.remainingMs);
        break;
      case 'error':
        if (state) showNotice(message.message);
        else joinError = message.message;
        pendingChoice = null;
        break;
      case 'kicked':
        writeToken(null);
        ended = 'The quiz master removed your team from this quiz.';
        socket.stop();
        break;
      case 'replaced':
        ended = 'Your team is now playing on another device. Use that one to answer.';
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

function render() {
  app.replaceChildren(view(), notice ? h('div', { class: 'notice', role: 'alert' }, notice) : '');
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
  );
}

function joinForm() {
  const submit = (event) => {
    event.preventDefault();
    joinError = '';
    if (!socket.send({ t: 'join', room: form.room, name: form.name })) joinError = 'Not connected yet. Try again in a moment.';
    render();
  };
  const hasRoomFromLink = Boolean(params.get('room'));

  return h(
    'form',
    { class: 'screen join', onsubmit: submit },
    h('h1', {}, 'Join the quiz'),
    hasRoomFromLink
      ? null
      : h(
          'label',
          {},
          'Room code',
          h('input', {
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
        value: form.name,
        autocomplete: 'off',
        maxlength: '24',
        required: true,
        autofocus: true,
        oninput: (e) => (form.name = e.target.value),
      }),
    ),
    joinError ? h('p', { class: 'error', role: 'alert' }, joinError) : null,
    h('button', { class: 'primary', type: 'submit' }, 'Join'),
    h('p', { class: 'muted small' }, 'One phone per team.'),
  );
}

function questionHeader(q) {
  return h('p', { class: 'question-meta' }, `${q.round} · Question ${q.index + 1} of ${q.total}`);
}

function phaseView(s) {
  const q = s.question;
  switch (s.phase) {
    case 'lobby':
      return h(
        'section',
        { class: 'screen center' },
        h('h1', {}, "You're in!"),
        h('p', {}, 'Waiting for the quiz master to start.'),
        h('p', { class: 'muted' }, `${s.teamCount} ${s.teamCount === 1 ? 'team has' : 'teams have'} joined`),
      );

    case 'open': {
      const chosen = s.myAnswer ?? pendingChoice;
      const locked = chosen != null;
      return h(
        'section',
        { class: 'screen' },
        h('div', { class: 'question-top' }, questionHeader(q), h('span', { class: 'countdown', 'data-countdown': true })),
        h('h2', { class: 'question-text' }, q.text),
        h(
          'div',
          { class: 'options' },
          q.options.map((option, i) =>
            h(
              'button',
              {
                class: `option opt-${i}${chosen === i ? ' chosen' : ''}`,
                disabled: locked,
                onclick: () => {
                  if (socket.send({ t: 'answer', choice: i })) {
                    pendingChoice = i;
                    render();
                  }
                },
              },
              h('span', { class: 'letter' }, LETTERS[i]),
              h('span', {}, option),
            ),
          ),
        ),
        locked ? h('p', { class: 'center muted' }, 'Answer locked in. Waiting for the other teams…') : null,
      );
    }

    case 'closed':
      return h(
        'section',
        { class: 'screen center' },
        questionHeader(q),
        h('h1', {}, "Time's up!"),
        s.myAnswer != null
          ? h('p', {}, 'You answered ', h('strong', {}, `${LETTERS[s.myAnswer]}: ${q.options[s.myAnswer]}`))
          : h('p', {}, 'No answer from your team this time.'),
        h('p', { class: 'muted' }, 'Waiting for the reveal…'),
      );

    case 'reveal': {
      const r = s.result;
      const correctText = `${LETTERS[r.correctIndex]}: ${q.options[r.correctIndex]}`;
      return h(
        'section',
        { class: `screen center result ${r.correct ? 'right' : 'wrong'}` },
        questionHeader(q),
        h('h1', {}, r.correct ? 'Correct!' : s.myAnswer == null ? 'No answer' : 'Wrong'),
        r.correct ? h('p', { class: 'points' }, `+${r.points}`) : h('p', {}, 'The answer was ', h('strong', {}, correctText)),
      );
    }

    case 'leaderboard':
    case 'finished': {
      const final = s.phase === 'finished';
      return h(
        'section',
        { class: 'screen' },
        h('h1', { class: 'center' }, final ? 'Final results' : 'Leaderboard'),
        h('p', { class: 'center big' }, `${final ? 'You finished' : "You're"} ${ordinal(s.rank)} of ${s.teamCount}`),
        standingsList(s.standings, s.teamId, final ? Infinity : 10),
      );
    }
  }
  return h('section', { class: 'screen' });
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

render();
