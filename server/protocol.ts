// Messages exchanged over the WebSocket. The browser clients in public/ follow these shapes.
import { z } from 'zod';
import type { QuestionType } from './quiz.ts';
import type { NetworkStatus } from './tunnel.ts';

export type Phase = 'lobby' | 'open' | 'closed' | 'reveal' | 'leaderboard' | 'finished';

/** Multiple choice: option index. Picture/music: typed text. Letter: one letter. Ordering: item indices as displayed, first to last. */
export type AnswerValue = number | string | number[];

const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('host'), key: z.string().max(200) }),
  z.object({ t: z.literal('join'), room: z.string().max(20), name: z.string().max(200) }),
  z.object({ t: z.literal('rejoin'), token: z.string().max(200).optional(), code: z.string().max(20).optional() }),
  z.object({
    t: z.literal('answer'),
    value: z.union([z.number().int(), z.string().max(200), z.array(z.number().int()).max(10)]),
  }),
  // Host only.
  z.object({ t: z.literal('advance') }),
  z.object({ t: z.literal('kick'), teamId: z.string().max(200) }),
  z.object({ t: z.literal('mark'), key: z.string().max(400), correct: z.boolean() }),
  z.object({ t: z.literal('network'), action: z.enum(['use-lan', 'use-tunnel']) }),
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
}

export interface QuestionView {
  index: number;
  total: number;
  round: string;
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
  result?: { correct: boolean; points: number; answerText: string; detail?: string; correctIndex?: number };
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
  teams: { id: string; name: string; score: number; connected: boolean; answered: boolean }[];
  question?: QuestionView & { answerText: string; answer?: number };
  answeredCount: number;
  connectedCount: number;
  /** Multiple choice: answers per option, once the question has closed. */
  distribution?: number[];
  /** Picture and music: answers to mark, once the question has closed. */
  review?: ReviewGroup[];
  /** Ordering: e.g. "3 of 8 teams got the order exactly right". Letter: how many teams tapped each letter. */
  summary?: string;
  standings: StandingRow[];
  preloadImage?: string;
}

export type ServerMessage =
  | { t: 'state'; view: TeamView | HostView }
  | { t: 'joined'; token: string; teamName: string }
  | { t: 'rejoin-failed' }
  | { t: 'error'; message: string }
  | { t: 'kicked' }
  | { t: 'replaced' };
