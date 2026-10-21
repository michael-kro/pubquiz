# Development, packaging and how it stays fair

## Hardening and load testing

- Teams are limited to a burst of messages, then a steady rate; a connection that floods is dropped. Wrong room codes and wrong team codes are limited per address (through the internet link, per visitor), and the host PIN has its own lockout.
- Team names have invisible and text-flipping characters removed, and swearing is blocked (`--no-name-filter` turns the word filter off).
- Every page is sent with a content policy, no referrer and no framing, so the host key in the host link can't leak.
- `node scripts/loadtest.ts` plays a whole quiz with 30 simulated teams on a slow, jittery network where connections keep dropping, and checks every score on every phone and on the host screen. `--help` lists the options. A smaller version runs in `npm test`.

## Packaging

The app ships as the Docker image (built for Intel/AMD and Apple-silicon/Raspberry Pi on each release) and as the source. There are no downloadable single-file programs: they could not be signed without a paid developer certificate, so every user got a security warning.

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

## Continuous integration

Every push and pull request to `main` or `develop` runs `.github/workflows/ci.yml`: typecheck and the fast tests on Node 22.18 and 24, the load test on its own (with one retry), `npm audit` for the shipped dependencies, a secret scan of the whole history, and a lint of the workflow files. Run the same checks locally with `npm run check`. The plan for what comes next (Semgrep, CodeQL, image scanning, browser tests and DAST) is in `docs/plans/ci-and-security.md`.

Security scanning (`.github/workflows/security.yml`) adds Semgrep with this app's own rules (`semgrep-rules/`, tested with `semgrep --test semgrep-rules/`), CodeQL, and hadolint and Trivy on the Docker image, on every push and pull request and weekly. `test/host-only.test.ts` makes every new WebSocket message type be classified as host-only or open. To run Semgrep yourself: `docker run --rm -v "$PWD:/src" -w /src semgrep/semgrep semgrep scan --config semgrep-rules/pubquiz.yml --config p/typescript --config p/javascript .`

Dynamic scanning (`.github/workflows/dast.yml`) runs OWASP ZAP against the app: a quick passive scan on every pull request, and an active scan nightly. Both start the app in a container on a throwaway library with a random host key, so nothing real is ever attacked. Tune what counts as a failure in `.zap/rules.tsv`. To run the passive scan yourself: `bash scripts/ci-start-app.sh` (then export `PUBQUIZ_HOST_KEY` from the library's `.host-key`) and `bash scripts/ci-zap.sh baseline`.
