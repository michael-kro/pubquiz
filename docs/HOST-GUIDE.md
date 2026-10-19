# Host guide

Everything you can do from the host screen. New here? Start with [Getting started](GETTING-STARTED.md).

From source (needs Node.js 22.18 or newer). Most people use the downloaded program or Docker instead: see [Getting started](GETTING-STARTED.md).

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

**Start quiz → Close question → Reveal answer → Next question**

The full leaderboard comes by itself at the end of each round, and mid-round the reveal shows the top five. Press **Leaderboard** any time after a reveal to show the full board first. If you'd rather have it after every question, set `leaderboard: question` under `scoring` (or choose it in the editor).

**Checking the answer:** when time runs out the host screen shows the answer in a dashed box that only you can see, before you press Reveal answer. For multiple choice, click another option to change which one is right; for letter, number and nearest questions, edit the value. Scores follow, and you can still fix a slip after the reveal.

**Teams on the TV:** the wait screen lists teams as they join (untick **Show teams on the TV as they join** on the start screen to hide them). Once the quiz starts the TV never lists teams; the leaderboard shows who is winning.

A question also closes on its own when time runs out or every connected team has answered.

**TV screen:** the host screen has a **TV screen ↗** button. Open that link on the TV or projector and run the quiz from your phone or laptop. The TV shows the question, countdown, answer count, leaderboard (with points gained and places moved), a round break after each round, and a podium at the end. It never shows an answer before the reveal, and has no controls. The 🔇 button turns on sound effects.

**Ending a round early:** press **⏭ End round** (next to Skip question, in the **⋯ More** menu, and after a reveal) to skip what is left of the current round and show its leaderboard. The question on screen, if it hasn't been revealed, and the rest of the round score nothing for anyone; questions already revealed keep their points. Ending the last round finishes the quiz. It asks first.

**Running the night:** during a question the host can **Pause** (the clock stops for every team, and resuming gives back exactly the time left; **P** also works), add **+10 s**, or **Skip question** (nobody scores on it). Teams with equal scores are separated by their quicker total answer time.

**From a phone:** start with `--host-pin <pin>` (6 or more characters), open `/host` on the host's phone and type the PIN. The phone remembers it. Wrong guesses are limited, but if the quiz is on the internet link, choose a long PIN. The host screen reshapes itself on a phone: a slim header, the question and answers, and a bar of big buttons along the bottom (Next, Break, More). The QR code, Clips and End round are under More.

**Branding:** press **Branding** on the quizzes screen to set your venue's name, tagline, accent and background colours, and logo. They show on the team phones (join, lobby and final screens), the host screen and the TV. Text colours are worked out for you so everything stays readable, and the panel warns if the accent is hard to see. Use a logo with a transparent background. **Several venues:** each venue is a profile with its own name, colours and logo. The row of tabs at the top of the Branding panel switches between them, and **+ New venue** adds one (optionally starting from a copy of the current venue). A drop-down on the quizzes screen switches venue in one click; the page reloads in the new colours and every team phone and TV shows that venue from then on. The profiles are folders inside your library's `branding` folder (`branding/<venue>/branding.json` and `logo.png`), and the one in use is remembered in `branding/profiles.json`. To brand a single quiz file, point `--branding <folder>` at a folder holding `branding.json` and `logo.png` (see `venues/my-venue/branding` for a real one).

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
| `--wifi-ssid <name>` `--wifi-password <pw>` | Show a second QR code on the host and TV lobby for joining a Wi-Fi network (see [docs/ROUTER-SETUP.md](docs/ROUTER-SETUP.md)) |
| `--host-pin <pin>` | Sign in to `/host` by PIN, e.g. from a phone |
| `--branding <folder>` | Name, colours and logo for every page |
| `--no-photos`, `--no-name-filter` | Switch off team photos, or the swearing filter |

**If something goes wrong mid-quiz:** phones that lose signal or lock rejoin automatically with their score. The quiz is saved to `<quiz name>.session.json` as it runs. If the laptop crashes or you close the program, run the same command again: it carries on from where it was, with the same room code and host link. Use `--fresh` to start over.

**Fair timing:** the server measures each phone's connection delay and takes it off the answer time, so a team on a slow connection isn't penalised (up to 1.5 seconds).
