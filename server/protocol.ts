// Messages exchanged over the WebSocket. The browser clients in public/ follow these shapes.
import { z } from 'zod';
import type { QuestionType } from './quiz.ts';
import type { NetworkStatus } from './tunnel.ts';

export type Phase = 'lobby' | 'open' | 'closed' | 'reveal' | 'leaderboard' | 'finished';

/** Multiple choice: option index. Picture/music: typed text. Letter: one letter. Ordering: item indices as displayed, first to last. */
export type AnswerValue = number | string | number[];

const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('host'), key: z.string().max(200) }),
  z.object({ t: z.literal('screen'), key: z.string().max(200) }),
  z.object({ t: z.literal('join'), room: z.string().max(20), name: z.string().max(200) }),
  z.object({ t: z.literal('rejoin'), token: z.string().max(200).optional(), code: z.string().max(20).optional() }),
  z.object({
    t: z.literal('answer'),
    value: z.union([z.number().int(), z.string().max(200), z.array(z.number().int()).max(10)]),
    /** Milliseconds from the question appearing on the phone to the tap (performance.now), checked by the server. */
    elapsedMs: z.number().min(0).max(1_000_000).optional(),
  }),
  // Host only.
  z.object({ t: z.literal('advance') }),
  z.object({ t: z.literal('pause') }),
  z.object({ t: z.literal('resume') }),
  z.object({ t: z.literal('extend'), seconds: z.number().min(1).max(120).optional() }),
  z.object({ t: z.literal('skip') }),
  z.object({ t: z.literal('kick'), teamId: z.string().max(200) }),
  z.object({ t: z.literal('mark'), key: z.string().max(400), correct: z.boolean() }),
  z.object({ t: z.literal('network'), action: z.enum(['use-lan', 'use-tunnel']) }),
  z.object({ t: z.literal('end-quiz') }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export function parseClientMessage(raw: string): ClientMessage | undefined {
  try {
    const result = ClientMessageSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export interface StandingRow {
  teamId: string;
  name: string;
  score: number;
  /** Tied teams share a rank (1, 1, 3). */
  rank: number;
  /** Points the current question was worth to this team, from the reveal onwards. */
  gained?: number;
  /** Places moved up (positive) or down since the previous question. */
  moved?: number;
}

export interface QuestionView {
  index: number;
  total: number;
  round: string;
  /** 1-based, for "Round 2 of 4". */
  roundNumber: number;
  roundTotal: number;
  /** The last question of its round: the leaderboard after it is a round break. */
  lastInRound: boolean;
  type: QuestionType;
  text: string;
  image?: string;
  /** Multiple choice. */
  options?: string[];
  /** Ordering: the items in the shuffled order every team sees. */
  items?: string[];
  seconds: number;
  /** Only while the question is open. Clients count down from when they receive it. */
  remainingMs?: number;
  /** The host has stopped the clock; remainingMs is frozen. */
  paused?: boolean;
}

export interface TeamView {
  phase: Phase;
  quizTitle: string;
  teamId: string;
  teamName: string;
  /** Typed on another phone (or a new link) to carry on as this team. */
  teamCode: string;
  score: number;
  rank: number;
  teamCount: number;
  question?: QuestionView;
  /** Multiple choice only: the option the team picked. */
  myChoice?: number;
  /** The team's answer as readable text. */
  myAnswerText?: string;
  /** From the reveal onwards. */
  result?: { correct: boolean; points: number; answerText: string; detail?: string; correctIndex?: number; info?: string };
  /** On the leaderboard and at the end. */
  standings?: StandingRow[];
  /** Image for the next question, so phones can fetch it early. */
  preloadImage?: string;
}

/** Typed answers grouped by their normalised text, for the host to mark. */
export interface ReviewGroup {
  key: string;
  text: string;
  teams: string[];
  match: 'exact' | 'close' | 'none';
  correct: boolean;
}

export interface HostView {
  phase: Phase;
  quizTitle: string;
  questionCount: number;
  maxTeams: number;
  roomCode: string;
  joinUrl: string;
  /** The local-network link, offered as a fallback. */
  lanJoinUrl: string;
  /** Changes whenever the QR code does, so the page reloads the image. */
  qrVersion: number;
  network: NetworkStatus;
  /** `code` is blank on the TV screen: anyone with a team's code can take over its phone. */
  teams: { id: string; name: string; code: string; score: number; connected: boolean; answered: boolean }[];
  question?: QuestionView & { answerText: string; answer?: number; info?: string };
  answeredCount: number;
  connectedCount: number;
  /** Multiple choice: answers per option, once the question has closed. */
  distribution?: number[];
  /** Picture and music: answers to mark, once the question has closed. */
  review?: ReviewGroup[];
  /** Ordering: e.g. "3 of 8 teams got the order exactly right". Letter: how many teams tapped each letter. */
  summary?: string;
  /** Nearest wins: every guess, closest first, once the question has closed. */
  guesses?: { value: string; off: string; teams: string[]; winner: boolean }[];
  /** From the reveal: the quickest correct teams and what they earned for it. */
  fastest?: { name: string; points: number; place: number }[];
  standings: StandingRow[];
  preloadImage?: string;
  /** The host can end this quiz and go back to the library. */
  canEnd: boolean;
  /** Key for the read-only TV screen at /screen?key=…, safe to put on a TV. */
  screenKey: string;
}

/** What the host sees when no quiz is running. */
export interface HostIdleView {
  phase: 'idle';
  /** The quiz library and editor are available. */
  library: boolean;
  network: NetworkStatus;
}

export type ServerMessage =
  | { t: 'state'; view: TeamView | HostView | HostIdleView }
  | { t: 'quiz-ended' }
  | { t: 'joined'; token: string; teamName: string }
  | { t: 'rejoin-failed' }
  | { t: 'error'; message: string }
  | { t: 'kicked' }
  | { t: 'replaced' };
