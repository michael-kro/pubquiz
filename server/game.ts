import { randomBytes, randomUUID } from 'node:crypto';
import type { HostView, Phase, StandingRow, TeamView } from './protocol.ts';
import type { Question, Quiz } from './quiz.ts';
import { scoreAnswer } from './scoring.ts';

export const MAX_TEAMS = 30;
export const MAX_NAME_LENGTH = 24;

interface Answer {
  choice: number;
  answerMs: number;
  correct: boolean;
  points: number;
}

export interface Team {
  id: string;
  token: string;
  name: string;
  connected: boolean;
  /** Keyed by question index. */
  answers: Map<number, Answer>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface GameOptions {
  now?: () => number;
  /** Called after every state change, so the server can push fresh views. */
  onChange?: () => void;
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

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

  answer(teamId: string, choice: number): Result<null> {
    const team = this.teams.get(teamId);
    if (!team) return fail('Your team is not in this quiz.');
    const question = this.currentQuestion;
    if (this.phase !== 'open' || !question) return fail('This question is closed.');
    if (team.answers.has(this.questionIndex)) return fail('Your team has already answered.');
    if (!Number.isInteger(choice) || choice < 0 || choice >= question.options.length) {
      return fail('That is not one of the options.');
    }
    const receivedAt = this.now();
    if (receivedAt > this.endsAt) return fail("Too late, time's up.");

    const durationMs = question.seconds * 1000;
    const answerMs = receivedAt - (this.sentAt.get(teamId) ?? this.openedAt);
    const correct = choice === question.answer;
    const points = scoreAnswer({ correct, points: question.points, answerMs, durationMs, speedFactor: this.quiz.speedFactor });
    team.answers.set(this.questionIndex, { choice, answerMs, correct, points });

    if (this.everyoneAnswered()) this.closeQuestion();
    else this.changed();
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

  private openQuestion(index: number): void {
    const question = this.quiz.questions[index];
    if (!question) return;
    this.questionIndex = index;
    this.phase = 'open';
    this.openedAt = this.now();
    this.endsAt = this.openedAt + question.seconds * 1000;
    this.sentAt = new Map();
    for (const team of this.teams.values()) this.markSent(team);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.closeQuestion(), question.seconds * 1000);
    this.changed();
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

  // Scores and views

  /** Points only count once their question has been revealed, so the leaderboard never gives answers away. */
  private isRevealed(questionIndex: number): boolean {
    if (questionIndex < this.questionIndex) return true;
    return questionIndex === this.questionIndex && ['reveal', 'leaderboard', 'finished'].includes(this.phase);
  }

  scoreOf(team: Team): number {
    let score = 0;
    for (const [index, answer] of team.answers) if (this.isRevealed(index)) score += answer.points;
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

  private questionView() {
    const q = this.currentQuestion;
    if (!q || this.phase === 'lobby' || this.phase === 'finished') return undefined;
    return {
      index: this.questionIndex,
      total: this.quiz.questions.length,
      round: q.round,
      text: q.text,
      options: q.options,
      seconds: q.seconds,
      remainingMs: this.phase === 'open' ? Math.max(0, this.endsAt - this.now()) : undefined,
    };
  }

  teamView(teamId: string): TeamView | undefined {
    const team = this.teams.get(teamId);
    if (!team) return undefined;
    const standings = this.standings();
    const mine = standings.find((row) => row.teamId === teamId);
    const answer = team.answers.get(this.questionIndex);
    const question = this.currentQuestion;
    const revealed = question && this.isRevealed(this.questionIndex);

    return {
      phase: this.phase,
      quizTitle: this.quiz.title,
      teamId: team.id,
      teamName: team.name,
      score: mine?.score ?? 0,
      rank: mine?.rank ?? standings.length,
      teamCount: this.teams.size,
      question: this.questionView(),
      myAnswer: answer?.choice,
      result: revealed
        ? { correctIndex: question.answer, correct: answer?.correct ?? false, points: answer?.points ?? 0 }
        : undefined,
      standings: this.phase === 'leaderboard' || this.phase === 'finished' ? standings : undefined,
    };
  }

  hostView(): Omit<HostView, 'roomCode' | 'joinUrl'> {
    const teams = [...this.teams.values()];
    const scores = new Map(this.standings().map((row) => [row.teamId, row.score]));
    const questionView = this.questionView();
    const question = this.currentQuestion;
    const answers = teams.map((t) => t.answers.get(this.questionIndex)).filter((a) => a !== undefined);

    let distribution: number[] | undefined;
    if (question && ['closed', 'reveal', 'leaderboard'].includes(this.phase)) {
      distribution = question.options.map((_, i) => answers.filter((a) => a.choice === i).length);
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
      question: questionView && question ? { ...questionView, answer: question.answer } : undefined,
      answeredCount: answers.length,
      connectedCount: teams.filter((t) => t.connected).length,
      distribution,
      standings: this.standings(),
    };
  }
}
