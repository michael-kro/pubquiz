import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { matchAnswer, normalise } from './matching.ts';
import type { AnswerValue, HostView, Phase, QuestionView, ReviewGroup, StandingRow, TeamView } from './protocol.ts';
import { isTextAnswer, ORDERING_ITEMS, type Question, type Quiz } from './quiz.ts';
import { scoreAnswer } from './scoring.ts';

export const MAX_TEAMS = 30;
export const MAX_NAME_LENGTH = 24;
export const MAX_TEXT_ANSWER = 100;
/**
 * Most network delay we'll subtract from a team's answer time. Also how long a question stays
 * open after its deadline, so an answer sent in time over a slow connection still counts.
 * Capped so a team can't fake a huge delay to buy time.
 */
export const MAX_LATENCY_MS = 1500;

export interface Answer {
  /** Multiple choice: option index. Text: what the team typed. Ordering: original item indices in the team's order. */
  value: AnswerValue;
  answerMs: number;
}

export interface Team {
  id: string;
  token: string;
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
  teams: { id: string; token: string; name: string; answers: [number, Answer][] }[];
  sentAt: [string, number][];
  displayOrders: [number, number[]][];
  overrides: [number, [string, boolean][]][];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface GameOptions {
  now?: () => number;
  /** Called after every state change, so the server can push fresh views. */
  onChange?: () => void;
}

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
  private openedAt = 0;
  private endsAt = 0;
  /** When each team received the current question; answer time is measured from here. */
  private sentAt = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  /** Ordering questions: displayed position → original item index, per question. */
  private readonly displayOrders = new Map<number, number[]>();
  /** Host marking of typed answers, per question, keyed by normalised answer. */
  private readonly overrides = new Map<number, Map<string, boolean>>();

