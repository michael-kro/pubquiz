import { confetti, avatar, brandBlock, breakPanel, connectSocket, getBranding, h, LETTERS, loadBranding, ordinal, preload, prepareTeamPhoto, setBreak, setDeadline, tick } from './common.js';

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
    if (state.onBreak) text = 'The quiz is on a break.';
    else text = {
      lobby: "You're in. Waiting for the quiz master to start.",
      reading: 'The quiz master is reading out the answers. The timer has not started.',
      wagering: q && `Wager round. The category is ${q.category || 'a secret'}. Place your bet.`,
      open: q && `${q.paused ? 'Paused. ' : ''}Question ${q.roundQuestion} of ${q.roundQuestions}. ${q.text}`,
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
let photoBusy = false;
let pendingJoin = null; // A join or rejoin tapped before the connection was ready.
let connected = false;
let stopped = false; // This page is done with the server (quiz over, kicked or replaced).
const form = { room: (params.get('room') ?? '').toUpperCase(), name: '', code: '', rejoining: false };

// Per-question drafts, reset when a new question opens.
let draftFor = -1;
let pending = null; // An answer sent but not yet confirmed by the server.
let draftText = '';
let draftWager = '';
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
          draftWager = '';
          draftOrder = [];
        }
        if (state.phase !== 'open' || state.myAnswerText != null) pending = null;
        setDeadline(state.question?.remainingMs, state.question?.paused);
        setBreak(state.onBreak);
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
  render();
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
// Screens slide in when the phase or question changes, not on every re-render of the same screen.
let lastScreenKey = '';
function enterClass(state) {
  const key = `${state.onBreak ? 'break' : state.phase}:${state.question?.index ?? ''}`;
  if (key === lastScreenKey) return 'screen-wrap';
  lastScreenKey = key;
  if (state.phase === 'reveal' && state.result?.correct && !state.onBreak) confetti();
  return 'screen-wrap screen-enter';
}

function render() {
  const { remainingMs, ...question } = state?.question ?? {};
  const key = JSON.stringify([state && { ...state, question, preloadImage: 0 }, ended, joinError, notice, pending, draftOrder, !!token, pendingJoin, connected, getBranding(), photoBusy, draftWager]);
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
      h(
        'span',
        { class: 'team-left' },
        state.photosEnabled
          ? h('button', { class: 'avatar-button', type: 'button', 'aria-label': state.photo ? 'Change your team photo' : 'Add a team photo', onclick: () => pickPhoto(false) }, avatar(state.teamName, state.photo, 34))
          : avatar(state.teamName, undefined, 34),
        h('span', { class: 'team-name' }, state.teamName),
      ),
      h('span', { class: 'team-score' }, `${state.score} pts`),
    ),
    h('div', { class: enterClass(state) }, state.onBreak ? h('section', { class: 'screen center' }, brandBlock(), breakPanel()) : phaseView(state)),
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

/** Opens the camera (or the photo picker), shrinks the picture on the phone and uploads it. */
function pickPhoto(camera) {
  const input = h('input', { type: 'file', accept: 'image/*', ...(camera ? { capture: 'user' } : {}), hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    photoBusy = true;
    render();
    try {
      const blob = await prepareTeamPhoto(file);
      const res = await fetch('/team-photo', { method: 'POST', headers: { 'x-team-token': token }, body: blob });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Couldn't upload that photo (${res.status}).`);
    } catch (error) {
      showNotice(error.message);
    }
    photoBusy = false;
    render();
  });
  document.body.append(input);
  input.click();
}

async function removePhoto() {
  await fetch('/team-photo', { method: 'DELETE', headers: { 'x-team-token': token } }).catch(() => {});
}

