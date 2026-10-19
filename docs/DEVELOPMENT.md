# Development, packaging and how it stays fair

## Hardening and load testing

- Teams are limited to a burst of messages, then a steady rate; a connection that floods is dropped. Wrong room codes and wrong team codes are limited per address (through the internet link, per visitor), and the host PIN has its own lockout.
- Team names have invisible and text-flipping characters removed, and swearing is blocked (`--no-name-filter` turns the word filter off).
- Every page is sent with a content policy, no referrer and no framing, so the host key in the host link can't leak.
- `node scripts/loadtest.ts` plays a whole quiz with 30 simulated teams on a slow, jittery network where connections keep dropping, and checks every score on every phone and on the host screen. `--help` lists the options. A smaller version runs in `npm test`.

## Packaging

**Single-file programs** (no Node needed on the host's computer):

```sh
npm run build:binaries                  # all five into dist/, with dist/SHA256SUMS
node scripts/build-binaries.mjs linux-x64   # or just the ones you name
```

Targets: `macos-arm64`, `macos-x64`, `linux-x64`, `linux-arm64`, `windows-x64`. They are 60–90 MB each (they include a JavaScript runtime, [Bun](https://bun.sh)) with the pages and sample quiz baked in. They aren't signed, so macOS and Windows warn on first run (see the getting-started guide). Needs internet the first time, to fetch each platform's runtime.

**Docker:**

```sh
docker compose up -d               # uses ~/PubQuiz (PUBQUIZ_LIBRARY=/other/folder to change it)
docker compose logs pubquiz        # prints the host link
```

Quizzes, saved games and results live in the `pubquiz-data` volume. Settings are environment variables in [compose.yaml](../compose.yaml): `PUBQUIZ_HOST_PIN`, `PUBQUIZ_LAN`, `PUBQUIZ_PUBLIC_HOST`, `PUBQUIZ_PUBLIC_URL`. The internet link works from inside the container. For local-Wi-Fi mode in Docker, set `PUBQUIZ_LAN=1` and `PUBQUIZ_PUBLIC_HOST` to the computer's address on the venue Wi-Fi.

## How timing stays fair

Each phone times its own answer, from the moment the question appears on its screen, so a slow connection never costs a team points. The server checks that figure against what it saw (the time since it sent the question, less the phone's measured round trip) and uses its own figure if the phone's doesn't fit, so a doctored page can't claim an instant answer.

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

## Trying things without your real quizzes

`npm run try` starts the quiz with a brand-new, empty library and settings in temporary folders, on port 3001 (so it can run beside your real one), and deletes them when you stop. `npm run try -- --keep` keeps the folders. To choose the folders yourself, set `PUBQUIZ_HOME` (quizzes, clips, branding, saved games) and `PUBQUIZ_CONFIG_DIR` (the app's own settings and downloaded helper), or pass `--quizzes <folder>`. These work with the downloaded programs too, for example `PUBQUIZ_HOME=/tmp/trial ./pubquiz-macos-arm64`.
