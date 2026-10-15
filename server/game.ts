import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { checkTeamName, MAX_NAME_LENGTH } from './limits.ts';
import { matchAnswer, normalise } from './matching.ts';
import type { AnswerValue, BreakView, HostView, Phase, QuestionView, ReviewGroup, StandingRow, TeamView } from './protocol.ts';
import { isTextAnswer, LETTER_GROUPS, ORDERING_ITEMS, POINTS_UNIT, type Question, type Quiz } from './quiz.ts';
import { scoreAnswer } from './scoring.ts';

export const MAX_TEAMS = 30;
export { MAX_NAME_LENGTH };
export const MAX_TEXT_ANSWER = 100;
/**
 * Most network delay we'll subtract from a team's answer time. Also how long a question stays
 * open after its deadline, so an answer sent in time over a slow connection still counts.
 * Capped so a team can't fake a huge delay to buy time.
 */
export const MAX_LATENCY_MS = 1500;
/** How far a phone's own answer time may stray below the server's bound before it's not trusted. */
export const CLIENT_TIME_TOLERANCE_MS = 150;
export const MAX_EXTEND_SECONDS = 120;
/** In a wager round a team may always bet at least this much, so a team on zero can still play. */
/** "Close early" still waits this long for a phone that just dropped before it counts the team out. */
export const REJOIN_GRACE_MS = 6000;
export const WAGER_FLOOR = POINTS_UNIT / 5;
/** Buzzes that arrive within this long of the first are ordered by their latency-adjusted time, not arrival. */
export const BUZZ_WINDOW_MS = 120;
/** Share of the fastest-team bonus for 1st, 2nd and 3rd quickest. */
const FAST_SHARES = [1, 0.6, 0.3];
/** 1234.5 → "1234.5", without floating-point dust like 0.30000000000000004. */
const formatNumber = (n: number) => String(Number(n.toPrecision(12)));
const FAST_NAMES = ['Fastest', 'Second fastest', 'Third fastest'];

export interface Answer {
  /** Multiple choice: option index. Text: what the team typed. Ordering: original item indices in the team's order. */
  value: AnswerValue;
  answerMs: number;
}

export interface Team {
  id: string;
  token: string;
  /** Short code a team can type to rejoin from another phone or a new link. */
  code: string;
  name: string;
  connected: boolean;
  /** When the phone last dropped, so a brief blip doesn't make "close early" leave the team behind. */
  leftAt?: number;
  /** Keyed by question index. */
  answers: Map<number, Answer>;
}

interface Marked {
  correct: boolean;
  points: number;
  detail?: string;
}

/** A Buzzin' question in progress. */
interface BuzzState {
  /** Teams that have buzzed and are waiting their turn, in order. */
  queue: string[];
  /** Teams that answered wrongly and are out for this question. */
  locked: string[];
  /** The team answering right now (the clock is held while they do). */
  current?: string;
  /** The clock was paused because a team is answering, so it must be resumed when they're judged. */
  autoPaused: boolean;
  winner?: string;
}

