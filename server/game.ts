import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { checkTeamName, MAX_NAME_LENGTH } from './limits.ts';
import { matchAnswer, normalise } from './matching.ts';
import type { AnswerValue, HostView, Phase, QuestionView, ReviewGroup, StandingRow, TeamView } from './protocol.ts';
import { isTextAnswer, ORDERING_ITEMS, type Question, type Quiz } from './quiz.ts';
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
/** Share of the fastest-team bonus for 1st, 2nd and 3rd quickest. */
const FAST_SHARES = [1, 0.6, 0.3];
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
  /** Keyed by question index. */
  answers: Map<number, Answer>;
}

interface Marked {
  correct: boolean;
  points: number;
  detail?: string;
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
  }

  get currentQuestion(): Question | undefined {
    return this.quiz.questions[this.questionIndex];
  }

  // Teams

  join(rawName: string): Result<Team> {
    const checked = checkTeamName(rawName, { filterWords: this.nameFilter });
    if (!checked.ok) return fail(checked.error);
    const name = checked.name;
    if (this.phase === 'finished') return fail('This quiz has finished.');
    if (this.teams.size >= MAX_TEAMS) return fail(`This quiz is full (${MAX_TEAMS} teams).`);
    const lower = name.toLowerCase();
    if ([...this.teams.values()].some((t) => t.name.toLowerCase() === lower)) {
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
    this.teams.set(team.id, team);
    this.markSent(team);
    this.changed();
    return { ok: true, value: team };
  }

  private newTeamCode(): string {
    for (;;) {
      const code = Array.from({ length: TEAM_CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      if (![...this.teams.values()].some((t) => t.code === code)) return code;
    }
  }

  /** Finds a team by the token its phone saved, or by the team code typed in. */
  rejoin(credential: { token?: string; code?: string }): Team | undefined {
    const code = credential.code?.trim().toUpperCase();
    const team = [...this.teams.values()].find(
      (t) => (credential.token !== undefined && t.token === credential.token) || (code !== undefined && t.code === code),
    );
    if (!team) return undefined;
    team.connected = true;
    this.markSent(team);
    this.changed();
    return team;
  }

  disconnect(teamId: string): void {
    const team = this.teams.get(teamId);
    if (!team) return;
    team.connected = false;
    this.changed();
  }

  kick(teamId: string): boolean {
    if (!this.teams.delete(teamId)) return false;
    this.sentAt.delete(teamId);
    if (this.phase === 'open' && this.everyoneAnswered()) this.closeQuestion();
    else this.changed();
    return true;
  }

  getTeamNames(): string[] {
    return [...this.teams.values()].map((t) => t.name);
  }

  getTeam(teamId: string): Team | undefined {
    return this.teams.get(teamId);
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
    const latency = Math.min(Math.max(latencyMs, 0), MAX_LATENCY_MS);
    const receivedAt = this.now();
    if (receivedAt - latency > this.endsAt) return fail("Too late, time's up.");

    // The phone times itself from when the question appeared on its screen, so delivery delay never
    // counts against it. It is only trusted if it fits what the server saw: no more than the time since
    // the question was sent, and no less than that minus the round trip (and a small tolerance).
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
    team.answers.set(this.questionIndex, { value: stored.value, answerMs });

    if (this.everyoneAnswered()) this.closeQuestion();
    else this.changed();
    return { ok: true, value: null };
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
        if (typeof value !== 'string' || !/^[A-Za-z]$/.test(value)) return fail('Tap a letter.');
        return { ok: true, value: value.toUpperCase() };
      }
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
    switch (this.phase) {
      case 'lobby':
        if (this.quiz.questions.length > 0) this.openQuestion(0);
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
    const shift = this.now() - this.pausedAt;
    this.pausedAt = undefined;
    this.openedAt += shift;
    this.endsAt += shift;
    for (const [teamId, at] of this.sentAt) this.sentAt.set(teamId, at + shift);
    this.startTimer();
    this.changed();
    return { ok: true, value: null };
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
    if (this.phase !== 'open' && this.phase !== 'closed') return fail('Only a question that has not been revealed can be skipped.');
    this.skipped.add(this.questionIndex);
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
    for (const index of snapshot.skipped ?? []) game.skipped.add(index);
    for (const [index, order] of snapshot.displayOrders) game.displayOrders.set(index, order);
    for (const [index, marks] of snapshot.overrides) game.overrides.set(index, new Map(marks));
    if (game.phase === 'open' && game.pausedAt === undefined) game.startTimer();
    return game;
  }

  private openQuestion(index: number): void {
    const question = this.quiz.questions[index];
    if (!question) return;
    this.questionIndex = index;
    this.phase = 'open';
    this.pausedAt = undefined;
    this.openedAt = this.now();
    this.endsAt = this.openedAt + question.seconds * 1000;
    if (question.type === 'ordering' && !this.displayOrders.has(index)) {
      this.displayOrders.set(index, shuffledOrder(question.items.length));
    }
    this.sentAt = new Map();
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
    const connected = [...this.teams.values()].filter((t) => t.connected);
    return connected.length > 0 && connected.every((t) => t.answers.has(this.questionIndex));
  }

  private changed(): void {
    this.firstCorrectMemo.clear();
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
    if (!marked.correct) return marked;
    const bonus = this.fastBonusFor(questionIndex, team.id);
    if (!bonus) return marked;
    return { ...marked, points: marked.points + bonus.points, detail: [marked.detail, bonus.label].filter(Boolean).join(' · ') };
  }

  /** What a team earns for being among the quickest correct answers to a question, if anything. */
  private fastBonusFor(questionIndex: number, teamId: string): { points: number; label: string; place: number } | undefined {
    const q = this.quiz.questions[questionIndex]!;
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

  /** For the host and TV: who earned the speed bonus on the question just revealed. */
  fastestTeams(): { name: string; points: number; place: number }[] {
    if (!this.isRevealed(this.questionIndex) || this.questionIndex < 0) return [];
    return this.fastestOrder(this.questionIndex).flatMap((id) => {
      const bonus = this.fastBonusFor(this.questionIndex, id);
      return bonus ? [{ name: this.teams.get(id)!.name, points: bonus.points, place: bonus.place + 1 }] : [];
    });
  }

  private baseMark(questionIndex: number, answer: Answer): Marked {
    if (this.skipped.has(questionIndex)) return { correct: false, points: 0, detail: 'Skipped by the quiz master' };
    const q = this.quiz.questions[questionIndex]!;
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
        const correct = answer.value === q.letter;
        return { correct, points: timed(correct, q.points) };
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
    const teams = [...this.teams.values()];
    const scores = new Map(teams.map((t) => [t, this.scoreOf(t)]));
    const times = new Map(teams.map((t) => [t, this.timeOf(t)]));
    const ranks = this.rank(teams, (t) => scores.get(t)!, (t) => times.get(t)!);
    // From the reveal on, also say how each team moved and what the question was worth to it.
    const showMovement = this.isRevealed(this.questionIndex) && this.questionIndex >= 0;
    const before = new Map(teams.map((t) => [t, this.scoreOf(t, this.questionIndex)]));
    const timesBefore = new Map(teams.map((t) => [t, this.timeOf(t, this.questionIndex)]));
    const previousRanks = showMovement ? this.rank(teams, (t) => before.get(t)!, (t) => timesBefore.get(t)!) : undefined;
    return teams
      .map((t) => ({
        teamId: t.id,
        name: t.name,
        score: scores.get(t)!,
        rank: ranks.get(t)!,
        gained: showMovement ? scores.get(t)! - before.get(t)! : undefined,
        // Positive: moved up. Only meaningful once there was a previous question.
        moved: previousRanks && this.questionIndex > 0 ? previousRanks.get(t)! - ranks.get(t)! : undefined,
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
          return answer ? String(this.markAnswer(i, answer, team).points) : '0';
        }),
      ];
    });
    return [header, ...rows];
  }

  // Views

  private questionView(): QuestionView | undefined {
    const q = this.currentQuestion;
    if (!q || this.phase === 'lobby' || this.phase === 'finished') return undefined;
    return {
      index: this.questionIndex,
      total: this.quiz.questions.length,
      round: q.round,
      roundNumber: q.roundIndex + 1,
      roundTotal: this.quiz.rounds.length,
      lastInRound: this.quiz.questions[this.questionIndex + 1]?.roundIndex !== q.roundIndex,
      type: q.type,
      text: q.text,
      image: q.imageUrl,
      options: q.type === 'multiple-choice' ? q.options : undefined,
      items: q.type === 'ordering' ? this.displayOrders.get(this.questionIndex)!.map((i) => q.items[i]!) : undefined,
      seconds: q.seconds,
      remainingMs: this.phase === 'open' ? Math.max(0, this.endsAt - (this.pausedAt ?? this.now())) : undefined,
      paused: this.phase === 'open' && this.pausedAt !== undefined ? true : undefined,
    };
  }

  private describeAnswer(q: Question, answer: Answer): string {
    switch (q.type) {
      case 'multiple-choice':
        return q.options[answer.value as number]!;
      case 'picture':
      case 'music':
      case 'letter':
        return answer.value as string;
      case 'ordering':
        return (answer.value as number[]).map((i) => q.items[i]).join(' → ');
    }
  }

  private preloadImage(): string | undefined {
    if (this.phase === 'open' || this.phase === 'closed') return undefined;
    return this.quiz.questions[this.questionIndex + 1]?.imageUrl;
  }

  teamView(teamId: string): TeamView | undefined {
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
      teamCode: team.code,
      score: mine?.score ?? 0,
      rank: mine?.rank ?? standings.length,
      teamCount: this.teams.size,
      question: this.questionView(),
      myChoice: showQuestion && question?.type === 'multiple-choice' ? (answer?.value as number | undefined) : undefined,
      myAnswerText: showQuestion && question && answer ? this.describeAnswer(question, answer) : undefined,
      result:
        question && this.isRevealed(this.questionIndex) && showQuestion
          ? {
              correct: marked?.correct ?? false,
              points: marked?.points ?? 0,
              answerText: answerText(question),
              detail: marked?.detail,
              correctIndex: question.type === 'multiple-choice' ? question.answer : undefined,
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
      } else if (question.type === 'letter') {
        const counts = new Map<string, number>();
        for (const { answer } of answered) counts.set(answer.value as string, (counts.get(answer.value as string) ?? 0) + 1);
        summary = [...counts]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([letter, count]) => `${letter} ×${count}`)
          .join('   ');
      } else {
        const perfect = answered.filter(({ answer }) => this.baseMark(this.questionIndex, answer).correct).length;
        summary = `${perfect} of ${answered.length} ${answered.length === 1 ? 'team' : 'teams'} got the order exactly right`;
      }
    }

    return {
      phase: this.phase,
      quizTitle: this.quiz.title,
      questionCount: this.quiz.questions.length,
      maxTeams: MAX_TEAMS,
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        code: t.code,
        score: scores.get(t.id) ?? 0,
        connected: t.connected,
        answered: t.answers.has(this.questionIndex),
      })),
      question:
        questionView && question
          ? {
              ...questionView,
              answerText: answerText(question),
              answer: question.type === 'multiple-choice' ? question.answer : undefined,
            }
          : undefined,
      answeredCount: answered.length,
      connectedCount: teams.filter((t) => t.connected).length,
      distribution,
      review,
      summary,
      fastest: this.fastestTeams(),
      standings,
      preloadImage: this.preloadImage(),
    };
  }
}
