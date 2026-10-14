// Messages exchanged over the WebSocket. The browser clients in public/ follow these shapes.
import { z } from 'zod';

export type Phase = 'lobby' | 'open' | 'closed' | 'reveal' | 'leaderboard' | 'finished';

const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('host'), key: z.string().max(200) }),
  z.object({ t: z.literal('join'), room: z.string().max(20), name: z.string().max(200) }),
  z.object({ t: z.literal('rejoin'), token: z.string().max(200) }),
  z.object({ t: z.literal('answer'), choice: z.number().int() }),
  // Host only.
  z.object({ t: z.literal('advance') }),
  z.object({ t: z.literal('kick'), teamId: z.string().max(200) }),
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

interface QuestionView {
  index: number;
  total: number;
  round: string;
  text: string;
  options: string[];
  seconds: number;
  /** Only while the question is open. Clients count down from when they receive it. */
  remainingMs?: number;
}

export interface TeamView {
  phase: Phase;
  quizTitle: string;
  teamId: string;
  teamName: string;
  score: number;
  rank: number;
  teamCount: number;
  question?: QuestionView;
  myAnswer?: number;
  /** From the reveal onwards. */
  result?: { correctIndex: number; correct: boolean; points: number };
  /** On the leaderboard and at the end. */
  standings?: StandingRow[];
}

export interface HostView {
  phase: Phase;
  quizTitle: string;
  questionCount: number;
  maxTeams: number;
  roomCode: string;
  joinUrl: string;
  teams: { id: string; name: string; score: number; connected: boolean; answered: boolean }[];
  question?: QuestionView & { answer: number };
  answeredCount: number;
  connectedCount: number;
  /** Answers per option, once the question has closed. */
  distribution?: number[];
  standings: StandingRow[];
}

export type ServerMessage =
  | { t: 'state'; view: TeamView | HostView }
  | { t: 'joined'; token: string; teamName: string }
  | { t: 'rejoin-failed' }
  | { t: 'error'; message: string }
  | { t: 'kicked' }
  | { t: 'replaced' };