  constructor(quiz: Quiz, options: GameOptions = {}) {
    this.quiz = quiz;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => {});
  }

  get currentQuestion(): Question | undefined {
    return this.quiz.questions[this.questionIndex];
  }

  // Teams

  join(rawName: string): Result<Team> {
    const name = rawName.trim().replace(/\s+/g, ' ');
    if (!name) return fail('Enter a team name.');
    if (name.length > MAX_NAME_LENGTH) return fail(`Team names can be at most ${MAX_NAME_LENGTH} characters.`);
    if (this.phase === 'finished') return fail('This quiz has finished.');
    if (this.teams.size >= MAX_TEAMS) return fail(`This quiz is full (${MAX_TEAMS} teams).`);
    const lower = name.toLowerCase();
    if ([...this.teams.values()].some((t) => t.name.toLowerCase() === lower)) {
      return fail('That team name is taken. Pick another.');
    }

    const team: Team = {
      id: randomUUID(),
      token: randomBytes(18).toString('base64url'),
      name,
      connected: true,
      answers: new Map(),
    };
    this.teams.set(team.id, team);
    this.markSent(team);
    this.changed();
    return { ok: true, value: team };
  }

  rejoin(token: string): Team | undefined {
    const team = [...this.teams.values()].find((t) => t.token === token);
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

  getTeam(teamId: string): Team | undefined {
    return this.teams.get(teamId);
  }

  // Play

  /**
   * `latencyMs` is the team's measured round trip. The question took about half of it to reach the
   * phone and the answer the other half to come back, so it's removed from the answer time.
   */
  answer(teamId: string, value: AnswerValue, latencyMs = 0): Result<null> {
    const team = this.teams.get(teamId);
    if (!team) return fail('Your team is not in this quiz.');
    const question = this.currentQuestion;
    if (this.phase !== 'open' || !question) return fail('This question is closed.');
    if (team.answers.has(this.questionIndex)) return fail('Your team has already answered.');

    const stored = this.validate(question, value);
    if (!stored.ok) return stored;
    const latency = Math.min(Math.max(latencyMs, 0), MAX_LATENCY_MS);
    const receivedAt = this.now();
    if (receivedAt - latency > this.endsAt) return fail("Too late, time's up.");

    const answerMs = Math.max(0, receivedAt - (this.sentAt.get(teamId) ?? this.openedAt) - latency);
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
      teams: [...this.teams.values()].map((t) => ({ id: t.id, token: t.token, name: t.name, answers: [...t.answers] })),
      sentAt: [...this.sentAt],
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
      game.teams.set(t.id, { id: t.id, token: t.token, name: t.name, connected: false, answers: new Map(t.answers) });
    }
    game.sentAt = new Map(snapshot.sentAt);
    for (const [index, order] of snapshot.displayOrders) game.displayOrders.set(index, order);
    for (const [index, marks] of snapshot.overrides) game.overrides.set(index, new Map(marks));
    if (game.phase === 'open') game.startTimer();
    return game;
  }

  private openQuestion(index: number): void {
    const question = this.quiz.questions[index];
    if (!question) return;
    this.questionIndex = index;
    this.phase = 'open';
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
    this.phase = 'closed';
    this.changed();
  }

  /** A team that reconnects mid-question keeps its original start time, so reconnecting can't buy extra time. */
  private markSent(team: Team): void {
    if (this.phase === 'open' && team.connected && !this.sentAt.has(team.id)) {
      this.sentAt.set(team.id, this.now());
    }
  }

  private everyoneAnswered(): boolean {
    const connected = [...this.teams.values()].filter((t) => t.connected);
    return connected.length > 0 && connected.every((t) => t.answers.has(this.questionIndex));
  }

  private changed(): void {
    this.onChange();
  }

  // Marking and scores

  private isCorrectText(questionIndex: number, accepted: string[], given: string): boolean {
    const override = this.overrides.get(questionIndex)?.get(normalise(given));
    return override ?? matchAnswer(given, accepted) !== 'none';
  }

  private markAnswer(questionIndex: number, answer: Answer): Marked {
    const q = this.quiz.questions[questionIndex]!;
    const durationMs = q.seconds * 1000;
    const speedFactor = (q.speedBonus ?? q.type !== 'music') ? this.quiz.speedFactor : 0;
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

  scoreOf(team: Team): number {
    let score = 0;
    for (const [index, answer] of team.answers) if (this.isRevealed(index)) score += this.markAnswer(index, answer).points;
    return score;
  }

  standings(): StandingRow[] {
    const rows = [...this.teams.values()]
      .map((t) => ({ teamId: t.id, name: t.name, score: this.scoreOf(t), rank: 0 }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    rows.forEach((row, i) => {
      const previous = rows[i - 1];
      row.rank = previous && previous.score === row.score ? previous.rank : i + 1;
    });
    return rows;
  }

  // Views

  private questionView(): QuestionView | undefined {
    const q = this.currentQuestion;
    if (!q || this.phase === 'lobby' || this.phase === 'finished') return undefined;
    return {
      index: this.questionIndex,
      total: this.quiz.questions.length,
      round: q.round,
      type: q.type,
      text: q.text,
      image: q.imageUrl,
      options: q.type === 'multiple-choice' ? q.options : undefined,
      items: q.type === 'ordering' ? this.displayOrders.get(this.questionIndex)!.map((i) => q.items[i]!) : undefined,
      seconds: q.seconds,
      remainingMs: this.phase === 'open' ? Math.max(0, this.endsAt - this.now()) : undefined,
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
    const marked = question && answer ? this.markAnswer(this.questionIndex, answer) : undefined;
    const showQuestion = this.phase !== 'lobby' && this.phase !== 'finished';

    return {
      phase: this.phase,
      quizTitle: this.quiz.title,
      teamId: team.id,
      teamName: team.name,
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

  hostView(): Omit<HostView, 'roomCode' | 'joinUrl'> {
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
        const perfect = answered.filter(({ answer }) => this.markAnswer(this.questionIndex, answer).correct).length;
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
      standings,
      preloadImage: this.preloadImage(),
    };
  }
}
