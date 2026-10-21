import { LETTER_GROUPS, optionsSize, questionPicture, questionMeta, textSize, confetti, flashSpeedster, movement, prizeList, rollStandings, seconds, avatar, brandBlock, breakPanel, connectSocket, getBranding, h, LETTERS, loadBranding, ordinal, preload, prepareTeamPhoto, setBreak, setDeadline, tick } from './common.js';

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
      lobby: state.pendingAdmission ? 'Waiting for the quiz master to admit your team.' : "You're in. Waiting for the quiz master to start.",
      reading: 'The quiz master is asking the question. The timer has not started.',
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

/** This page's own view of its device, sent with a join so the server's phones-only check can let a tablet in desktop mode through. */
function onPhone() {
  return navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
}
let notice = '';
let noticeTimer;
let lastRenderKey = '';
let photoBusy = false;
let pendingJoin = null; // A join or rejoin tapped before the connection was ready.
let connected = false;
let stopped = false; // This page is done with the server (quiz over, kicked or replaced).
// The join form remembers what this phone used last time, so a new night starts with the team name already filled in.
const NAME_KEY = 'pubquiz.team-name';
const readSaved = (key) => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const form = { room: (params.get('room') ?? '').toUpperCase(), name: readSaved(NAME_KEY), code: '', rejoining: false };

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
    if (token) socket.send({ t: 'rejoin', token, phone: onPhone() });
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
        try {
          if (message.teamName) localStorage.setItem(NAME_KEY, message.teamName);
        } catch {
          // Not remembered; nothing else is affected.
        }
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
  flashSpeedster(state);
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
  const key = JSON.stringify([state && { ...state, question, preloadImage: 0 }, ended, joinError, notice, pending, draftOrder, !!token, pendingJoin, connected, getBranding(), photoBusy, draftWager, quizRunning]);
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
    { class: `team-layout${state.phase === 'open' ? ' phase-open' : ''}` },
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
    submitWhenConnected({ t: 'rejoin', code: form.code, phone: onPhone() });
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

// The home page needs no room code: there is only one quiz. It checks whether one is running, and keeps checking.
let quizRunning;
let statusTimer;
function watchForQuiz() {
  if (statusTimer) return;
  const check = async () => {
    try {
      const { running } = await (await fetch('/status.json', { cache: 'no-store' })).json();
      if (running !== quizRunning) {
        quizRunning = running;
        if (!state) render();
      }
    } catch {
      // Offline for a moment: leave things as they are.
    }
  };
  void check();
  statusTimer = setInterval(() => {
    if (state || ended) return clearInterval(statusTimer), (statusTimer = undefined);
    void check();
  }, 4000);
}

function joinForm() {
  if (form.rejoining) return rejoinForm();
  const submit = (event) => {
    event.preventDefault();
    joinError = '';
    submitWhenConnected({ t: 'join', room: form.room, name: form.name, phone: onPhone() });
    lastRenderKey = '';
    render();
  };
  watchForQuiz();

  return h(
    'form',
    { class: 'screen join', onsubmit: submit },
    brandBlock(),
    h('h1', {}, 'Join the quiz'),
    quizRunning === false ? h('p', { class: 'muted', role: 'status' }, 'No quiz is running yet. Stay on this page: it will let you in as soon as the quiz master starts one.') : null,
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
    h('button', { class: 'primary', type: 'submit', disabled: Boolean(pendingJoin) || quizRunning === false }, joinButtonLabel('Join')),
    h('p', { class: 'muted small' }, 'One phone per team.'),
    h('button', { class: 'link-button', type: 'button', onclick: () => switchForm(true) }, 'Already joined? Rejoin with your team code'),
  );
}

function questionHeader(q) {
  return questionMeta(q);
}

function questionImage(q, phase) {
  return q.image ? questionPicture(q, phase) : null;
}

/** Joined, but the quiz master has to confirm the entry fee before the team is in. */
function waitingScreen(s) {
  return h(
    'section',
    { class: 'screen center waiting-card' },
    brandBlock(),
    h('h1', {}, 'Nearly there!'),
    s.entryFee ? [h('p', {}, 'The entry fee is'), h('p', { class: 'waiting-fee' }, s.entryFee)] : null,
    h('p', {}, s.entryFee ? ['Pay the quiz master ', h('strong', {}, s.entryFee), ' and they will let your team in.'] : 'The quiz master will let your team in shortly.', ' This screen updates by itself.'),
    h('p', { class: 'muted' }, `Your team: ${s.teamName}`),
  );
}

