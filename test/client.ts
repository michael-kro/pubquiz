// WebSocket test client shared by the end-to-end tests.
import WebSocket from 'ws';

export type Message = any;

/** A WebSocket client that buffers messages so tests can wait for the one they care about. */
export class Client {
  private buffer: Message[] = [];
  private waiters: (() => void)[] = [];
  readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    // A server that hangs up abruptly (on purpose, in some tests) can reset the connection; that is not a failure here.
    ws.on('error', () => {});
    ws.on('message', (data) => {
      this.buffer.push(JSON.parse(data.toString()));
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  static async connect(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new Client(ws);
  }

  send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Resolves with the first buffered or future message matching `match`, discarding earlier ones. */
  async waitFor(match: (m: Message) => boolean, timeoutMs = 2000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.buffer.findIndex(match);
      if (index >= 0) return this.buffer.splice(0, index + 1)[index];
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out. Received: ${JSON.stringify(this.buffer)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  state(phase: string, extra: (view: Message) => boolean = () => true): Promise<Message> {
    return this.waitFor((m) => m.t === 'state' && m.view.phase === phase && extra(m.view)).then((m) => m.view);
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      this.ws.once('close', resolve);
      this.ws.close();
    });
  }
}

