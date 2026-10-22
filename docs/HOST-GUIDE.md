# Host guide

Everything the host screen does. The [README](../README.md) has the five-minute start.

## The host screen

Start the program and open the host link (`docker logs pubquiz` prints it; from source it opens by itself). It stays the same between runs, so bookmark it. It shows **Your quizzes**:

- **New quiz** opens the editor: pick a type for each question, upload pictures (big ones are shrunk), drag questions to reorder, and preview the phone. It saves as you type and flags anything that needs fixing.
- **Import** a `.yaml` file or a `.zip` with `quiz.yaml` and `images/`. **Export** a `.zip` to back up or share.
- **Run ▶** starts a quiz; **End quiz** comes back here. An unfinished quiz offers **Resume** or **Start over**.
- **⚙ Settings** moves your library folder. **Branding** and **Clips** are described below.

## Running a quiz

The yellow button (or **Space**, **→**, or a presentation clicker) moves on: **Start quiz → Close question → Reveal answer → Next question**. A question also closes by itself when time runs out, or, with **Close early when all have answered** ticked, when every team has answered.

- **Ask the question before the timer starts** (ticked by default): you read the question out first; for multiple choice each press shows the next option, and the timer starts on the last one. **Start timer now** (or **S**) skips ahead.
- **Checking the answer:** when time is up, the answer shows in a dashed box only you can see. Click another option, or edit the value, to change it. For typed answers (picture, music) every team's answer is grouped: tick or untick each, then reveal. Scores follow, even after the reveal.
- **Pause** (**P**) stops the clock for everyone and resuming gives back exactly the time left. **+10 s** adds time. **Skip question** scores nobody. **⏭ End round** skips the rest of the round and shows its leaderboard.
- **Leaderboard:** the full board shows at the end of each round, and the top five after every reveal. **Leaderboard** shows the full one at any time; `leaderboard: question` in the quiz file shows it after every question.
- **☕ Break** puts a break screen with fun facts on the TV and the phones, with or without a timer.
- **Buzzer questions:** the first team to buzz answers out loud; you press **✓ Correct** or **✗ Wrong** (**Y** / **N**).
- **Results:** the final screen has a podium and **Download results (CSV)**, one column per question. A copy is saved next to the quiz.

Teams on equal points are separated by their quicker total answer time.

## The TV

**TV ↗** opens a page for the TV or projector: the QR code and the teams while waiting, then the question, countdown, answer count, leaderboard, round breaks and the podium. It never shows an answer before the reveal and has no controls. Press its 🔊 button once so clips and sound effects play.

- **Show teams on the TV as they join** (start screen): untick to keep names off the wait screen.
- **Show questions on the TV** (Options): untick if the TV runs behind the phones, which could give some teams a head start. The TV then shows only "Look at your phone" and the countdown until you reveal the answer.
- **⋯ More → Show join QR code** puts the QR code back on both screens mid-quiz for latecomers.

## Teams

- **Joining:** teams scan the QR code, or open the address shown, and type a name: one phone per team. Swearing is blocked (`--no-name-filter` allows anything). **Max teams** is 30 by default. **📱 Teams must join from a phone** (ticked by default) turns away a laptop or desktop browser that opens the join link, so nobody plays with a big screen and a search engine beside them; phones and tablets are fine. It is a deterrent, not a lock: a determined cheat can pretend to be a phone. Untick it for a night where laptops are wanted (a quiz over a video call, say). **Lock the quiz when it starts** stops new teams once you press Start; **🔒 Lock joining now** does it at once.
- **Entry fee and prizes** (start screen) show big on the TV and the phones. **Teams wait to be admitted (paid)** (ticked by default) holds new teams on a "Nearly there" screen until you press **Admit** or **Admit all**, so you can check they have paid; **×** turns one away.
- **Rejoining:** a phone that loses signal or locks rejoins by itself with its score. A team that lost its page scans again and taps **Already joined? Rejoin with your team code**; the 6-character code is at the bottom of its screen and under **🔑 Team codes**.
- **Team photos:** a team can add a photo (cropped, shrunk and checked by the server) that shows on the leaderboard, the TV and the podium. Untick **Team photos** to switch them off, hover over a team and press 🚫 to remove one, or start with `--no-photos`.
- **⏱ Head starts:** give a slower player (a young child, say) up to 30 seconds. It is taken off that team's answer time when working out who was fastest, so they can still win the speed points. Set it before the question; a ⏱ badge shows beside the team.

