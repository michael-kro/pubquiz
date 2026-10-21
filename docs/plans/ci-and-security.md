# Plan: continuous integration and security checks

Everything here is free for a public GitHub repository. The Docker image workflow already exists (`docker-image.yml`).

## Stage 1: basics — DONE (`ci.yml`, `dependabot.yml`)

- Typecheck and the fast tests on every push and pull request, on Node 22.18 (the oldest supported) and 24 (what the Docker image uses).
- The load test runs as its own job, with one retry, because it depends on machine speed.
- `npm audit` for the shipped dependencies; high and critical advisories fail the build.
- A secret scan (gitleaks) over the whole history.
- A lint of the workflow files (actionlint).
- Dependabot: grouped weekly updates for npm packages, GitHub Actions and the Docker base image.

Checked locally before pushing: the steps run clean in Node 22.18 and 24 containers (220 tests), the audit reports 0 vulnerabilities, gitleaks finds nothing in 116 commits, and actionlint is clean.

**Still to do for stage 1, on GitHub:** after the first run, turn on branch protection for `develop` and `main` that requires the CI jobs to pass.

## Stage 2: static scanning — DONE (`security.yml`)

- **Semgrep Community Edition** with the TypeScript, JavaScript, Node, OWASP Top 10, secrets, Dockerfile and GitHub Actions rule packs, plus this app's own rules in `semgrep-rules/pubquiz.yml` (no HTML built from strings in the browser code, no `eval`, and keys, PINs and passwords compared with `timingSafeEqual` rather than `===`). The rules have tests (`semgrep --test semgrep-rules/`) that also run in CI. Results go to GitHub Code Scanning; any finding fails the build, and the repository was clean when this was added.
- **A guard test** (`test/host-only.test.ts`): every message type in the protocol must be classified as host-only or open, and every host-only one is tried from a team, the TV and a stranger and must change nothing. A new message type fails the test until it is classified. Checked by breaking a guard on purpose.
- **CodeQL** (GitHub's own) for JavaScript and TypeScript.
- **hadolint** and **Trivy** on the Dockerfile and the built image. The image is now built in two stages and ships without npm, which removed three high-severity findings that came from npm's own bundled packages (not the app's). It builds, runs healthy and starts its internet link as before.
- GitHub Actions are pinned to commit hashes (Dependabot keeps them current, with a one-week wait before new releases), and the scans also run weekly.

## Stage 3: browser tests and a quick DAST

- Turn the screen tour (a script that plays a whole quiz while watching the host on a phone and a laptop, the TV and a team phone) into a Playwright test: it fails on JavaScript errors or sideways scrolling, and keeps the screenshots as artefacts.
- **OWASP ZAP baseline scan** (passive, about 2 minutes) on every pull request. Start the app from a sample library and give ZAP the host key as a header so it can scan `/host` and `/api`.

## Stage 4: nightly and release

- **ZAP full (active) scan** nightly against the container, plus **nuclei** for misconfigurations and missing security headers.
- **WebSocket fuzz test:** ZAP handles the game's WebSocket messages poorly, so a small harness sends malformed, oversized and out-of-order messages as each role (nobody, team, TV, host) and checks the server stays up and leaks nothing.
- **Release job:** build the programs on each operating system, with checksums, an SBOM and signed provenance, and scan the image before publishing it.

## Keeping noise down

A baseline file and an ignore file for each scanner, and make new findings the gate rather than the whole list. Pin actions to commit hashes once Dependabot is managing them.
