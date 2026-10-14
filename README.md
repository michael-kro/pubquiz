# Pub Quiz

A self-hosted live pub quiz. The host runs it on a laptop. Each team joins on one phone by scanning a QR code, with nothing to install. Up to 30 teams.

Status: milestones M0 and M1 from [PLAN.md](PLAN.md) are done: multiple-choice questions on the local network.

## Run a quiz

Needs Node.js 22.18 or newer.

```sh
npm install
npm start -- examples/sample-quiz.yaml
```

The host screen opens in your browser. Put it on the projector, and teams scan the QR code to join. Use the yellow button (or Space, →, or a presentation clicker) to move through each question:

**Start quiz → Close question → Reveal answer → Show leaderboard → Next question**

A question also closes on its own when time runs out or every connected team has answered.

Teams' phones must be on the same Wi-Fi as the laptop. Some pub and guest Wi-Fi blocks this. If phones can't load the join page, run the quiz on the laptop's own hotspot. Internet tunnel mode comes in M3.

Options: `--port 3001`, `--public-host <address>` (overrides the address in the join link), `--no-open`.

## Writing a quiz

See [examples/sample-quiz.yaml](examples/sample-quiz.yaml). Each question needs `text`, 2–4 `options`, and `answer`, which is the position of the correct option counting from 0. `seconds` (default 20) and `points` (default 1000) are optional. A correct answer earns its full points if instant, falling to half at the deadline. Set `scoring.speedFactor: 0` to turn the speed bonus off.

If the file has a mistake, the program says where, e.g. `Round 1, question 3, answer: must be the position of one of the options, counting from 0`.

## Development

```sh
npm run dev        # restarts on changes, using the sample quiz
npm run check      # typecheck + tests
```

The server is TypeScript run directly by Node (no build step). The browser pages in `public/` are plain JavaScript modules.

- `server/game.ts`: the quiz state machine, scoring and per-team views. The server owns all state and timing.
- `server/server.ts`: HTTP for the pages and QR code, plus the WebSocket protocol (`server/protocol.ts`).
- `server/quiz.ts`: YAML loading and validation.
- `test/`: unit tests, and an end-to-end test that plays a quiz over real WebSockets.