## Hosting from your phone

Open the host link on your phone, or press **⋯ → 📲 Host on my phone** on the quizzes screen for a QR code of it. The screen becomes a remote: the question and answers, and big buttons along the bottom. **Clips**, **Show join QR code**, **End round** and **End quiz** are under **⋯**. Keep the laptop on: it runs the quiz, the phone only controls it.

## Sound clips

**Clips** is a soundboard of your own mp3, m4a, ogg or wav files (up to 20 MB each, kept in `clips` inside your library). **📺 TV** plays a clip through the TV page; **▶ Play** plays it on the device you are holding (hidden on a phone). A question's own `audio` clip plays from the question screen.

## Branding and venues

**Branding** sets a name, tagline, two colours and a logo for every page; text colours are worked out so everything stays readable, and the panel warns if the accent is hard to see. Each venue is a profile: the tabs at the top of the panel switch between them, **+ New venue** adds one (optionally copied from the current one), and the 🍺 drop-down on the quizzes screen switches venue in one click. Profiles are folders under `branding/` in your library.

## Practice mode

For one person revising for a test (the 11+, SATs, a driving theory test) rather than a room full of teams. **⋯ → 🎓 Practice** on the quizzes screen shows a link and a QR code for a separate page with its own key; give it to the learner, not to teams, since it shows the answers. It works wherever the join link works, including over the internet link.

- The learner types a name, picks any quiz in your library, how many questions and whether to mix them up, and either **Learn as I go** (the answer, and the `info` line if the question has one, straight after each question) or **Test myself** (marked at the end).
- No timer stops anything; a small clock just shows time spent. They can go **Back**, **Skip**, **Flag** a question to look at again, and stop and **Carry on** later. Buzzer questions become "show me the answer, did I have it?".
- At the end: a percentage, a breakdown by round, every question with the right answer, and **Retry the ones I missed**. Past attempts are listed under **Before**.
- **Another look:** a question got wrong comes back after a day, then three days, a week and a fortnight; right every time and it stops. **Due for another look** on the learner's home page starts just those, per quiz.
- **📈 My progress:** attempts over time, every topic (round) weakest first, the questions missed most, and **Download everything as CSV** or **Print**. Each results page can be downloaded or printed too.
- **Exam practice:** in *Test myself*, set a **Time limit** and the paper is marked when the clock runs out, whatever state it is in.
- **For a parent or teacher:** the same **🎓 Practice** pop-up lists the learners; pick one for their attempts, weakest topics and most-missed questions, and a CSV.
- Each learner's history is a file under `practice/` in your library. Nothing leaves the machine. **⋯ More → New host key** also changes the practice link.

- **Hints and explanations:** a question with `hint` offers **💡 Hint**, one at a time (the results say how many were used); `explain` is shown after the question instead of `info`; `topic` groups progress finer than rounds. The editor has these under **🎓 For practice** on each question, and [AI-QUIZ-GUIDE.md](AI-QUIZ-GUIDE.md) tells an AI to write them. `true-false` questions are good for revision.
- **Aa** on the practice page: larger text, an easier-to-read font, and no clock at all.

Check AI-written questions by hand: a wrong answer does more harm in practice than in a pub.

## How phones connect

