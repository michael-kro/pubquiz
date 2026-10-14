# Pub Quiz

A self-hosted live pub quiz. The host runs it on a laptop. Each team joins on one phone by scanning a QR code, with nothing to install. Up to 30 teams.

Status: milestones M0–M6 and parts of M8 from [PLAN.md](PLAN.md) are done: all five question types, an in-app quiz editor, joining over the internet or local Wi-Fi, reconnects and crash recovery.

New here? Read [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md). Trouble at a venue? See [docs/VENUE-TROUBLESHOOTING.md](docs/VENUE-TROUBLESHOOTING.md).

## Run a quiz

From source (needs Node.js 22.18 or newer), or use a [single-file program or Docker](#packaging).

```sh
npm install
npm start                                  # your quiz library and editor
npm start -- examples/sample-quiz.yaml     # or run one quiz file straight away
```

The host screen opens in your browser. With no quiz file it shows **Your quizzes**, kept in `~/PubQuiz` (change it with `--quizzes <folder>`). There you can:

- **New quiz:** write one in the editor. Pick a type for each question, upload pictures (big photos are shrunk automatically), drag questions to reorder them, and see a preview of what teams see. It saves as you type, and marks anything that needs fixing.
- **Import:** a `.yaml` quiz file, or a `.zip` with `quiz.yaml` and an `images/` folder.
- **Export:** a `.zip` you can back up, share or import elsewhere.
- **Run ▶:** start the quiz. **End quiz** takes you back. An unfinished quiz can be resumed later or started over.

The host link stays the same between runs, so you can bookmark it.

Show the QR code on a projector, and teams scan it to join. Use the yellow button (or Space, →, or a presentation clicker) to move through each question:

**Start quiz → Close question → Reveal answer → Show leaderboard → Next question**

A question also closes on its own when time runs out or every connected team has answered.

**TV screen:** the host screen has a **TV screen ↗** button. Open that link on the TV or projector and run the quiz from your phone or laptop. The TV shows the question, countdown, answer count, leaderboard (with points gained and places moved), a round break after each round, and a podium at the end. It never shows an answer before the reveal, and has no controls. The 🔇 button turns on sound effects.

**Running the night:** during a question the host can **Pause** (the clock stops for every team, and resuming gives back exactly the time left; **P** also works), add **+10 s**, or **Skip question** (nobody scores on it). Teams with equal scores are separated by their quicker total answer time.

**From a phone:** start with `--host-pin <pin>` (6 or more characters), open `/host` on the host's phone and type the PIN. The phone remembers it. Wrong guesses are limited, but if the quiz is on the internet link, choose a long PIN.

**Branding:** press **Branding** on the quizzes screen to set your venue's name, tagline, accent and background colours, and logo. They show on the team phones (join, lobby and final screens), the host screen and the TV. Text colours are worked out for you so everything stays readable, and the panel warns if the accent is hard to see. Use a logo with a transparent background. To brand a single quiz file, point `--branding <folder>` at a folder holding `branding.json` and `logo.png` (see `venues/my-venue/branding` for a real one).

**Team photos:** each team can add a photo from its phone (a selfie, or one from the camera roll). It is cropped square and shrunk on the phone, checked by the server, and shows next to the team's name on the leaderboard, the TV, the host list and the podium. Teams without one get coloured initials. The host can untick **Team photos** at any time to switch them off for everyone, or hover over a team and press 🚫 to remove one. `--no-photos` starts with photos off. Photos are saved beside the game, so they survive a restart, and a new game starts without them.

**Speed bonus:** besides faster answers scoring more, the quickest correct teams earn extra: set `fastBonus` and `fastPlaces` under `scoring` (or use the editor's **Fastest teams bonus**). First place gets all of it, second 60% and third 30%. The reveal shows who earned it.

**Results:** when a quiz finishes, a `…results-<date>.csv` is saved next to it, and the final screen has **Download results (CSV)** with one column per question.

### How phones connect

By default the quiz gets a free public `https://` link from Cloudflare (no account needed), and the QR code points to it. Teams can use 4G or any Wi-Fi, and pub Wi-Fi that stops devices seeing each other doesn't matter. The first run downloads Cloudflare's `cloudflared` tool (checksum-verified) to `~/.pubquiz/bin`. The host screen shows **🌐 Internet link** when it's ready, usually within 15 seconds. The QR code only switches to it once the link is confirmed working.

If the link drops, the app keeps trying to restore it, and the host screen offers **Switch to local Wi-Fi**. A restored link has a new address. Teams rejoin by scanning the new QR code and tapping **Rejoin with your team code**: the 6-character code is at the bottom of every team's screen. The same code moves a team to another phone if a battery dies.

No internet at the venue? Run with `--lan`, and put the phones on the same Wi-Fi as the laptop, or on the laptop's own hotspot.

Options:

| Option | What it does |
|---|---|
| `--lan` | Local Wi-Fi only, no internet link |
| `--tunnel ngrok` | Use ngrok instead of Cloudflare (needs ngrok installed and signed in) |
| `--public-url <url>` | Use your own public address, e.g. a VPS or Tailscale Funnel |
| `--port 3001` | Use a different port |
| `--public-host <address>` | Override the laptop address in the local join link |
| `--no-open` | Don't open the host screen automatically |
| `--fresh` | Start over instead of resuming an unfinished quiz |

**If something goes wrong mid-quiz:** phones that lose signal or lock rejoin automatically with their score. The quiz is saved to `<quiz name>.session.json` as it runs. If the laptop crashes or you close the program, run the same command again: it carries on from where it was, with the same room code and host link. Use `--fresh` to start over.

**Fair timing:** the server measures each phone's connection delay and takes it off the answer time, so a team on a slow connection isn't penalised (up to 1.5 seconds).

## Writing a quiz

See [examples/sample-quiz.yaml](examples/sample-quiz.yaml), which has every question type:

| Type | Teams see | You write |
|---|---|---|
| `multiple-choice` | 2–6 coloured buttons | `options`, and `answer`: the right option's position counting from 0 |
| `picture` | The picture and a text box | `image` and `accept`: the answers to accept |
| `music` | A text box (you play the track) | `accept` |
| `ordering` | 5 shuffled items to tap into order | `items`, listed in the correct order |
| `letter` | An A–Z keypad: tap the answer's first letter | `answer`, e.g. `John Lennon` (letter J). Skip "The"; people go first name first. |
| `buzzer` | One huge BUZZ button | `answer` (for you to judge with), optionally `penalty` |
| `number` | A box to type a number | `answer`, and optionally `tolerance` (give or take) |
| `nearest` | A box to type a number; the closest guess wins | `answer`. Good as a bonus question or tie-break. |

**Buzzin' questions** work like a pub buzzer round. Read the question out; the first team to press BUZZ answers out loud, the game clock stops while they do, and you press **✓ Correct** or **✗ Wrong** (or **Y** / **N** on the keyboard). Right: the team scores the points and the question ends. Wrong: that team is out (and loses `penalty` points if you set one), the next team in the buzz order answers, and if nobody is waiting the clock carries on for everyone still in. Buzzes within a tenth of a second of each other are ordered by their latency-adjusted time, so a slow connection doesn't lose the buzz.

Any question can also have `audio`, a sound clip (mp3, m4a, ogg or wav, up to 20 MB; a file next to the quiz, or a web address). It plays on the host or TV screen, never on phones: the clip bar has Play, Pause and Replay, it starts by itself when that screen's 🔊 sound is on, and pausing the game pauses the clip. Upload clips in the editor's **Audio clip** field. Zip exports and imports include them.

Any question can also have `info`, a fun fact or source that is shown with the answer at the reveal.

Typed answers are matched ignoring case, punctuation, a leading "the" and small typos. When a picture or music question closes, you see every answer grouped together. Tick or untick each one, then reveal.

Scoring is set for the whole quiz in a `scoring:` block, and can be overridden per round with `mode:`:

```yaml
scoring:
  mode: speed          # speed (default): faster answers score more
                       # flat: every correct answer scores the same
                       # first: flat, plus `bonus` extra points for the first correct team
  speedFactor: 0.5     # speed mode: a correct answer at the buzzer earns half the points
  bonus: 500           # first mode
  fastBonus: 250       # extra points for the quickest correct teams (0 = off)
  fastPlaces: 3        # how many teams earn it: 1, 2 or 3 (100%, 60%, 30%)
  leaderboard: question  # or `round`: only show the leaderboard at the end of each round
rounds:
  - name: Music
    mode: flat         # this round only
```

Every question can also set `seconds` (default 20), `points` (default 1000), `image`, and `speedBonus`. A correct answer earns its full points if instant, falling to half at the deadline. The speed bonus is off by default for music, because teams can't answer until they recognise the track. Set `scoring.speedFactor: 0` to turn it off everywhere. Ordering gives half the points for items in the right place and half for getting the whole order right.

If the file has a mistake, the program says where, e.g. `Round 1, question 3, answer: must be the position of one of the options, counting from 0`.

## Question bank

The editor's **📚 Question bank** button opens about 1,100 ready-made questions in 20 categories (general knowledge, science, geography, history, film, TV, music, sport, food and drink, literature, art, animals, technology and gaming, maths, words, mythology, business, 90s and 00s, space), each with a difficulty. Filter by category, type, difficulty or search words; each question shows its answer before you add it; questions already in your quiz are marked; **Add 10 random from these** builds a round in one click. Added questions are copies, so edit them freely.

Your own questions can live in the bank too: put YAML files in a `bank` folder inside your quiz library (same format as the files in [bank/](bank/), see [bank/example.yaml](bank/example.yaml)) and they appear marked "mine". Check any bank file with `node scripts/validate-bank.ts <file>`.

The bank was written by AI and then checked by separate AI reviewers working from memory, who fixed or removed anything doubtful. It has not been checked against sources, so skim the answers on the preview before a big night, and tell us about any that are wrong.

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
docker compose up -d
docker compose logs pubquiz        # prints the host link
```

Quizzes, saved games and results live in the `pubquiz-data` volume. Settings are environment variables in [compose.yaml](compose.yaml): `PUBQUIZ_HOST_PIN`, `PUBQUIZ_LAN`, `PUBQUIZ_PUBLIC_HOST`, `PUBQUIZ_PUBLIC_URL`. The internet link works from inside the container. For local-Wi-Fi mode in Docker, set `PUBQUIZ_LAN=1` and `PUBQUIZ_PUBLIC_HOST` to the computer's address on the venue Wi-Fi.

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