export interface GameSnapshot {
  version: 1;
  phase: Phase;
  questionIndex: number;
  openedAt: number;
  endsAt: number;
  teams: { id: string; token: string; code: string; name: string; answers: [number, Answer][] }[];
  sentAt: [string, number][];
  pausedAt?: number;
  skipped?: number[];
  photos?: [string, number][];
  photosEnabled?: boolean;
  answerEdits?: [number, number | string][];
  break?: { startedAt: number; durationMs?: number; facts: string[] };
  wagers?: [number, [string, number][]][];
  tvShowTeams?: boolean;
  readOut?: boolean;
  startOnLastAnswer?: boolean;
  joiningLocked?: boolean;
  lockOnStart?: boolean;
  prizes?: string[];
  entryFee?: string;
  requireAdmission?: boolean;
  pending?: { id: string; token: string; code: string; name: string; answers: [number, Answer][] }[];
  closeEarly?: boolean;
  readShown?: number;
  buzz?: [number, BuzzState][];
  displayOrders: [number, number[]][];
  overrides: [number, [string, boolean][]][];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface GameOptions {
  now?: () => number;
  /** Called after every state change, so the server can push fresh views. */
  onChange?: () => void;
  /** Turn the team-name word filter off (invisible characters are always removed). Default on. */
  nameFilter?: boolean;
  /** End a question as soon as every team has answered (default on here; the server turns it off so the clock always runs down). */
  closeEarly?: boolean;
  /** Show the team list on the TV screen (default on here; the server turns it off). */
  tvShowTeams?: boolean;
  /** Pressing Start quiz stops new teams joining (default off here; the server turns it on). */
  lockOnStart?: boolean;
}

// No I, O, 0 or 1, so codes can't be misread.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const TEAM_CODE_LENGTH = 6;

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function shuffledOrder(length: number): number[] {
  for (;;) {
    const order = Array.from({ length }, (_, i) => i);
    for (let i = length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    // Never show an ordering question already in the right order.
    if (order.some((v, i) => v !== i)) return order;
  }
}

function answerText(q: Question): string {
  switch (q.type) {
    case 'multiple-choice':
      return q.options[q.answer]!;
    case 'picture':
    case 'music':
      return q.accept.join(' / ');
    case 'ordering':
      return q.items.join(' → ');
    case 'letter':
      return `${q.letter}: ${q.answer}`;
    case 'number':
      return q.tolerance > 0 ? `${q.answer} (give or take ${q.tolerance})` : String(q.answer);
    case 'nearest':
      return String(q.answer);
    case 'buzzer':
      return q.answer;
  }
}

/**
 * Server-authoritative quiz state.
 * lobby → open → closed → reveal → leaderboard → open (next question) … → finished
 */
export class Game {
  readonly quiz: Quiz;
  phase: Phase = 'lobby';
  questionIndex = -1;

  private readonly teams = new Map<string, Team>();
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly nameFilter: boolean;
  private openedAt = 0;
  private endsAt = 0;
  /** When each team received the current question; answer time is measured from here. */
  private sentAt = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  /** Ordering questions: displayed position → original item index, per question. */
  private readonly displayOrders = new Map<number, number[]>();
  /** Set while the host has the clock paused. */
  private pausedAt: number | undefined;
  /** Correct answers the host changed, by question index. */
  private readonly answerEdits = new Map<number, number | string>();
  /** Show the team list on the TV screen. The host can hide it. */
  tvShowTeams = true;
  /** Multiple choice: announce the answers one by one before the timer starts. */
  readOut = false;
  /** Close a question once every team has answered, rather than always counting down. */
  closeEarly = true;
  private readShown = 0;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  /** In read-out mode, showing the last multiple-choice answer starts the timer. */
  startOnLastAnswer = true;
  /** The host has closed the door: no new teams can join (teams already in can still rejoin). */
  joiningLocked = false;
  /** What it costs to play, shown on the start screen ('' for free). */
  entryFee = '';
  /** Teams wait in `pending` until the host admits them (after they've paid). */
  requireAdmission = false;
  readonly pending = new Map<string, Team>();
  /** Optional prizes for 1st, 2nd and 3rd ('' when not set). */
  prizes: string[] = ['', '', ''];
  /** Pressing Start quiz locks joining (the host can untick this in the lobby). */
  lockOnStart = false;
  /** teamId → photo version, for teams that have uploaded one. The pictures themselves are in the PhotoStore. */
  private readonly photoVersions = new Map<string, number>();
  /** Set while the host has the quiz on a break: when it started, how long it is meant to last, and its facts. */
  private breakState: { startedAt: number; durationMs?: number; facts: string[] } | undefined;
  /** Wager rounds: what each team bet, by question index. */
  private readonly wagers = new Map<number, Map<string, number>>();
  /** Buzzin' questions, by question index. */
  private readonly buzzStates = new Map<number, BuzzState>();
  private buzzTimer: NodeJS.Timeout | undefined;
  /** The host can switch photos off for the whole quiz. */
  photosEnabled = true;
  /** Questions the host skipped: nobody scores on them. */
  private readonly skipped = new Set<number>();
  /** The first correct team per question ("first" scoring), cleared whenever anything changes. */
  private firstCorrectMemo = new Map<number, string[]>();
  /** Host marking of typed answers, per question, keyed by normalised answer. */
  private readonly overrides = new Map<number, Map<string, boolean>>();

  constructor(quiz: Quiz, options: GameOptions = {}) {
    this.quiz = quiz;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => {});
    this.nameFilter = options.nameFilter ?? true;
    this.readOut = quiz.readOut ?? false;
    this.startOnLastAnswer = quiz.startOnLastAnswer ?? true;
    this.closeEarly = quiz.closeEarly ?? options.closeEarly ?? true;
    this.lockOnStart = options.lockOnStart ?? false;
    this.prizes = [0, 1, 2].map((i) => quiz.prizes?.[i] ?? '');
    this.entryFee = quiz.entryFee ?? '';
    this.tvShowTeams = options.tvShowTeams ?? true;
  }

  /** The question as it stands now: the host may have changed its correct answer after time ran out. */
  get currentQuestion(): Question | undefined {
    return this.effectiveQuestion(this.questionIndex);
  }

  private effectiveQuestion(index: number): Question | undefined {
    const q = this.quiz.questions[index];
    const edit = this.answerEdits.get(index);
    if (!q || edit === undefined) return q;
    switch (q.type) {
      case 'multiple-choice':
      case 'number':
      case 'nearest':
        return { ...q, answer: edit as number };
      case 'letter':
        return { ...q, letter: edit as string };
      default:
        return q;
    }
  }

  /**
   * The host changes which answer is correct, after the question closes and before (or even after) the reveal.
   * Multiple choice: the position of the right option. Letter: the letter. Number and nearest: the number.
   */
  setAnswer(value: number | string): Result<null> {
    const original = this.quiz.questions[this.questionIndex];
    if (!original || !['closed', 'reveal', 'leaderboard'].includes(this.phase)) return fail('The answer can be changed once time is up.');
    switch (original.type) {
      case 'multiple-choice':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= original.options.length) return fail('That is not one of the options.');
        break;
      case 'letter':
        if (typeof value !== 'string' || !/^[A-Za-z]$/.test(value)) return fail('Use a single letter.');
        value = value.toUpperCase();
        break;
      case 'number':
      case 'nearest':
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) return fail('Use a number.');
        break;
      default:
        return fail("This kind of question's answer can't be changed here.");
    }
    const same = original.type === 'letter' ? value === original.letter : value === (original as { answer: number }).answer;
    if (same) this.answerEdits.delete(this.questionIndex);
    else this.answerEdits.set(this.questionIndex, value);
    this.changed();
    return { ok: true, value: null };
  }

  // Teams

  join(rawName: string): Result<Team> {
    const checked = checkTeamName(rawName, { filterWords: this.nameFilter });
    if (!checked.ok) return fail(checked.error);
    const name = checked.name;
    if (this.phase === 'finished') return fail('This quiz has finished.');
    if (this.joiningLocked) return fail('The quiz master has closed the quiz to new teams. If your team is already in, use "Rejoin with your team code".');
    if (this.teams.size + this.pending.size >= MAX_TEAMS) return fail(`This quiz is full (${MAX_TEAMS} teams).`);
    const lower = name.toLowerCase();
    if ([...this.teams.values(), ...this.pending.values()].some((t) => t.name.toLowerCase() === lower)) {
      return fail('That team name is taken. Pick another.');
    }

    const team: Team = {
      id: randomUUID(),
      token: randomBytes(18).toString('base64url'),
      code: this.newTeamCode(),
      name,
      connected: true,
      answers: new Map(),
    };
    if (this.requireAdmission) {
      this.pending.set(team.id, team);
      this.changed();
      return { ok: true, value: team };
    }
    this.teams.set(team.id, team);
    this.markSent(team);
    this.changed();
    return { ok: true, value: team };
  }

  private newTeamCode(): string {
    for (;;) {
      const code = Array.from({ length: TEAM_CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      if (![...this.teams.values(), ...this.pending.values()].some((t) => t.code === code)) return code;
    }
  }

  /** Finds a team by the token its phone saved, or by the team code typed in. */
  rejoin(credential: { token?: string; code?: string }): Team | undefined {
    const code = credential.code?.trim().toUpperCase();
    const team = [...this.teams.values(), ...this.pending.values()].find(
      (t) => (credential.token !== undefined && t.token === credential.token) || (code !== undefined && t.code === code),
    );
    if (!team) return undefined;
    team.connected = true;
    team.leftAt = undefined;
    if (this.teams.has(team.id)) this.markSent(team);
    this.changed();
    return team;
  }

  disconnect(teamId: string): void {
    const team = this.teams.get(teamId) ?? this.pending.get(teamId);
    if (!team) return;
    team.connected = false;
    team.leftAt = this.now();
    // If everyone else has answered, look again once the grace period is up.
    if (this.phase === 'open' && this.closeEarly) {
      clearTimeout(this.graceTimer);
      this.graceTimer = setTimeout(() => {
        if (this.phase === 'open' && this.everyoneAnswered()) this.closeQuestion();
      }, REJOIN_GRACE_MS + 50);
      this.graceTimer.unref?.();
    }
    this.changed();
  }

  kick(teamId: string): boolean {
    if (this.pending.delete(teamId)) {
      this.changed();
      return true;
    }
    if (!this.teams.delete(teamId)) return false;
    this.sentAt.delete(teamId);
    this.photoVersions.delete(teamId);
    this.dropFromBuzz(teamId);
    if (this.phase === 'open' && this.everyoneAnswered()) this.closeQuestion();
    else this.changed();
    return true;
  }

  /** Records (or clears, with no version) that a team has a photo. */
  setPhoto(teamId: string, version?: number): void {
    if (!this.teams.has(teamId)) return;
    if (version === undefined) this.photoVersions.delete(teamId);
    else this.photoVersions.set(teamId, version);
    this.changed();
  }

  setCloseEarly(on: boolean): void {
    this.closeEarly = on;
    this.changed();
  }

  /** Sets the prizes for 1st, 2nd and 3rd. Blank means none. */
  setPrizes(list: string[]): void {
    this.prizes = [0, 1, 2].map((i) => (list[i] ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 60));
    this.changed();
  }

  private prizesView(): string[] | undefined {
    return this.prizes.some(Boolean) ? this.prizes : undefined;
  }

  /** Lets a waiting team in (the host has checked it has paid). */
  admit(teamId: string): boolean {
    const team = this.pending.get(teamId);
    if (!team) return false;
    this.pending.delete(teamId);
    this.teams.set(team.id, team);
    this.markSent(team);
    this.changed();
    return true;
  }

  admitAll(): void {
    for (const id of [...this.pending.keys()]) this.admit(id);
  }

  setEntryFee(fee: string): void {
    this.entryFee = fee.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 40);
    this.changed();
  }

  /** With this on, new teams wait to be admitted. Turning it off lets everyone waiting in. */
  setRequireAdmission(on: boolean): void {
    this.requireAdmission = on;
    if (!on) this.admitAll();
    this.changed();
  }

  setLockOnStart(on: boolean): void {
    this.lockOnStart = on;
    this.changed();
  }

  setJoiningLocked(locked: boolean): void {
    this.joiningLocked = locked;
    this.changed();
  }

  setStartOnLastAnswer(on: boolean): void {
    this.startOnLastAnswer = on;
    this.changed();
  }

  setReadOut(on: boolean): void {
    this.readOut = on;
    this.changed();
  }

  /** Read-out mode: shows the next answer, or starts the timer once they are all showing. */
  private advanceReading(): void {
    const q = this.currentQuestion;
    if (q?.type === 'multiple-choice' && this.readShown < q.options.length) {
      this.readShown++;
      // With the option on, the last answer showing is the starting gun.
      if (this.startOnLastAnswer && this.readShown === q.options.length) this.beginPlay();
      else this.changed();
    } else this.beginPlay();
  }

  /** Starts the timer now, whatever is still hidden. */
  startTimerNow(): Result<null> {
    if (this.phase !== 'reading') return fail('The timer is not waiting to start.');
    this.beginPlay();
    return { ok: true, value: null };
  }

  setTvShowTeams(visible: boolean): void {
    this.tvShowTeams = visible;
    this.changed();
  }

  setPhotosEnabled(enabled: boolean): void {
    this.photosEnabled = enabled;
    this.changed();
  }

  /** Finds a team by its saved login without touching its connection state. */
  teamByToken(token: string): Team | undefined {
    return [...this.teams.values(), ...this.pending.values()].find((t) => t.token === token);
  }

  private photoUrl(teamId: string): string | undefined {
    const version = this.photoVersions.get(teamId);
    return this.photosEnabled && version !== undefined ? `/team-photo/${teamId}?v=${version}` : undefined;
  }

  getTeamNames(): string[] {
    return [...this.teams.values(), ...this.pending.values()].map((t) => t.name);
  }

  getTeam(teamId: string): Team | undefined {
    return this.teams.get(teamId) ?? this.pending.get(teamId);
  }

  // Play

  /**
   * `latencyMs` is the team's measured round trip. The question took about half of it to reach the
   * phone and the answer the other half to come back, so it's removed from the answer time.
   */
  answer(teamId: string, value: AnswerValue, latencyMs = 0, clientElapsedMs?: number): Result<null> {
    const team = this.teams.get(teamId);
    if (!team) return fail('Your team is not in this quiz.');
    const question = this.currentQuestion;
    if (this.phase !== 'open' || !question) return fail('This question is closed.');
    if (this.pausedAt !== undefined) return fail('The quiz master has paused the quiz.');
    if (team.answers.has(this.questionIndex)) return fail('Your team has already answered.');

    const stored = this.validate(question, value);
    if (!stored.ok) return stored;
    const timing = this.measure(teamId, latencyMs, clientElapsedMs);
    if (timing.late) return fail("Too late, time's up.");
    team.answers.set(this.questionIndex, { value: stored.value, answerMs: timing.answerMs });

    if (this.everyoneAnswered()) this.closeQuestion();
    else this.changed();
    return { ok: true, value: null };
  }

  /**
   * How long a team took, and whether it was too late. The phone times itself from when the question
   * appeared on its screen, so delivery delay never counts against it. It is only trusted if it fits what
   * the server saw: no more than the time since the question was sent, and no less than that minus the
   * round trip (and a small tolerance).
   */
  private measure(teamId: string, latencyMs: number, clientElapsedMs?: number): { answerMs: number; late: boolean } {
    const latency = Math.min(Math.max(latencyMs, 0), MAX_LATENCY_MS);
    const receivedAt = this.now();
    const sinceSent = receivedAt - (this.sentAt.get(teamId) ?? this.openedAt);
    let answerMs = Math.max(0, sinceSent - latency);
    if (
      clientElapsedMs !== undefined &&
      Number.isFinite(clientElapsedMs) &&
      clientElapsedMs >= Math.max(0, sinceSent - latency - CLIENT_TIME_TOLERANCE_MS) &&
      clientElapsedMs <= sinceSent
    ) {
      answerMs = clientElapsedMs;
    }
    return { answerMs, late: receivedAt - latency > (this.pausedAt === undefined ? this.endsAt : this.endsAt + (receivedAt - this.pausedAt)) };
  }

  // Buzzin' questions

  private buzzState(index: number): BuzzState {
    let state = this.buzzStates.get(index);
    if (!state) this.buzzStates.set(index, (state = { queue: [], locked: [], autoPaused: false }));
    return state;
  }

  /** The most a team may bet on the current question. */
  wagerCapFor(teamId: string): number {
    const team = this.teams.get(teamId);
    const q = this.quiz.questions[this.questionIndex];
    const own = team ? Math.max(this.scoreOf(team), WAGER_FLOOR) : WAGER_FLOOR;
    return Math.min(q?.wagerCap ?? Infinity, own);
  }

  /** A team bets points on the question it is about to see. A bet can't be changed once placed. */
  placeWager(teamId: string, amount: number): Result<null> {
    const team = this.teams.get(teamId);
    const question = this.quiz.questions[this.questionIndex];
    if (!team) return fail('Your team is not in this quiz.');
    if (this.phase !== 'wagering' || !question?.wager) return fail('There is nothing to bet on right now.');
    if (!Number.isInteger(amount) || amount < 0) return fail('Bet a whole number of points.');
    const cap = this.wagerCapFor(teamId);
    if (amount > cap) return fail(`You can bet at most ${cap}.`);
    let bets = this.wagers.get(this.questionIndex);
    if (!bets) this.wagers.set(this.questionIndex, (bets = new Map()));
    if (bets.has(teamId)) return fail('Your bet is already locked in.');
    bets.set(teamId, amount);
    this.changed();
    return { ok: true, value: null };
  }

  private wagerOf(index: number, teamId: string): number {
    return this.wagers.get(index)?.get(teamId) ?? 0;
  }

  /** A team that bet but never answered loses its bet. */
  private unansweredWagerLoss(team: Team, index: number): number {
    const q = this.quiz.questions[index];
    if (!q?.wager || this.skipped.has(index) || team.answers.has(index)) return 0;
    const bet = this.wagerOf(index, team.id);
    return bet ? -bet : 0;
  }

  /** A team presses the buzzer. */
  buzz(teamId: string, latencyMs = 0, clientElapsedMs?: number): Result<null> {
    const team = this.teams.get(teamId);
    const question = this.currentQuestion;
    if (!team) return fail('Your team is not in this quiz.');
    if (this.phase !== 'open' || question?.type !== 'buzzer') return fail('There is nothing to buzz right now.');
    const state = this.buzzState(this.questionIndex);
    if (this.pausedAt !== undefined && !state.autoPaused) return fail('The quiz master has paused the quiz.');
    if (state.locked.includes(teamId)) return fail("You're out for this question.");
    if (state.current === teamId || state.queue.includes(teamId)) return fail('You have already buzzed.');
    const timing = this.measure(teamId, latencyMs, clientElapsedMs);
    if (timing.late) return fail("Too late, time's up.");

    team.answers.set(this.questionIndex, { value: 'buzz', answerMs: timing.answerMs });
    state.queue.push(teamId);
    // Nobody is answering yet: wait a moment for any buzzes that were actually earlier but arrived later.
    if (!state.current && !this.buzzTimer) {
      this.buzzTimer = setTimeout(() => this.settleBuzz(this.questionIndex), BUZZ_WINDOW_MS);
    }
    this.changed();
    return { ok: true, value: null };
  }

  /** Picks who answers first, once the short window for near-simultaneous buzzes has passed. */
  private settleBuzz(index: number): void {
    clearTimeout(this.buzzTimer);
    this.buzzTimer = undefined;
    const state = this.buzzStates.get(index);
    if (!state || state.current || this.phase !== 'open' || index !== this.questionIndex) return;
    const time = (id: string) => this.teams.get(id)?.answers.get(index)?.answerMs ?? Infinity;
    state.queue.sort((a, b) => time(a) - time(b));
    this.promoteBuzzer(state);
    this.changed();
  }

  /** Hands the question to the next team in line, holding the clock while they answer. */
  private promoteBuzzer(state: BuzzState): void {
    while (state.queue.length && !this.teams.has(state.queue[0]!)) state.queue.shift();
    state.current = state.queue.shift();
    if (state.current && this.pausedAt === undefined) {
      this.pausedAt = this.now();
      state.autoPaused = true;
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** The host's verdict on the team that is answering. */
  judge(correct: boolean): Result<null> {
    const question = this.currentQuestion;
    const state = this.buzzStates.get(this.questionIndex);
    if (this.phase !== 'open' || question?.type !== 'buzzer') return fail('There is no buzzer question to judge.');
    if (!state?.current) return fail('No team is answering right now.');
    const team = this.teams.get(state.current);
    const answer = team?.answers.get(this.questionIndex);
    if (answer) answer.value = correct ? 'right' : 'wrong';
    if (correct) {
      state.winner = state.current;
      state.current = undefined;
      this.closeQuestion();
      return { ok: true, value: null };
    }
    state.locked.push(state.current);
    state.current = undefined;
    this.promoteBuzzer(state);
    if (!state.current) {
      // Nobody else is waiting: everyone who isn't out can buzz again, and the clock carries on.
      if (state.autoPaused && this.pausedAt !== undefined) {
        state.autoPaused = false;
        this.resumeClock();
      }
      const stillIn = [...this.teams.values()].filter((t) => t.connected && !state.locked.includes(t.id));
      if (stillIn.length === 0) {
        this.closeQuestion();
        return { ok: true, value: null };
      }
    }
    this.changed();
    return { ok: true, value: null };
  }

  /** A team that leaves a Buzzin' question (removed by the host) no longer holds up the others. */
  private dropFromBuzz(teamId: string): void {
    const state = this.buzzStates.get(this.questionIndex);
    if (!state || this.phase !== 'open') return;
    state.queue = state.queue.filter((id) => id !== teamId);
    state.locked = state.locked.filter((id) => id !== teamId);
    if (state.current === teamId) {
      state.current = undefined;
      this.promoteBuzzer(state);
      if (!state.current && state.autoPaused && this.pausedAt !== undefined) {
        state.autoPaused = false;
        this.resumeClock();
      }
    }
  }

  /** Checks an answer's shape and converts it to what is stored. */
  private validate(question: Question, value: AnswerValue): Result<AnswerValue> {
    switch (question.type) {
      case 'multiple-choice':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= question.options.length) {
          return fail('That is not one of the options.');
        }
        return { ok: true, value };
      case 'picture':
      case 'music': {
        if (typeof value !== 'string') return fail('Type an answer.');
        const text = value.trim().replace(/\s+/g, ' ');
        if (!text) return fail('Type an answer.');
        if (text.length > MAX_TEXT_ANSWER) return fail(`Answers can be at most ${MAX_TEXT_ANSWER} characters.`);
        return { ok: true, value: text };
      }
      case 'letter': {
        const key = typeof value === 'string' ? value.toUpperCase() : '';
        if (!/^[A-Z]$/.test(key) && !LETTER_GROUPS.includes(key)) return fail('Tap a key.');
        return { ok: true, value: key };
      }
      case 'number':
      case 'nearest':
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) return fail('Type a number.');
        return { ok: true, value };
      case 'buzzer':
        return fail('Press the buzzer.');
      case 'ordering': {
        const display = this.displayOrders.get(this.questionIndex)!;
        const valid =
          Array.isArray(value) &&
          value.length === ORDERING_ITEMS &&
          new Set(value).size === ORDERING_ITEMS &&
          value.every((v) => Number.isInteger(v) && v >= 0 && v < ORDERING_ITEMS);
        if (!valid) return fail(`Put all ${ORDERING_ITEMS} items in order.`);
        return { ok: true, value: value.map((d) => display[d]!) };
      }
    }
  }

  /** Host marks every typed answer that normalises to `key` as right or wrong. */
  mark(key: string, correct: boolean): Result<null> {
    const question = this.currentQuestion;
    if (!question || !isTextAnswer(question) || !['closed', 'reveal', 'leaderboard'].includes(this.phase)) {
      return fail('There are no typed answers to mark right now.');
    }
    const exists = [...this.teams.values()].some((t) => {
      const a = t.answers.get(this.questionIndex);
      return a && normalise(a.value as string) === key;
    });
    if (!exists) return fail('No team gave that answer.');
    let overrides = this.overrides.get(this.questionIndex);
    if (!overrides) this.overrides.set(this.questionIndex, (overrides = new Map()));
    overrides.set(key, correct);
    this.changed();
    return { ok: true, value: null };
  }

  /** The host's "next" button: moves to whatever comes after the current phase. */
  advance(): void {
    // The host's main button ends a break first, without moving the quiz on.
    if (this.breakState) {
      this.endBreak();
      return;
    }
    switch (this.phase) {
      case 'lobby':
        if (this.quiz.questions.length > 0) {
          if (this.lockOnStart) this.joiningLocked = true;
          this.openQuestion(0);
        }
        return;
      case 'wagering':
        this.beginReadingOrPlay();
        return;
      case 'reading':
        this.advanceReading();
        return;
      case 'open':
        this.closeQuestion();
        return;
      case 'closed':
        this.phase = 'reveal';
        break;
      case 'reveal':
        // With round-by-round leaderboards, go straight on unless this was the end of a round.
        if (this.quiz.leaderboard === 'round' && !this.isLastInRound(this.questionIndex)) {
          this.openQuestion(this.questionIndex + 1);
          return;
        }
        this.phase = 'leaderboard';
        break;
      case 'leaderboard':
        if (this.questionIndex + 1 < this.quiz.questions.length) {
          this.openQuestion(this.questionIndex + 1);
          return;
        }
        this.phase = 'finished';
        break;
      case 'finished':
        return;
    }
    this.changed();
  }

  get onBreak(): boolean {
    return this.breakState !== undefined;
  }

  /** The host puts the quiz on a break (between questions), with fun facts to show and an optional length. */
  startBreak(minutes: number | undefined, facts: string[]): Result<null> {
    if (!['lobby', 'reveal', 'leaderboard'].includes(this.phase)) return fail('A break can be taken between questions, not during one.');
    if (this.breakState) return fail('The quiz is already on a break.');
    if (minutes !== undefined && !(minutes >= 1 && minutes <= 60)) return fail('A break can be from 1 to 60 minutes.');
    this.breakState = { startedAt: this.now(), durationMs: minutes === undefined ? undefined : Math.round(minutes * 60_000), facts: facts.slice(0, 60) };
    this.changed();
    return { ok: true, value: null };
  }

  endBreak(): Result<null> {
    if (!this.breakState) return fail('The quiz is not on a break.');
    this.breakState = undefined;
    this.changed();
    return { ok: true, value: null };
  }

  private breakView(): BreakView | undefined {
    if (!this.breakState) return undefined;
    const elapsedMs = Math.max(0, this.now() - this.breakState.startedAt);
    return {
      facts: this.breakState.facts,
      elapsedMs,
      remainingMs: this.breakState.durationMs === undefined ? undefined : Math.max(0, this.breakState.durationMs - elapsedMs),
    };
  }

  /** The host asks for the full leaderboard after a reveal that would otherwise go straight on. */
  showLeaderboard(): Result<null> {
    if (this.phase !== 'reveal') return fail('The leaderboard can be shown after the answer is revealed.');
    this.phase = 'leaderboard';
    this.changed();
    return { ok: true, value: null };
  }

  /** Will the next press after the reveal skip the full leaderboard? */
  get skipsLeaderboardNext(): boolean {
    return this.quiz.leaderboard === 'round' && !this.isLastInRound(this.questionIndex);
  }

  private isLastInRound(index: number): boolean {
    return this.quiz.questions[index + 1]?.roundIndex !== this.quiz.questions[index]?.roundIndex;
  }

  // Host controls for a question in progress.

  get paused(): boolean {
    return this.pausedAt !== undefined;
  }

  /** Stops the clock for everyone. Teams can't answer until it's resumed. */
  pause(): Result<null> {
    if (this.phase !== 'open') return fail('There is no question to pause.');
    if (this.buzzStates.get(this.questionIndex)?.current) return fail('A team is answering. Judge them first.');
    if (this.pausedAt !== undefined) return fail('Already paused.');
    this.pausedAt = this.now();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.changed();
    return { ok: true, value: null };
  }

  /** Carries on from where it stopped: every deadline moves by the time spent paused. */
  resume(): Result<null> {
    if (this.pausedAt === undefined) return fail('Not paused.');
    if (this.buzzStates.get(this.questionIndex)?.current) return fail('A team is answering. Judge them first.');
    this.resumeClock();
    this.changed();
    return { ok: true, value: null };
  }

  private resumeClock(): void {
    if (this.pausedAt === undefined) return;
    const shift = this.now() - this.pausedAt;
    this.pausedAt = undefined;
    this.openedAt += shift;
    this.endsAt += shift;
    for (const [teamId, at] of this.sentAt) this.sentAt.set(teamId, at + shift);
    this.startTimer();
  }

  /** Adds time to the question in progress. */
  extend(seconds: number): Result<null> {
    if (this.phase !== 'open') return fail('There is no question to extend.');
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_EXTEND_SECONDS) {
      return fail(`Add between 1 and ${MAX_EXTEND_SECONDS} seconds.`);
    }
    this.endsAt += Math.round(seconds * 1000);
    if (this.pausedAt === undefined) this.startTimer();
    this.changed();
    return { ok: true, value: null };
  }

  /** Throws the current question away (it scores nothing for anyone) and moves straight on. */
  skip(): Result<null> {
    if (this.phase !== 'open' && this.phase !== 'closed' && this.phase !== 'wagering' && this.phase !== 'reading') return fail('Only a question that has not been revealed can be skipped.');
    this.skipped.add(this.questionIndex);
    clearTimeout(this.buzzTimer);
    this.buzzTimer = undefined;
    this.pausedAt = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.questionIndex + 1 < this.quiz.questions.length) this.openQuestion(this.questionIndex + 1);
    else {
      this.phase = 'finished';
      this.changed();
    }
    return { ok: true, value: null };
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.buzzTimer);
    clearTimeout(this.graceTimer);
  }

  // Saving and restoring, so a crash or restart mid-quiz loses nothing.

  snapshot(): GameSnapshot {
    return {
      version: 1,
      phase: this.phase,
      questionIndex: this.questionIndex,
      openedAt: this.openedAt,
      endsAt: this.endsAt,
      teams: [...this.teams.values()].map((t) => ({ id: t.id, token: t.token, code: t.code, name: t.name, answers: [...t.answers] })),
      sentAt: [...this.sentAt],
      pausedAt: this.pausedAt,
      skipped: [...this.skipped],
      photos: [...this.photoVersions],
      photosEnabled: this.photosEnabled,
      answerEdits: [...this.answerEdits],
      break: this.breakState,
      wagers: [...this.wagers].map(([index, bets]) => [index, [...bets]] as [number, [string, number][]]),
      tvShowTeams: this.tvShowTeams,
      readOut: this.readOut,
      startOnLastAnswer: this.startOnLastAnswer,
      joiningLocked: this.joiningLocked,
      lockOnStart: this.lockOnStart,
      prizes: this.prizes,
      entryFee: this.entryFee,
      requireAdmission: this.requireAdmission,
      pending: [...this.pending.values()].map((t) => ({ id: t.id, token: t.token, code: t.code, name: t.name, answers: [] })),
      closeEarly: this.closeEarly,
      readShown: this.readShown,
      buzz: [...this.buzzStates].map(([index, state]) => [index, structuredClone(state)] as [number, BuzzState]),
      displayOrders: [...this.displayOrders],
      overrides: [...this.overrides].map(([index, marks]) => [index, [...marks]]),
    };
  }

  /** Rebuilds a game from a snapshot. Every team starts disconnected until its phone rejoins. */
  static restore(quiz: Quiz, snapshot: GameSnapshot, options: GameOptions = {}): Game {
    const game = new Game(quiz, options);
    game.phase = snapshot.phase;
    game.questionIndex = snapshot.questionIndex;
    game.openedAt = snapshot.openedAt;
    game.endsAt = snapshot.endsAt;
    for (const t of snapshot.teams) {
      game.teams.set(t.id, { ...t, connected: false, answers: new Map(t.answers) });
    }
    game.sentAt = new Map(snapshot.sentAt);
    game.pausedAt = snapshot.pausedAt;
    for (const [id, version] of snapshot.photos ?? []) game.photoVersions.set(id, version);
    game.photosEnabled = snapshot.photosEnabled ?? true;
    for (const [index, value] of snapshot.answerEdits ?? []) game.answerEdits.set(index, value);
    game.breakState = snapshot.break;
    for (const [index, bets] of snapshot.wagers ?? []) game.wagers.set(index, new Map(bets));
    game.tvShowTeams = snapshot.tvShowTeams ?? game.tvShowTeams;
    game.readOut = snapshot.readOut ?? quiz.readOut ?? false;
    game.readShown = snapshot.readShown ?? 0;
    game.joiningLocked = snapshot.joiningLocked ?? false;
    game.lockOnStart = snapshot.lockOnStart ?? game.lockOnStart;
    game.prizes = snapshot.prizes ?? game.prizes;
    game.entryFee = snapshot.entryFee ?? game.entryFee;
    game.requireAdmission = snapshot.requireAdmission ?? false;
    for (const t of snapshot.pending ?? []) game.pending.set(t.id, { ...t, connected: false, answers: new Map() });
    game.startOnLastAnswer = snapshot.startOnLastAnswer ?? game.startOnLastAnswer;
    game.closeEarly = snapshot.closeEarly ?? game.closeEarly;
    for (const [index, state] of snapshot.buzz ?? []) game.buzzStates.set(index, structuredClone(state));
    for (const index of snapshot.skipped ?? []) game.skipped.add(index);
    for (const [index, order] of snapshot.displayOrders) game.displayOrders.set(index, order);
    for (const [index, marks] of snapshot.overrides) game.overrides.set(index, new Map(marks));
    if (game.phase === 'open' && game.pausedAt === undefined) game.startTimer();
    // A buzz that was still waiting out its short window when the program stopped is settled now.
    const buzzing = game.buzzStates.get(game.questionIndex);
    if (game.phase === 'open' && buzzing && !buzzing.current && buzzing.queue.length) game.settleBuzz(game.questionIndex);
    return game;
  }

  private openQuestion(index: number): void {
    const question = this.quiz.questions[index];
    if (!question) return;
    clearTimeout(this.buzzTimer);
    this.buzzTimer = undefined;
    this.questionIndex = index;
    this.pausedAt = undefined;
    this.sentAt = new Map();
    clearTimeout(this.timer);
    this.timer = undefined;
    if (question.wager) {
      // Teams see only the category and place their bets; the host then shows the question.
      this.phase = 'wagering';
      this.changed();
      return;
    }
    this.beginReadingOrPlay();
  }

  /** Read-out mode: the question is up but the clock waits while the host asks it (and reads the answers). */
  private beginReadingOrPlay(): void {
    if (this.readOut) {
      this.phase = 'reading';
      this.readShown = 0;
      this.changed();
      return;
    }
    this.beginPlay();
  }

  /** Starts the clock on the current question. */
  private beginPlay(): void {
    const index = this.questionIndex;
    const question = this.quiz.questions[index]!;
    this.phase = 'open';
    this.openedAt = this.now();
    this.endsAt = this.openedAt + question.seconds * 1000;
    if (question.type === 'ordering' && !this.displayOrders.has(index)) {
      this.displayOrders.set(index, shuffledOrder(question.items.length));
    }
    for (const team of this.teams.values()) this.markSent(team);
    this.startTimer();
    this.changed();
  }

  private startTimer(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.closeQuestion(), Math.max(0, this.endsAt + MAX_LATENCY_MS - this.now()));
  }

  private closeQuestion(): void {
    if (this.phase !== 'open') return;
    clearTimeout(this.buzzTimer);
    this.buzzTimer = undefined;
    const buzzing = this.buzzStates.get(this.questionIndex);
    if (buzzing) {
      // Closing while a team is mid-answer (or queued) ends the turn without a verdict.
      buzzing.current = undefined;
      buzzing.queue = [];
      buzzing.autoPaused = false;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pausedAt = undefined;
    this.phase = 'closed';
    this.changed();
  }

  /** A team that reconnects mid-question keeps its original start time, so reconnecting can't buy extra time. */
  private markSent(team: Team): void {
    if (this.phase === 'open' && team.connected && !this.sentAt.has(team.id)) {
      // Joining while paused counts from the moment the clock restarts (resume shifts this forward).
      this.sentAt.set(team.id, this.pausedAt ?? this.now());
    }
  }

  private everyoneAnswered(): boolean {
    if (!this.closeEarly) return false;
    if (this.currentQuestion?.type === 'buzzer') return false; // Ends when the host judges it, or everyone is out.
    // Teams that are connected, or only just dropped, still have to answer.
    const present = [...this.teams.values()].filter((t) => t.connected || (t.leftAt !== undefined && this.now() - t.leftAt < REJOIN_GRACE_MS));
    return present.length > 0 && present.every((t) => t.answers.has(this.questionIndex));
  }

  private changed(): void {
    this.firstCorrectMemo.clear();
    this.standingsMemo = undefined;
    this.onChange();
  }

  // Marking and scores

  private isCorrectText(questionIndex: number, accepted: string[], given: string): boolean {
    const override = this.overrides.get(questionIndex)?.get(normalise(given));
    return override ?? matchAnswer(given, accepted) !== 'none';
  }

  /** Points for an answer, including the bonus for being among the quickest correct teams. */
  private markAnswer(questionIndex: number, answer: Answer, team: Team): Marked {
    const marked = this.baseMark(questionIndex, answer);
    if (this.quiz.questions[questionIndex]?.wager && !this.skipped.has(questionIndex)) {
      // A wager question is all or nothing: win the bet for a right answer, lose it otherwise.
      const bet = this.wagerOf(questionIndex, team.id);
      const points = marked.correct ? bet : bet ? -bet : 0;
      return { correct: marked.correct, points, detail: bet === 0 ? 'No wager' : `Wagered ${bet}: ${marked.correct ? '+' : '-'}${bet}` };
    }
    if (!marked.correct) return marked;
    const bonus = this.fastBonusFor(questionIndex, team.id);
    if (!bonus) return marked;
    return { ...marked, points: marked.points + bonus.points, detail: [marked.detail, bonus.label].filter(Boolean).join(' · ') };
  }

  /** What a team earns for being among the quickest correct answers to a question, if anything. */
  private fastBonusFor(questionIndex: number, teamId: string): { points: number; label: string; place: number } | undefined {
    const q = this.quiz.questions[questionIndex]!;
    if (q.type === 'nearest' || q.type === 'buzzer') return undefined; // Closest wins / the host judges: being quick adds nothing.
    const order = this.fastestOrder(questionIndex);
    const place = order.indexOf(teamId);
    if (place < 0) return undefined;
    if (q.mode === 'first') {
      return place === 0 && this.quiz.bonus > 0 ? { points: this.quiz.bonus, label: '⚡ First correct answer: bonus!', place } : undefined;
    }
    if (place >= this.quiz.fastPlaces || this.quiz.fastBonus <= 0) return undefined;
    const points = Math.round(this.quiz.fastBonus * FAST_SHARES[place]!);
    return { points, label: `⚡ ${FAST_NAMES[place]} correct answer: +${points}`, place };
  }

  /** The guesses closest to the answer of a "nearest" question, and how far off they are. */
  private nearestWinners(questionIndex: number): { winners: Set<number>; best: number } {
    const q = this.effectiveQuestion(questionIndex)!;
    if (q.type !== 'nearest') return { winners: new Set(), best: 0 };
    let best = Infinity;
    for (const team of this.teams.values()) {
      const answer = team.answers.get(questionIndex);
      if (answer) best = Math.min(best, Math.abs((answer.value as number) - q.answer));
    }
    const winners = new Set<number>();
    for (const team of this.teams.values()) {
      const answer = team.answers.get(questionIndex);
      if (answer && Math.abs((answer.value as number) - q.answer) === best) winners.add(answer.value as number);
    }
    return { winners, best: best === Infinity ? 0 : best };
  }

  /** Teams with a correct answer, quickest first (ties go to whoever joined first). */
  private fastestOrder(questionIndex: number): string[] {
    const memo = this.firstCorrectMemo.get(questionIndex);
    if (memo) return memo;
    const correct: { id: string; ms: number }[] = [];
    for (const team of this.teams.values()) {
      const answer = team.answers.get(questionIndex);
      if (answer && this.baseMark(questionIndex, answer).correct) correct.push({ id: team.id, ms: answer.answerMs });
    }
    const order = correct.sort((a, b) => a.ms - b.ms).map((c) => c.id);
    this.firstCorrectMemo.set(questionIndex, order);
    return order;
  }

  /** The team that gave the quickest right answer on the question just revealed, to flash up on every screen. */
  speedster(): { name: string; photo?: string; ms: number } | undefined {
    const index = this.questionIndex;
    if (this.phase !== 'reveal' || index < 0 || this.teams.size < 1 || this.skipped.has(index)) return undefined;
    const q = this.effectiveQuestion(index);
    if (!q || q.type === 'buzzer' || q.type === 'nearest') return undefined;
    const id = this.fastestOrder(index)[0];
    const team = id ? this.teams.get(id) : undefined;
    return team ? { name: team.name, photo: this.photoUrl(team.id), ms: Math.round(team.answers.get(index)!.answerMs) } : undefined;
  }

  /** For the host and TV: who earned the speed bonus on the question just revealed. */
  fastestTeams(): { name: string; points: number; place: number; photo?: string; ms: number }[] {
    if (!this.isRevealed(this.questionIndex) || this.questionIndex < 0) return [];
    return this.fastestOrder(this.questionIndex).flatMap((id) => {
      const bonus = this.fastBonusFor(this.questionIndex, id);
      return bonus ? [{ name: this.teams.get(id)!.name, points: bonus.points, place: bonus.place + 1, ms: Math.round(this.teams.get(id)!.answers.get(this.questionIndex)!.answerMs), ...(this.photoUrl(id) ? { photo: this.photoUrl(id) } : {}) }] : [];
    });
  }

  private baseMark(questionIndex: number, answer: Answer): Marked {
    if (this.skipped.has(questionIndex)) return { correct: false, points: 0, detail: 'Skipped by the quiz master' };
    const q = this.effectiveQuestion(questionIndex)!;
    const durationMs = q.seconds * 1000;
    // Only "speed" questions scale with time; music has no shared start, so it is flat unless asked.
    const wantsSpeed = q.mode === 'speed' && (q.speedBonus ?? q.type !== 'music');
    const speedFactor = wantsSpeed ? this.quiz.speedFactor : 0;
    const timed = (correct: boolean, points: number) =>
      scoreAnswer({ correct, points, answerMs: answer.answerMs, durationMs, speedFactor });

    switch (q.type) {
      case 'multiple-choice': {
        const correct = answer.value === q.answer;
        return { correct, points: timed(correct, q.points) };
      }
      case 'picture':
      case 'music': {
        const correct = this.isCorrectText(questionIndex, q.accept, answer.value as string);
        return { correct, points: timed(correct, q.points) };
      }
      case 'letter': {
        const correct = (answer.value as string).includes(q.letter ?? '');
        return { correct, points: timed(correct, q.points) };
      }
      case 'number': {
        const correct = Math.abs((answer.value as number) - q.answer) <= q.tolerance + 1e-9;
        return { correct, points: timed(correct, q.points) };
      }
      case 'buzzer': {
        // Flat points for the team the host judged right; a penalty for a wrong answer; nothing for those who never got a turn.
        if (answer.value === 'right') return { correct: true, points: q.points };
        if (answer.value === 'wrong') return { correct: false, points: q.penalty ? -q.penalty : 0, detail: q.penalty ? `Wrong answer: -${q.penalty}` : 'Wrong answer' };
        return { correct: false, points: 0, detail: 'Buzzed, but did not get to answer' };
      }
      case 'nearest': {
        // The closest guess wins the lot (ties share it); speed doesn't matter.
        const { winners, best } = this.nearestWinners(questionIndex);
        const correct = winners.has(answer.value as number);
        return { correct, points: correct ? q.points : 0, detail: correct ? `Closest guess${best === 0 ? ': spot on!' : ` (off by ${formatNumber(best)})`}` : `Off by ${formatNumber(Math.abs((answer.value as number) - q.answer))}` };
      }
      case 'ordering': {
        // Half the points for items in the right place, half as a bonus for the whole order (with speed bonus).
        const order = answer.value as number[];
        const right = order.filter((item, position) => item === position).length;
        const perItem = Math.round(q.points / (2 * ORDERING_ITEMS));
        const bonusPool = q.points - perItem * ORDERING_ITEMS;
        const correct = right === ORDERING_ITEMS;
        return {
          correct,
          points: perItem * right + timed(correct, bonusPool),
          detail: `${right} of ${ORDERING_ITEMS} in the right place`,
        };
      }
    }
  }

  /** Points only count once their question has been revealed, so the leaderboard never gives answers away. */
  private isRevealed(questionIndex: number): boolean {
    if (questionIndex < this.questionIndex) return true;
    return questionIndex === this.questionIndex && ['reveal', 'leaderboard', 'finished'].includes(this.phase);
  }

  scoreOf(team: Team, beforeQuestion = Infinity): number {
    let score = 0;
    for (const [index, answer] of team.answers) {
      if (index < beforeQuestion && this.isRevealed(index)) score += this.markAnswer(index, answer, team).points;
    }
    for (const index of this.wagers.keys()) {
      if (index < beforeQuestion && this.isRevealed(index)) score += this.unansweredWagerLoss(team, index);
    }
    return score;
  }

  /** Total time a team took over the revealed questions; unanswered ones count as the full time limit. */
  private timeOf(team: Team, beforeQuestion = Infinity): number {
    let total = 0;
    for (let i = 0; i < this.quiz.questions.length && i < beforeQuestion; i++) {
      if (!this.isRevealed(i) || this.skipped.has(i)) continue;
      total += team.answers.get(i)?.answerMs ?? this.quiz.questions[i]!.seconds * 1000;
    }
    return total;
  }

  /** Ranks with ties sharing a place (1, 1, 3). Equal scores are split by the quicker total time. */
  private rank<T extends { name: string }>(rows: T[], score: (row: T) => number, time: (row: T) => number): Map<T, number> {
    const sorted = [...rows].sort((a, b) => score(b) - score(a) || time(a) - time(b) || a.name.localeCompare(b.name));
    const ranks = new Map<T, number>();
    sorted.forEach((row, i) => {
      const previous = sorted[i - 1];
      const tied = previous && score(previous) === score(row) && time(previous) === time(row);
      ranks.set(row, tied ? ranks.get(previous)! : i + 1);
    });
    return ranks;
  }

  standings(): StandingRow[] {
    // Every screen asks for these on every change, so work them out once per change.
    if (this.standingsMemo) return this.standingsMemo;
    return (this.standingsMemo = this.computeStandings());
  }

  private standingsMemo: StandingRow[] | undefined;

  private computeStandings(): StandingRow[] {
    const teams = [...this.teams.values()];
    const scores = new Map(teams.map((t) => [t, this.scoreOf(t)]));
    const times = new Map(teams.map((t) => [t, this.timeOf(t)]));
    const ranks = this.rank(teams, (t) => scores.get(t)!, (t) => times.get(t)!);
    // From the reveal on, also say how each team moved and what the question was worth to it.
    const showMovement = this.isRevealed(this.questionIndex) && this.questionIndex >= 0;
    // A round's leaderboard compares with the end of the round before; any other board, with the question before.
    const roundBoard = this.phase === 'leaderboard' && this.questionIndex >= 0 && this.quiz.leaderboard === 'round' && this.isLastInRound(this.questionIndex);
    const baseIndex = roundBoard ? this.quiz.questions.findIndex((x) => x.roundIndex === this.quiz.questions[this.questionIndex]!.roundIndex) : this.questionIndex;
    const before = new Map(teams.map((t) => [t, this.scoreOf(t, baseIndex)]));
    const timesBefore = new Map(teams.map((t) => [t, this.timeOf(t, baseIndex)]));
    const previousRanks = showMovement ? this.rank(teams, (t) => before.get(t)!, (t) => timesBefore.get(t)!) : undefined;
    return teams
      .map((t) => ({
        teamId: t.id,
        name: t.name,
        score: scores.get(t)!,
        rank: ranks.get(t)!,
        photo: this.photoUrl(t.id),
        gained: showMovement ? scores.get(t)! - before.get(t)! : undefined,
        // Positive: moved up. Only meaningful once there was a previous question.
        moved: previousRanks && baseIndex > 0 ? previousRanks.get(t)! - ranks.get(t)! : undefined,
      }))
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }

  /** One row per team: points for each question revealed so far, and the total. For the host to keep. */
  resultsTable(): string[][] {
    const upTo = this.questionIndex >= 0 && this.isRevealed(this.questionIndex) ? this.questionIndex : this.questionIndex - 1;
    const questions = this.quiz.questions.slice(0, upTo + 1);
    const header = ['Rank', 'Team', 'Total', ...questions.map((q, i) => `Q${i + 1} (${q.round})`)];
    const teams = this.standings();
    const rows = teams.map((row) => {
      const team = this.teams.get(row.teamId)!;
      return [
        String(row.rank),
        row.name,
        String(row.score),
        ...questions.map((_, i) => {
          const answer = team.answers.get(i);
          return answer ? String(this.markAnswer(i, answer, team).points) : String(this.unansweredWagerLoss(team, i));
        }),
      ];
    });
    return [header, ...rows];
  }

  // Views

  /** Where the current question sits within its round. */
  private roundPlace(roundIndex: number): { roundQuestion: number; roundQuestions: number } {
    const inRound = this.quiz.questions.filter((x) => x.roundIndex === roundIndex);
    const first = this.quiz.questions.findIndex((x) => x.roundIndex === roundIndex);
    return { roundQuestion: this.questionIndex - first + 1, roundQuestions: inRound.length };
  }

  private questionView(): QuestionView | undefined {
    const q = this.currentQuestion;
    if (!q || this.phase === 'lobby' || this.phase === 'finished') return undefined;
    if (this.phase === 'wagering') {
      // While teams bet they see the category, never the question.
      return {
        index: this.questionIndex,
        total: this.quiz.questions.length,
        round: q.round,
        roundNumber: q.roundIndex + 1,
        roundTotal: this.quiz.rounds.length,
        lastInRound: this.quiz.questions[this.questionIndex + 1]?.roundIndex !== q.roundIndex,
        ...this.roundPlace(q.roundIndex),
        type: q.type,
        text: '',
        category: q.category,
        wager: true,
        seconds: q.seconds,
      };
    }
    return {
      wager: q.wager || undefined,
      category: q.wager ? q.category : undefined,
      index: this.questionIndex,
      total: this.quiz.questions.length,
      round: q.round,
      roundNumber: q.roundIndex + 1,
      roundTotal: this.quiz.rounds.length,
      lastInRound: this.quiz.questions[this.questionIndex + 1]?.roundIndex !== q.roundIndex,
      ...this.roundPlace(q.roundIndex),
      type: q.type,
      text: q.text,
      image: q.imageUrl,
      uncover: q.type === 'picture' && q.uncover ? true : undefined,
      keypad: q.type === 'letter' ? (q.keypad ?? 'grouped') : undefined,
      audio: q.audioUrl,
      revealAudio: this.phase === 'reveal' ? q.revealAudioUrl : undefined,
      revealCaption: this.phase === 'reveal' && q.revealAudioUrl ? q.revealCaption : undefined,
      options: q.type === 'multiple-choice' ? (this.phase === 'reading' ? q.options.slice(0, this.readShown) : q.options) : undefined,
      items: q.type === 'ordering' ? this.displayOrders.get(this.questionIndex)!.map((i) => q.items[i]!) : undefined,
      seconds: q.seconds,
      remainingMs: this.phase === 'open' ? Math.max(0, this.endsAt - (this.pausedAt ?? this.now())) : undefined,
      paused: this.phase === 'open' && this.pausedAt !== undefined ? true : undefined,
    };
  }

  /** What every team bet on the revealed question, and whether it won. */
  private wagerList(): { name: string; amount: number; won: boolean | undefined }[] {
    const rows = [...this.teams.values()].flatMap((team) => {
      const amount = this.wagerOf(this.questionIndex, team.id);
      const answer = team.answers.get(this.questionIndex);
      if (this.skipped.has(this.questionIndex)) return [];
      return [{ name: team.name, amount, won: answer ? this.baseMark(this.questionIndex, answer).correct : false }];
    });
    return rows.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  }

  private describeAnswer(q: Question, answer: Answer): string {
    switch (q.type) {
      case 'multiple-choice':
        return q.options[answer.value as number]!;
      case 'picture':
      case 'music':
      case 'letter':
        return answer.value as string;
      case 'number':
      case 'nearest':
        return formatNumber(answer.value as number);
      case 'buzzer':
        return 'Buzzed';
      case 'ordering':
        return (answer.value as number[]).map((i) => q.items[i]).join(' → ');
    }
  }

  private preloadImage(): string | undefined {
    if (this.phase === 'open' || this.phase === 'closed') return undefined;
    return this.quiz.questions[this.questionIndex + 1]?.imageUrl;
  }

  /** How a Buzzin' question looks to one team. */
  private teamBuzzView(teamId: string): QuestionView['buzz'] {
    if (this.currentQuestion?.type !== 'buzzer') return undefined;
    const state = this.buzzStates.get(this.questionIndex) ?? { queue: [], locked: [], autoPaused: false };
    const nameOf = (id?: string) => (id ? this.teams.get(id)?.name : undefined);
    if (this.phase === 'open') {
      const answering = nameOf(state.current);
      if (state.current === teamId) return { state: 'answering', answering };
      if (state.locked.includes(teamId)) return { state: 'locked', answering };
      const place = state.queue.indexOf(teamId);
      if (place >= 0) return { state: 'queued', answering, position: place + 1 + (state.current ? 1 : 0) };
      return { state: 'ready', answering };
    }
    return { state: state.winner === teamId ? 'won' : state.locked.includes(teamId) ? 'locked' : 'over', answering: nameOf(state.winner) };
  }

  /** The order teams buzzed in, for the host and TV. */
  private buzzers(): { name: string; status: 'answering' | 'queued' | 'wrong' | 'right' }[] | undefined {
    if (this.currentQuestion?.type !== 'buzzer' || this.phase === 'lobby') return undefined;
    const state = this.buzzStates.get(this.questionIndex);
    if (!state) return [];
    const row = (id: string | undefined, status: 'answering' | 'queued' | 'wrong' | 'right') => {
      const name = id ? this.teams.get(id)?.name : undefined;
      return name ? [{ name, status }] : [];
    };
    return [
      ...row(state.winner, 'right'),
      ...row(state.current, 'answering'),
      ...state.queue.flatMap((id) => row(id, 'queued')),
      ...state.locked.flatMap((id) => row(id, 'wrong')),
    ];
  }

  teamView(teamId: string): TeamView | undefined {
    const waiting = this.pending.get(teamId);
    if (waiting) {
      // Joined, but not yet admitted: just the start screen and what it costs.
      return {
        phase: 'lobby',
        quizTitle: this.quiz.title,
        teamId: waiting.id,
        teamName: waiting.name,
        teamCode: waiting.code,
        photosEnabled: false,
        score: 0,
        rank: 0,
        teamCount: this.teams.size,
        entryFee: this.entryFee || undefined,
        pendingAdmission: true,
      };
    }
    const team = this.teams.get(teamId);
    if (!team) return undefined;
    const standings = this.standings();
    const mine = standings.find((row) => row.teamId === teamId);
    const question = this.currentQuestion;
    const answer = team.answers.get(this.questionIndex);
    const marked = question && answer ? this.markAnswer(this.questionIndex, answer, team) : undefined;
    const showQuestion = this.phase !== 'lobby' && this.phase !== 'finished';

    return {
      phase: this.phase,
      quizTitle: this.quiz.title,
      teamId: team.id,
      teamName: team.name,
      onBreak: this.breakView(),
      speedster: this.speedster(),
      prizes: this.prizesView(),
      entryFee: this.entryFee || undefined,
      teamCode: team.code,
      photo: this.photoUrl(team.id),
      photosEnabled: this.photosEnabled,
      score: mine?.score ?? 0,
      rank: mine?.rank ?? standings.length,
      teamCount: this.teams.size,
      // Phones never play the clip; the host or TV does.
      question: (() => {
        const view = this.questionView();
        return view ? { ...view, audio: undefined, revealAudio: undefined, revealCaption: undefined, buzz: this.teamBuzzView(teamId) } : undefined;
      })(),
      wagerInfo:
        question?.wager && ['wagering', 'open', 'closed', 'reveal'].includes(this.phase)
          ? { cap: this.wagerCapFor(teamId), amount: this.wagers.get(this.questionIndex)?.get(teamId) }
          : undefined,
      myChoice: showQuestion && question?.type === 'multiple-choice' ? (answer?.value as number | undefined) : undefined,
      myAnswerText: showQuestion && question && answer ? this.describeAnswer(question, answer) : undefined,
      myAnswerMs: showQuestion && question && answer && question.type !== 'buzzer' ? Math.round(answer.answerMs) : undefined,
      result:
        question && this.isRevealed(this.questionIndex) && showQuestion
          ? {
              correct: marked?.correct ?? false,
              points: marked?.points ?? this.unansweredWagerLoss(team, this.questionIndex),
              answerText: answerText(question),
              detail: marked?.detail ?? (this.unansweredWagerLoss(team, this.questionIndex) ? `No answer: you lose your ${this.wagerOf(this.questionIndex, team.id)} wager` : undefined),
              correctIndex: question.type === 'multiple-choice' ? question.answer : undefined,
              info: question.info,
            }
          : undefined,
      standings: this.phase === 'leaderboard' || this.phase === 'finished' ? standings : undefined,
      preloadImage: this.preloadImage(),
    };
  }

  hostView(): Omit<HostView, 'roomCode' | 'joinUrl' | 'lanJoinUrl' | 'qrVersion' | 'network' | 'canEnd' | 'screenKey'> {
    const teams = [...this.teams.values()];
    const standings = this.standings();
    const scores = new Map(standings.map((row) => [row.teamId, row.score]));
    const questionView = this.questionView();
    const question = this.currentQuestion;
    const answered = teams.flatMap((t) => {
      const a = t.answers.get(this.questionIndex);
      return a ? [{ team: t, answer: a }] : [];
    });
    const afterClose = ['closed', 'reveal', 'leaderboard'].includes(this.phase);

    let distribution: number[] | undefined;
    let review: ReviewGroup[] | undefined;
    let summary: string | undefined;
    let guesses: { value: string; off: string; teams: string[]; winner: boolean }[] | undefined;
    if (question && afterClose) {
      if (question.type === 'multiple-choice') {
        distribution = question.options.map((_, i) => answered.filter(({ answer }) => answer.value === i).length);
      } else if (isTextAnswer(question)) {
        const groups = new Map<string, ReviewGroup>();
        for (const { team, answer } of answered) {
          const text = answer.value as string;
          const key = normalise(text);
          let group = groups.get(key);
          if (!group) {
            group = {
              key,
              text,
              teams: [],
              match: matchAnswer(text, question.accept),
              correct: this.isCorrectText(this.questionIndex, question.accept, text),
            };
            groups.set(key, group);
          }
          group.teams.push(team.name);
        }
        const order = { exact: 0, close: 1, none: 2 };
        review = [...groups.values()].sort((a, b) => order[a.match] - order[b.match] || b.teams.length - a.teams.length);
      } else if (question.type === 'number') {
        const right = answered.filter(({ answer }) => this.baseMark(this.questionIndex, answer).correct).length;
        summary = `${right} ${right === 1 ? 'team' : 'teams'} got it right`;
      } else if (question.type === 'nearest') {
        const { winners } = this.nearestWinners(this.questionIndex);
        const byValue = new Map<number, string[]>();
        for (const { team, answer } of answered) byValue.set(answer.value as number, [...(byValue.get(answer.value as number) ?? []), team.name]);
        guesses = [...byValue]
          .map(([value, names]) => ({ value, names, off: Math.abs(value - question.answer) }))
          .sort((a, b) => a.off - b.off || a.value - b.value)
          .map(({ value, names, off }) => ({ value: formatNumber(value), off: off === 0 ? 'spot on' : `off by ${formatNumber(off)}`, teams: names, winner: winners.has(value) }));
      } else if (question.type === 'letter') {
        const counts = new Map<string, number>();
        for (const { answer } of answered) counts.set(answer.value as string, (counts.get(answer.value as string) ?? 0) + 1);
        summary = [...counts]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([letter, count]) => `${letter} ×${count}`)
          .join('   ');
      } else {
        const perfect = answered.filter(({ answer }) => this.baseMark(this.questionIndex, answer).correct).length;
        summary = `${perfect} ${perfect === 1 ? 'team' : 'teams'} got the order exactly right`;
      }
    }

    return {
      phase: this.phase,
      quizTitle: this.quiz.title,
      questionCount: this.quiz.questions.length,
      onBreak: this.breakView(),
      speedster: this.speedster(),
      prizes: this.prizesView(),
      maxTeams: MAX_TEAMS,
      photosEnabled: this.photosEnabled,
      tvShowTeams: this.tvShowTeams,
      entryFee: this.entryFee,
      requireAdmission: this.requireAdmission,
      pendingTeams: [...this.pending.values()].map((t) => ({ id: t.id, name: t.name, code: t.code, connected: t.connected })),
      readOut: this.readOut,
      startOnLastAnswer: this.startOnLastAnswer,
      joiningLocked: this.joiningLocked,
      lockOnStart: this.lockOnStart,
      closeEarly: this.closeEarly,
      reading: this.phase === 'reading' && question?.type === 'multiple-choice' ? { shown: this.readShown, total: question.options.length } : undefined,
      skipsLeaderboardNext: this.questionIndex >= 0 && this.skipsLeaderboardNext,
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        code: t.code,
        photo: this.photoUrl(t.id),
        score: scores.get(t.id) ?? 0,
        connected: t.connected,
        answered: t.answers.has(this.questionIndex),
      })),
      wagering:
        this.phase === 'wagering'
          ? { done: this.wagers.get(this.questionIndex)?.size ?? 0, total: teams.filter((t) => t.connected).length }
          : undefined,
      wagers: question?.wager && this.isRevealed(this.questionIndex) ? this.wagerList() : undefined,
      question:
        questionView && question
          ? {
              ...questionView,
              hostText: this.phase === 'wagering' ? question.text : undefined,
              answerText: answerText(question),
              answer: question.type === 'multiple-choice' ? question.answer : undefined,
              info: question.info,
              answerEdited: this.answerEdits.has(this.questionIndex),
              /** What the host can change: option, letter or number (for the edit controls). */
              editable: ['multiple-choice', 'letter', 'number', 'nearest'].includes(question.type),
              editValue: question.type === 'letter' ? question.letter : question.type === 'number' || question.type === 'nearest' ? question.answer : undefined,
            }
          : undefined,
      answeredCount: answered.length,
      connectedCount: teams.filter((t) => t.connected).length,
      distribution,
      review,
      summary,
      guesses,
      buzzers: this.buzzers(),
      fastest: this.fastestTeams(),
      standings,
      preloadImage: this.preloadImage(),
    };
  }
}
