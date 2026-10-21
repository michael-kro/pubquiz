# Development

TypeScript run directly by Node (no build step); the browser pages in `public/` are plain JavaScript modules. Needs Node.js 22.18 or newer.

```sh
git clone https://github.com/michael-kro/pubquiz.git && cd pubquiz
npm install
npm start                                # the quiz library and editor
npm start -- examples/sample-quiz.yaml   # one quiz file straight away
npm run dev                              # restarts on changes, using the sample quiz
npm run check                            # typecheck + tests
npm run try                              # a throwaway library and settings on port 3001, deleted on exit (--keep keeps them)
```

`PUBQUIZ_HOME` (the library) and `PUBQUIZ_CONFIG_DIR` (settings and the downloaded `cloudflared`) choose the folders; `--quizzes <folder>` does the same for the library.

## Where things are

- `server/game.ts`: the quiz state machine, scoring and per-team views. The server owns all state and timing.
- `server/server.ts`: HTTP for the pages and QR codes, and the WebSocket protocol (`server/protocol.ts`).
- `server/quiz.ts`: YAML loading and validation. `server/bank.ts` and `server/facts.ts`: the built-in questions and break-screen facts.
- `server/branding.ts`, `clips.ts`, `photos.ts`, `session.ts`, `tunnel.ts`: venues, the soundboard, team photos, save and resume, the internet link.
- `public/host.js` (host screen and TV), `play.js` (team phone), `editor.js`, `branding.js`, `bank-picker.js`, `common.js`.
- `test/`: unit tests and end-to-end tests over real WebSockets; `test/slow/` is the load test.
- `scripts/`: `check-quiz.ts` and `validate-bank.ts` check files; `loadtest.ts`, `stress.ts` and `sim-rounds.ts` play simulated nights; `music-round.ts` builds a round from a track list; `ci-*.sh` back the scanning workflow.

## Tests

`npm test` runs the fast suite, then the load test: a whole quiz with 30 simulated phones on a slow, jittery network where connections keep dropping, checking every score on every phone. `node scripts/loadtest.ts --help` runs bigger versions. `test/host-only.test.ts` fails until every new WebSocket message type is classified as host-only or open, and then checks that teams, the TV and strangers are refused the host-only ones. `test/slow/fuzz-ws.test.ts` fuzzes the WebSocket protocol as every role (junk, oversized and binary frames, floods, well-formed messages at the wrong moment, wrong-role commands) and checks the server stays up, no setting changes, no answer leaks early and the quiz can still be finished; `test/slow/fuzz-http.test.ts` does the same to every upload (quiz import, pictures, audio, clips, logo, team photos): malformed, mislabelled, oversized and escaping files, zip bombs, lying content-lengths and junk JSON, with the right key, the wrong one and none; the server must never answer 500, accept nothing without the key, write nothing outside its folders and still work afterwards. Both are seeded, so `FUZZ_SEED` replays a run and `FUZZ_ITERATIONS=2000` makes a long one.

## How it stays fair and safe

- Each phone times its own answer from when the question appears; the server checks that against what it saw and uses its own figure if the phone's does not fit. A slow connection is not penalised, and a doctored page cannot claim an instant answer.
- Connections are rate-limited and dropped if they flood; wrong room codes, team codes and host PINs are limited per address.
- Team names lose invisible and text-flipping characters, and swearing is blocked.
- Keys never travel in a request address: links carry them in the fragment (`#key=…`), which stays in the browser, and the pages fetch clips, QR codes, results and exports with the key in a header (`x-host-key`, `x-screen-key`). A key in a query string is ignored. Every response carries a content security policy, no referrer, no framing and a permissions policy. Keys and PINs are compared in constant time.

## Docker

`docker compose up -d` builds and runs the image with `~/PubQuiz` as the library (`PUBQUIZ_LIBRARY` to change it) and a `pubquiz-data` volume for settings and `cloudflared`. Settings are environment variables in [compose.yaml](../compose.yaml). The image is built in two stages with no install scripts, runs as `node`, ships without npm, and starts Node with `--disallow-code-generation-from-strings` (no `eval` at runtime). The container runs read-only with every Linux capability dropped and no privilege escalation (`compose.yaml`, and the flags in the README command); the app only writes under `/data`. Each release publishes the image to `ghcr.io/michael-kro/pubquiz` for amd64 and arm64 with an SBOM and signed build provenance; check an image came from this repository's workflow with `gh attestation verify oci://ghcr.io/michael-kro/pubquiz:<version> --owner michael-kro`.

## CI and security scanning

Every push and pull request to `main` or `develop` runs:

- `ci.yml`: typecheck and tests on Node 22.18 and 24, the load test (with one retry), `npm audit`, a secret scan of the whole history (gitleaks) and a workflow lint.
- `security.yml`: Semgrep with the standard rule packs plus this app's own rules in `semgrep-rules/` (test them with `semgrep --test semgrep-rules/`), CodeQL, and hadolint and Trivy on the image. Also weekly.
- `dast.yml`: an OWASP ZAP passive scan of the running app, started on a throwaway library with a random key (`scripts/ci-start-app.sh` and `scripts/ci-zap.sh`, tuned in `.zap/rules.tsv`). An active scan runs nightly.

Dependabot proposes weekly updates. What is planned but not built is in `docs/plans/`.
