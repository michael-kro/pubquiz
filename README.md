# Pub Quiz

A self-hosted live pub quiz. The host runs it on a laptop. Each team joins on one phone by scanning a QR code, with nothing to install. Up to 30 teams.

Status: milestones M0, M1, M1b and M2 from [PLAN.md](PLAN.md) are done: all five question types on the local network, with reconnects and crash recovery.

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

Options: `--port 3001`, `--public-host <address>` (overrides the address in the join link), `--no-open`, `--fresh`.

**If something goes wrong mid-quiz:** phones that lose signal or lock rejoin automatically with their score. The quiz is saved to `<quiz name>.session.json` as it runs. If the laptop crashes or you close the program, run the same command again: it carries on from where it was, with the same room code and host link. Use `--fresh` to start over.

**Fair timing:** the server measures each phone's connection delay and takes it off the answer time, so a team on a slow connection isn't penalised (up to 1.5 seconds).

## Writing a quiz

See [examples/sample-quiz.yaml](examples/sample-quiz.yaml), which has every question type:

| Type | Teams see | You write |
|---|---|---|
| `multiple-choice` | 2–4 coloured buttons | `options`, and `answer`: the right option's position counting from 0 |
| `picture` | The picture and a text box | `image` and `accept`: the answers to accept |
| `music` | A text box (you play the track) | `accept` |
| `ordering` | 5 shuffled items to tap into order | `items`, listed in the correct order |
| `letter` | An A–Z keypad: tap the answer's first letter | `answer`, e.g. `John Lennon` (letter J). Skip "The"; people go first name first. |

Typed answers are matched ignoring case, punctuation, a leading "the" and small typos. When a picture or music question closes, you see every answer grouped together. Tick or untick each one, then reveal.

Every question can also set `seconds` (default 20), `points` (default 1000), `image`, and `speedBonus`. A correct answer earns its full points if instant, falling to half at the deadline. The speed bonus is off by default for music, because teams can't answer until they recognise the track. Set `scoring.speedFactor: 0` to turn it off everywhere. Ordering gives half the points for items in the right place and half for getting the whole order right.

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