function photoPrompt(s) {
  if (!s.photosEnabled) return null;
  return h(
    'div',
    { class: 'photo-prompt' },
    avatar(s.teamName, s.photo, 96),
    h('p', {}, s.photo ? 'Looking good! This shows on the big screen and the leaderboard.' : 'Add a team photo. It shows on the big screen and the leaderboard.'),
    h(
      'div',
      { class: 'photo-actions' },
      h('button', { type: 'button', disabled: photoBusy, onclick: () => pickPhoto(true) }, photoBusy ? 'Uploading…' : s.photo ? '📷 Retake' : '📷 Take a photo'),
      h('button', { type: 'button', disabled: photoBusy, onclick: () => pickPhoto(false) }, 'Choose from your photos'),
      s.photo ? h('button', { type: 'button', class: 'link-button', onclick: removePhoto }, 'Remove photo') : null,
    ),
  );
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
  return h('p', { class: 'question-meta' }, `${q.round} · Question ${q.roundQuestion} of ${q.roundQuestions}`);
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
        photoPrompt(s),
      );

    case 'wagering':
      return wageringScreen(s, q);

    case 'reading':
      return questionScreen(s, q, false);

    case 'open':
      if (q.type === 'buzzer') return buzzerScreen(s, q);
      return questionScreen(s, q, false);

    case 'closed':
      // A team that answered stays on its question, with the answer locked in, until the reveal.
      if (q.type !== 'buzzer' && s.myAnswerText != null) return questionScreen(s, q, true);
      if (q.type === 'buzzer') {
        const b = q.buzz ?? {};
        return h(
          'section',
          { class: 'screen center' },
          questionHeader(q),
          h('h1', {}, b.state === 'won' ? 'You got it!' : 'Round over'),
          h('p', {}, b.answering && b.state !== 'won' ? `${b.answering} got it.` : b.state === 'won' ? 'Great buzz!' : 'Nobody got it.'),
          h('p', { class: 'muted' }, 'Waiting for the reveal…'),
        );
      }
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
        h('h1', {}, q.type === 'buzzer' ? (r.correct ? 'You got it!' : r.detail?.startsWith('Wrong') ? 'Wrong!' : 'Not this time') : q.type === 'nearest' ? (r.correct ? 'Closest!' : !answered ? 'No answer' : 'Not the closest') : r.correct ? 'Correct!' : !answered ? 'No answer' : r.points > 0 ? 'Close!' : 'Wrong'),
        r.points > 0 ? h('p', { class: 'points' }, `+${r.points}`) : null,
        r.detail && answered ? h('p', {}, r.detail) : null,
        r.correct && q.type !== 'nearest' ? null : h('p', {}, q.type === 'ordering' ? 'The order was ' : 'The answer was ', h('strong', {}, answerLabel)),
        r.info ? h('p', { class: 'muted info' }, r.info) : null,
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

/** Jeopardy-style: teams see only the category and bet points before the question appears. */
function wageringScreen(s, q) {
  const info = s.wagerInfo ?? { cap: 0 };
  const placed = info.amount != null;
  const parsed = /^\d+$/.test(draftWager.trim()) ? Number(draftWager.trim()) : NaN;
  const submit = (event) => {
    event.preventDefault();
    if (!Number.isInteger(parsed) || parsed > info.cap) return showNotice(`Bet a whole number from 0 to ${info.cap}.`);
    socket.send({ t: 'wager', amount: parsed });
  };
  const preset = (label, amount) =>
    h('button', { type: 'button', class: 'preset', onclick: () => { draftWager = String(amount); render(); } }, label);
  return h(
    'section',
    { class: 'screen center wager-screen' },
    h('p', { class: 'question-meta' }, `${q.round} · Question ${q.roundQuestion} of ${q.roundQuestions}`),
    h('p', { class: 'wager-kicker' }, '🎲 Wager round'),
    h('h1', { class: 'wager-category' }, q.category || 'Place your bets'),
    placed
      ? [
          h('p', { class: 'points' }, `Bet locked: ${info.amount}`),
          h('p', { class: 'muted' }, 'Waiting for the quiz master to show the question…'),
        ]
      : h(
          'form',
          { class: 'wager-form', onsubmit: submit },
          h('p', {}, `You have ${s.score} points. Bet up to ${info.cap} before you see the question. Right wins it, wrong loses it.`),
          h('input', {
            name: 'wager',
            'aria-label': 'Points to bet',
            inputmode: 'numeric',
            placeholder: `0 to ${info.cap}`,
            value: draftWager,
            maxlength: '7',
            autocomplete: 'off',
            oninput: (e) => (draftWager = e.target.value),
          }),
          h('div', { class: 'presets' }, preset('Nothing', 0), preset('Quarter', Math.floor(info.cap / 4)), preset('Half', Math.floor(info.cap / 2)), preset('All in', info.cap)),
          h('button', { class: 'primary', type: 'submit' }, 'Lock in my bet'),
        ),
  );
}

