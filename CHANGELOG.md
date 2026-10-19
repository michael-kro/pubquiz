# Changelog

## Unreleased

- **Fix:** the final results (and any leaderboard) on a team's phone no longer scroll sideways when team names are long; the list shrinks to fit and names are cut short.
- **Fix:** an ordering question that is asked before its timer starts no longer crashes the server (it showed up once "ask the question first" became the default).
- **New defaults:** "Teams wait to be admitted (paid)" and "Ask the question before the timer starts" are ticked by default. Untick either on the host screen, or set `readOut: false` in a quiz.
- **Host screen is labelled:** a yellow "🎛 HOST" badge and a yellow strip across the top, and the browser tab says "HOST"; the TV tab says "TV screen". So the controls are never mistaken for the TV.
- **Clips on a phone:** tap a clip's name to play it on the TV (no separate Play button, no delete button).
- **Copy buttons:** a "📋 Copy link" button beside the join address (lobby, top bar, short links, join QR screen), and "Copy join link" under More on a phone.
## 0.1.2 — 2026-10-19

- **Host from your phone, by QR:** "📲 Host on my phone" (on the quiz library screen and under More) shows a QR code of the host page. It uses the internet link when there is one, otherwise the laptop's Wi-Fi address.
- **Short links (optional):** `--short-links` (Docker: `PUBQUIZ_SHORT_LINKS=1`) asks is.gd for a short address for the internet link and shows it on the host screen and the TV lobby. Only keyless addresses are ever sent; the host link never is.
- **Clips: TV-only on a phone remote.** The clips list on a phone shows just a "📺 Play" button (the sound comes from the TV page). A "Show play on this device" tick brings the other button back; it is remembered per device.
- **Host from your phone:** on a narrow screen the host page becomes a remote: slim header, the question and answers, and large buttons in a bar at the bottom within thumb reach. Sign in with the host link or a `--host-pin` (`PUBQUIZ_HOST_PIN` in Docker).
- **Join QR code mid-quiz:** More → "Show join QR code" puts the QR code and room code over the host and TV screens for latecomers; "Hide QR code" takes it down.
- **Rank scoring is the new default:** a right answer is worth 10, plus a bonus for the fastest right answers: 10 for the quickest team, 9 for the next, 8, and so on down to nothing (`scoring: { mode: rank, rankBonus: 10 }`). The reveal tells each team what it got. Quizzes can still choose `speed`, `flat` or `first`, per quiz or per round.
- **End round button:** the host can end the current round early; the rest of it is skipped and the round leaderboard shows.
- **Ordering questions:** all five items are on the list from the start, shuffled; teams move them into order with ▲▼ arrows or by dragging the handle, then lock the order in. No more empty placeholders.

- **Docker uses your home folder:** the `docker run` command and `compose.yaml` mount `~/PubQuiz` as the library, so Docker and the downloaded program share quizzes and clips. The settings volume is writable by any user (`--user $(id -u):$(id -g)` on Linux).
- **HTTPS on port 443:** an optional Caddy service (`docker compose --profile https up -d`) with a local certificate for a name like `quiz.internal`. See `docs/HTTPS.md`.

## 0.1.1

- **Docker image:** each release now publishes a ready-made image to `ghcr.io/michael-kro/pubquiz` (Intel/AMD and Apple-silicon/Raspberry Pi), so Docker needs no download warning and no source folder.
- **Try it without your data:** `npm run try` starts with a fresh, empty library and settings in temporary folders (port 3001). `PUBQUIZ_HOME`, `PUBQUIZ_CONFIG_DIR` and `--quizzes` choose folders yourself.
- README is a quick start; docs are split into a host guide, quiz format and development notes; the unsigned programs are explained honestly, with the macOS 15 way past the warning.
- Load test runs on its own after the rest of the suite, so it isn't starved of CPU.
- **Halving round:** `halveOnWrong: true` on a round (usually the last): a team that gets any answer wrong has its score for that round halved. Phones and the TV warn about it, and the reveal explains the loss.

## 0.1.0: first release

A self-hosted live pub quiz: the host runs it on a laptop, teams join from their phones, the TV shows the questions.

**Running a quiz**
- One file to run (macOS, Linux and Windows builds) or a Docker image; no accounts and no install. Teams join on the venue's Wi-Fi, or over an internet link (Cloudflare tunnel) when the Wi-Fi isn't usable.
- Up to 30 teams (a host setting), one phone per team, no room code: teams open the home page and join. Team codes and saved logins let a team carry on from another phone or after a dropped connection.
- Fair timing for slow or jittery phones; the server is the referee. A crash or restart resumes where it stopped.
- Host controls: pause, +10 s, skip, ask-the-question-first mode, review and change answers before the reveal, breaks with fun facts, a clips soundboard (play on the host or the TV), prizes, entry fee with "admit team" once paid, lock joining, start only once a team has joined.

**Question types**
- Multiple choice, picture (optionally revealed slowly behind black tiles), music (answer only), ordering, first-letter keypad, number, closest-wins, buzzer, and a Jeopardy-style wager round.
- Reveal clips (a film quote after the answer), fastest-team bonus with photo flash, speed scoring.

**Building quizzes**
- In-app editor, YAML and zip import/export, a bank of about 1,160 ready-made questions, a guide for writing quizzes with AI (`docs/AI-QUIZ-GUIDE.md`) and a checker (`scripts/check-quiz.ts`).
- Venue branding (name, colours, logo). All your content lives in one folder (`~/PubQuiz` by default, changeable in Settings).

**Screens**
- TV scales to the screen; teams appear on the wait screen as they join; round leaderboards roll in from the bottom. Phones: keypads for letters and numbers that fit without scrolling, team photos.

**Tested**
- 181 automated tests; a 30-team load test with delays and dropped connections (0 answers lost); a 120-question, 30-team stress run with 206 reconnects (0 wrongly scored, server event-loop delay p99 16 ms).

**Known limits**
- Checked in headless Chrome and with simulated phones; real-phone and real-TV testing is still to come. The Linux and Windows binaries are built but were not run on those systems.
- The binaries are not code-signed (Apple's developer programme is $99 a year and Windows certificates cost money, which a free project hasn't paid for), so macOS and Windows warn the first time. Windows: More info → Run anyway. macOS: System Settings → Privacy & Security → Open Anyway, or download with `curl` to skip the warning. Docker and running from source need no warning.
- Tested with 30 teams; the setting allows up to 100.