By default the quiz gets a free public `https://` link from Cloudflare (no account needed) and the QR code points to it, so teams can use 4G or any Wi-Fi, and pub Wi-Fi that stops devices seeing each other does not matter. The first run downloads Cloudflare's `cloudflared` (checksum-verified). The host screen shows **🌐 Internet link** when it is ready, usually within 15 seconds; until then the QR code uses the local address. The link has a **new address after every restart**, and after it drops and comes back: teams already in rejoin by themselves, latecomers scan the new code.

**No internet at the venue?** Press **Switch to local Wi-Fi** (or start with `--lan`; in Docker `PUBQUIZ_LAN=1`) and put the phones on the same Wi-Fi as the laptop, or on the laptop's hotspot. Try a hotspot before the night: some do not let devices see each other, and most allow only a handful. If the QR code shows the wrong address (a laptop with several networks), set `--public-host` (`PUBQUIZ_PUBLIC_HOST`).

| Option (Docker variable) | What it does |
|---|---|
| `--lan` (`PUBQUIZ_LAN=1`) | Local Wi-Fi only, no internet link |
| `--public-host <address>` (`PUBQUIZ_PUBLIC_HOST`) | The laptop's address in the local join link |
| `--public-url <url>` (`PUBQUIZ_PUBLIC_URL`) | Your own public address instead (a VPS, Tailscale Funnel) |
| `--tunnel ngrok` | ngrok instead of Cloudflare (needs ngrok installed and signed in) |
| `--short-links` (`PUBQUIZ_SHORT_LINKS=1`) | Ask is.gd for a short address (is.gd currently refuses Cloudflare's) |
| `--wifi-ssid <name>` `--wifi-password <pw>` | A second QR code for joining a Wi-Fi network, such as a hotspot |
| `--port <n>` (`PUBQUIZ_PORT`) | Another port |
| `--quizzes <folder>` (`PUBQUIZ_LIBRARY`) | Where your library is |
| `--no-open`, `--fresh` | Do not open the browser; start over instead of resuming |

## Locking down the host controls

- `--host-pin <6+ characters>` (`PUBQUIZ_HOST_PIN`): open `/host` and type the PIN instead of using the long link, which is handy on a phone. Wrong guesses are limited.
- **⋯ More → New host key** (or `--new-key`) replaces the key at once; the old host and TV links stop working.
- `--host-local-only`: the host screen only works on the laptop itself, not over Wi-Fi or the internet link.
- The host and TV links carry their key after a `#` (`/host#key=…`). Browsers never send that part to any server, so the key cannot end up in a proxy's or a log's records; the page keeps it and takes it out of the address bar. Old `?key=` links still work once.
- In local mode the host key travels over plain HTTP, so on shared Wi-Fi prefer the internet link.

## If something goes wrong

| What you see | Why | What to do |
|---|---|---|
| The QR code scans but the page never loads, and the host screen says **📶 Local Wi-Fi** | The phones are not on the laptop's Wi-Fi, or the venue Wi-Fi isolates devices | Press **Use the internet link**, or get the phones onto the laptop's network |
| **🌐 Connecting to the internet…** for a long time | The laptop has no internet, or the venue blocks it | Check the laptop can browse; otherwise use local Wi-Fi mode (above) |
| **⚠️ Internet link down** | The link dropped | It retries by itself; if it keeps failing, **Switch to local Wi-Fi** |
| A phone says "Reconnecting…" | It lost signal or went to sleep | It rejoins by itself; the score is kept |
| A team closed its page | | Scan again and **Rejoin with your team code** |
| Answers arrive late, or teams drop, on one Wi-Fi | Too many devices on it | Use the internet link so phones can use mobile data, and ask players to keep off the Wi-Fi for anything else |
| Pictures load slowly | Big files referenced by hand | Pictures uploaded in the editor are shrunk for you; shrink others first (10 MB each at most) |
| The laptop slept or the program closed | | Turn sleep off for the night. Start it again and press **Resume**: same room code, scores kept, phones rejoin |

**Fair timing:** each phone times its own answer and the server takes the connection delay off, so a slow connection is not penalised (up to 1.5 seconds).