function phaseView(s) {
  const q = s.question;
  switch (s.phase) {
    case 'lobby':
      if (s.pendingAdmission) return waitingScreen(s);
      return h(
        'section',
        { class: 'screen center' },
        brandBlock(),
        h('h1', {}, "You're in!"),
        s.entryFee ? h('p', { class: 'entry-fee' }, '💷 Entry fee: ', h('strong', {}, s.entryFee)) : null,
        prizeList(s.prizes),
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
        r.points !== 0 ? h('p', { class: r.points < 0 ? 'points lost' : 'points' }, r.points > 0 ? `+${r.points}` : String(r.points)) : null,
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
        standingsList(s.standings, s.teamId, final ? Infinity : 10, `${s.quizTitle}:${s.phase}:${s.question?.index ?? ''}`),
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
    questionMeta(q),
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
/** "🔒 Locked in · 2.32 s · waiting for others", in one line. */
function lockedLine(s, closed) {
  return h(
    'p',
    { class: 'locked-line', role: 'status' },
    '🔒 Locked in',
    // The answer itself is already showing on the keys or the number display.
    s.myAnswerMs != null ? [' · ', h('strong', { class: 'answer-time' }, seconds(s.myAnswerMs))] : null,
    h('span', { class: 'muted' }, closed ? ' · waiting for the reveal' : ' · waiting for others'),
  );
}

function questionScreen(s, q, closed) {
  const answered = s.myAnswerText != null || pending != null;
  const reading = s.phase === 'reading';
  const locked = closed || answered || reading || Boolean(q.paused);
  const keypadType = ['letter', 'number', 'nearest'].includes(q.type);
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
    q.halveOnWrong ? h('p', { class: 'halve-banner', role: 'note' }, '⚠ One wrong answer halves your score for this round') : null,
    q.type === 'music' ? h('p', { class: 'music-badge' }, '🎵 Listen to the music') : null,
    h('h2', { class: `question-text ${textSize(q.text)}` }, q.text),
    questionImage(q, s.phase),
    // On the keypad screens the message sits above the keys, in one short line, so nothing pushes the keys off the screen.
    answered && keypadType ? lockedLine(s, closed) : null,
    answerInput(s, q, locked),
    answered && !keypadType
      ? h(
          'p',
          { class: 'center muted' },
          s.myAnswerText && q.type !== 'multiple-choice' && q.type !== 'letter'
            ? ['Locked in: ', h('strong', {}, s.myAnswerText), '. ']
            : 'Answer locked in. ',
          s.myAnswerMs != null ? h('strong', { class: 'answer-time' }, `Your time: ${seconds(s.myAnswerMs)}. `) : null,
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
    h('h2', { class: `question-text ${textSize(q.text)}` }, q.text),
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

// Ordering questions: moving an item slides the others into place instead of jumping.
function rowRects() {
  const rects = new Map();
  for (const li of document.querySelectorAll('.reorder-item')) rects.set(li.dataset.item, li.getBoundingClientRect().top);
  return rects;
}

function glide(before) {
  for (const li of document.querySelectorAll('.reorder-item')) {
    const was = before.get(li.dataset.item);
    if (was === undefined) continue;
    const delta = was - li.getBoundingClientRect().top;
    if (!delta) continue;
    li.style.transition = 'none';
    li.style.transform = `translateY(${delta}px)`;
    requestAnimationFrame(() => {
      li.style.transition = 'transform 0.18s ease-out';
      li.style.transform = '';
    });
  }
}

function moveItem(from, to) {
  if (to < 0 || to >= draftOrder.length || from === to) return;
  const before = rowRects();
  const next = [...draftOrder];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  draftOrder = next;
  render();
  glide(before);
  const moved = document.querySelector(`.reorder-item[data-item="${item}"]`);
  moved?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Dragging: pick a row up anywhere, it follows the finger and the others slide out of its way; it drops into the slot it is over. */
function startDrag(event, position) {
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  const row = event.currentTarget;
  const rows = [...document.querySelectorAll('.reorder-item')];
  const rects = rows.map((r) => r.getBoundingClientRect());
  const startY = event.clientY;
  const step = rects[position].height + 8; // a row plus the gap between rows
  let target = position;
  row.setPointerCapture?.(event.pointerId);
  row.classList.add('dragging');
  rows.forEach((r) => r !== row && r.classList.add('shifting'));
  const onMove = (e) => {
    const dy = e.clientY - startY;
    row.style.transform = `translateY(${dy}px)`;
    const centre = rects[position].top + rects[position].height / 2 + dy;
    target = rects.findIndex((r) => centre < r.top + r.height);
    if (target < 0) target = rows.length - 1;
    rows.forEach((r, i) => {
      if (r === row) return;
      const shift = position < target && i > position && i <= target ? -step : position > target && i < position && i >= target ? step : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  const onUp = () => {
    row.removeEventListener('pointermove', onMove);
    row.removeEventListener('pointerup', onUp);
    row.removeEventListener('pointercancel', onUp);
    rows.forEach((r) => {
      r.classList.remove('shifting', 'dragging');
      r.style.transform = '';
    });
    moveItem(position, target);
  };
  row.addEventListener('pointermove', onMove);
  row.addEventListener('pointerup', onUp);
  row.addEventListener('pointercancel', onUp);
}

/** Without a finger: a focused row moves with the up and down arrow keys. */
function reorderKey(event, position) {
  const to = event.key === 'ArrowUp' ? position - 1 : event.key === 'ArrowDown' ? position + 1 : null;
  if (to === null) return;
  event.preventDefault();
  const item = draftOrder[position];
  moveItem(position, to);
  document.querySelector(`.reorder-item[data-item="${item}"]`)?.focus();
}

function answerInput(s, q, locked) {
  switch (q.type) {
    case 'multiple-choice': {
      const chosen = s.myChoice ?? pending;
      return h(
        'div',
        { class: `options ${optionsSize(q.options)}` },
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
        locked ? null : h('p', { class: 'muted small center keypad-hint' }, 'Tap the first letter of the answer.', h('span', { class: 'hint-long' }, ' Skip "The"; people go by first name (J for John Lennon).')),
        h(
          'div',
          { class: q.keypad === 'single' ? 'keypad' : 'keypad grouped' },
          (q.keypad === 'single' ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'] : LETTER_GROUPS).map((letter) =>
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
      const valid = (text) => /^-?\d+([.,]\d+)?$/.test(text.trim());
      // Once locked in (or time is up) the keypad stays, greyed out, showing what was sent.
      if (locked && s.myAnswerText != null) draftText = s.myAnswerText;
      const display = h('output', { class: `num-display${locked ? ' locked' : ''}`, 'aria-label': 'Your answer', 'aria-live': 'polite' }, draftText);
      const show = () => {
        display.textContent = draftText;
        display.classList.toggle('empty', !draftText);
      };
      const press = (key) => {
        if (locked) return;
        if (key === 'C') draftText = '';
        else if (draftText.length < 20) {
          if (key === '-' && draftText !== '') return;
          if (key === '.' && (draftText.includes('.') || draftText === '' || draftText === '-')) return;
          draftText += key;
        }
        show();
      };
      const enter = () => {
        if (locked) return;
        if (valid(draftText)) sendAnswer(Number(draftText.trim().replace(',', '.')));
        else showNotice('Enter a number first.');
      };
      const key = (label, extra = '', onclick = () => press(label)) => h('button', { type: 'button', class: `key num-key${extra}`, disabled: locked, onclick }, label);
      show();
      return h(
        'div',
        { class: 'numpad' },
        q.type === 'nearest' ? h('p', { class: 'muted small center' }, "The closest guess wins. Speed doesn't matter.") : null,
        display,
        h(
          'div',
          { class: 'num-grid' },
          ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => key(d)),
          key('C', ' alt'),
          key('0'),
          key('enter', ' alt enter', enter),
        ),
        h('div', { class: 'num-extra' }, key('−', ' small', () => press('-')), key('.', ' small')),
      );
    }

    case 'ordering': {
      // Every item is already on the list. The team moves them into the right order (first at the top) and locks it in.
      if (draftOrder.length !== q.items.length) draftOrder = q.items.map((_, i) => i);
      return h(
        'div',
        { class: `ordering reorder${locked ? ' locked' : ''}` },
        locked ? null : h('p', { class: 'muted small center' }, 'Drag the items into order, first at the top.'),
        h(
          'ol',
          { class: 'reorder-list' },
          draftOrder.map((item, position) =>
            h(
              'li',
              {
                class: 'reorder-item',
                'data-item': String(item),
                ...(locked ? {} : { tabindex: '0', title: 'Drag to move', 'aria-label': `${q.items[item]}, position ${position + 1} of ${q.items.length}. Use the up and down arrow keys to move it.`, onpointerdown: (e) => startDrag(e, position), onkeydown: (e) => reorderKey(e, position) }),
              },
              h('span', { class: 'slot-number' }, position + 1),
              h('span', { class: 'reorder-text' }, q.items[item]),
              locked ? null : h('span', { class: 'drag-handle', 'aria-hidden': 'true' }, '⠿'),
            ),
          ),
        ),
        locked ? null : h('button', { class: 'primary', onclick: () => sendAnswer(draftOrder) }, 'Lock in this order'),
      );
    }
  }
  return null;
}

function standingsList(rows, myTeamId, limit, key) {
  const shown = rows.filter((row, i) => i < limit || row.teamId === myTeamId);
  return rollStandings(shown, {
    key,
    rowClass: (row) => (row.teamId === myTeamId ? 'me' : ''),
    cells: (row, score) => [h('span', { class: 'rank' }, row.rank), avatar(row.name, row.photo, 30), h('span', { class: 'name' }, row.name), movement(row), score],
  });
}

// Colours and logo first, so the page never flashes the default look.
loadBranding().then((b) => {
  if (b.name) document.title = b.name;
  render();
});
render();
