// Saves the running quiz to disk so a crash or restart can carry on where it left off.
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { GameSnapshot } from './game.ts';

export interface Session {
  /** Identifies the quiz content, so a session is never resumed against an edited quiz. */
  quizHash: string;
  roomCode: string;
  hostKey: string;
  savedAt: string;
  game: GameSnapshot;
}

export function hashQuiz(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

export async function readSession(path: string): Promise<Session | undefined> {
  try {
    const session = JSON.parse(await readFile(path, 'utf8')) as Session;
    return session.game?.version === 1 ? session : undefined;
  } catch {
    return undefined;
  }
}

/** Writes to a temporary file first, so a crash mid-write never leaves a corrupt session. */
export async function writeSession(path: string, session: Session): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(session));
  await rename(temporary, path);
}

/**
 * Saves at most once per `delayMs`, always ending with the latest state.
 * Writes never overlap, so an older snapshot can't land after a newer one.
 */
export function createSaver(save: () => Promise<void>, delayMs = 200) {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let failed = false;

  const run = () => {
    timer = undefined;
    running = running
      .then(save)
      .then(() => {
        failed = false;
      })
      .catch((error: Error) => {
        // Report once, not on every change; keep trying on later changes.
        if (!failed) console.error(`Couldn't save the quiz session: ${error.message}`);
        failed = true;
      });
  };

  return {
    schedule() {
      timer ??= setTimeout(run, delayMs);
    },
    /** Writes any pending change now and waits for it. */
    async flush() {
      if (timer) {
        clearTimeout(timer);
        run();
      }
      await running;
    },
  };
}
