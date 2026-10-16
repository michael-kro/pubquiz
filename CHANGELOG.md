# Changelog

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