/** The question with its answer controls. Once a team has answered it stays here, locked in, until the reveal. */
function questionScreen(s, q, closed) {
  const answered = s.myAnswerText != null || pending != null;
  const reading = s.phase === 'reading';
  const locked = closed || answered || reading || Boolean(q.paused);
  return h(
    'section',
    { class: 'screen' },
    h(
      'div',
      { class: 'question-top' },
      questionHeader(q),
      closed ? h('span', { class: 'time-up' }, "Time's up") : reading ? h('span', { class: 'time-up' }, 'Listen…') : h('span', { class: 'countdown', 'data-countdown': true }),
    ),
    q.paused ? h('p', { class: 'paused-banner', role: 'status' }, '⏸ Paused by the quiz master. The clock is stopped.') : null,
    s.wagerInfo?.amount ? h('p', { class: 'wager-banner' }, `🎲 ${s.wagerInfo.amount} points on the line`) : null,
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
          closed ? 'Waiting for the reveal…' : 'Waiting for the other teams…',
        )
      : null,
  );
}

/** Buzzin': one huge button. The first team to press it answers out loud. */
function buzzerScreen(s, q) {
  const b = q.buzz ?? { state: 'ready' };
  const labels = {
    ready: 'BUZZ!',
    queued: `Buzzed! ${ordinal(b.position ?? 2)} in line`,
    answering: "YOU'RE ANSWERING!",
    locked: "You're out for this question",
  };
  const status = {
    ready: b.answering ? `${b.answering} is answering…` : 'Get ready…',
    queued: b.answering ? `${b.answering} is answering. You're next if they get it wrong.` : 'Waiting to see who was first…',
    answering: 'Say your answer out loud to the quiz master.',
    locked: b.answering ? `${b.answering} is answering…` : 'Wait for the next question.',
  }[b.state];
  return h(
    'section',
    { class: 'screen center buzzer-screen' },
    h('div', { class: 'question-top' }, questionHeader(q), h('span', { class: 'countdown', 'data-countdown': true })),
    q.paused && !b.answering ? h('p', { class: 'paused-banner', role: 'status' }, '⏸ Paused by the quiz master.') : null,
    h('h2', { class: 'question-text' }, q.text),
    h(
      'button',
      {
        class: `big-buzzer ${b.state}`,
        type: 'button',
        disabled: b.state !== 'ready' || Boolean(q.paused),
        onclick: () => {
          if (navigator.vibrate) navigator.vibrate(60);
          if (!socket.send({ t: 'buzz', elapsedMs: elapsedMs() })) showNotice('Not connected. Try again in a moment.');
        },
      },
      labels[b.state],
    ),
    h('p', { class: 'muted' }, status),
  );
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

    case 'number':
    case 'nearest': {
      if (locked) return null;
      const valid = (text) => /^-?\d+([.,]\d+)?$/.test(text.trim());
      const submit = (event) => {
        event.preventDefault();
        if (valid(draftText)) sendAnswer(Number(draftText.trim().replace(',', '.')));
        else showNotice('Type a number: digits only, with a minus sign or decimal point if you need one.');
      };
      return h(
        'form',
        { class: 'text-answer', onsubmit: submit },
        q.type === 'nearest' ? h('p', { class: 'muted small center' }, 'The closest guess wins. Speed doesn\'t matter.') : null,
        h('input', {
          name: 'answer',
          'aria-label': 'Your answer, a number',
          placeholder: 'Type a number',
          value: draftText,
          inputmode: 'decimal',
          maxlength: '20',
          autocomplete: 'off',
          enterkeyhint: 'send',
          oninput: (e) => (draftText = e.target.value),
        }),
        h('button', { class: 'primary', type: 'submit' }, 'Submit answer'),
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
        avatar(row.name, row.photo, 30),
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
