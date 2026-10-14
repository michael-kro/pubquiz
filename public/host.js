import { connectSocket, h, LETTERS, ordinal, preload, setDeadline, tick } from './common.js';

const app = document.getElementById('app');
const statusBanner = document.getElementById('status');
const key = new URLSearchParams(location.search).get('key');

let state = null;
let fatal = key ? null : 'This page needs the host link printed in the terminal when the quiz started.';
let notice = '';
let noticeTimer;

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
  if (!state || event.target !== document.body) return;
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
  if (!state) {
    app.replaceChildren(h('section', { class: 'screen center' }, h('p', { class: 'muted' }, 'Connecting…')));
    return;
  }
  app.replaceChildren(
    h(
      'div',
      { class: 'host-layout' },
      topBar(state),
      h('section', { class: 'stage' }, stage(state)),
      teamsPanel(state),
    ),
    notice ? h('div', { class: 'notice', role: 'alert' }, notice) : '',
  );
  tick();
}

function topBar(s) {
  return h(
    'header',
    { class: 'host-bar' },
    h('span', { class: 'quiz-title' }, s.quizTitle),
    h('span', { class: 'join-hint' }, 'Join: ', h('strong', {}, s.joinUrl.replace(/^https?:\/\//, '')), ' · Room ', h('strong', {}, s.roomCode)),
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
        h('img', { class: 'qr', src: `/qr.svg?room=${s.roomCode}`, alt: `QR code for ${s.joinUrl}` }),
        h(
          'div',
          {},
          h('h1', {}, 'Scan to join'),
          h('p', { class: 'big' }, s.joinUrl.replace(/^https?:\/\//, '')),
          h('p', {}, 'Room code ', h('span', { class: 'room-code' }, s.roomCode)),
          h('p', { class: 'muted' }, `One phone per team. ${s.teams.length} of ${s.maxTeams} teams joined.`),
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
