# Getting started

Run a pub quiz from your laptop. Teams join on their phones by scanning a QR code. Nothing to install on the phones.

## 1. Get the program

Pick one:

- **A downloaded file** (no other software needed): `pubquiz-macos-arm64` (Apple silicon Mac), `pubquiz-macos-x64` (Intel Mac), `pubquiz-windows-x64.exe`, `pubquiz-linux-x64` or `pubquiz-linux-arm64`. Build them with `npm run build:binaries` (see the README).
- **From the source folder**, if you have Node.js 22.18 or newer: `npm install`, then `npm start`.
- **Docker**: `docker compose up -d`, then `docker compose logs pubquiz` for the host link. It uses your `~/PubQuiz` folder, the same one the downloaded program uses. (Or the ready-made image: see the README.)

These files are not signed (Apple charges $99 a year for a developer account and Windows certificates cost money too, so this free project hasn't paid for them), so your computer may warn about them the first time. Nothing is wrong with the files: it just can't vouch for who made them. Docker and running from the source folder need no warning.


- **Mac:** open Terminal, type `chmod +x ` (with a space), drag the file in, press Enter. Then drag the file in again and press Enter to run it. If macOS says it can't verify the developer, open System Settings → Privacy & Security and choose **Open Anyway**.
- **Windows:** double-click it. If SmartScreen appears, choose **More info → Run anyway**.

## 2. Open your quizzes

Run the program. Your browser opens the **host screen** with **Your quizzes**. Your quizzes are kept in a `PubQuiz` folder in your home folder.

- No quizzes yet? Press **Add a sample quiz to try**.
- **New quiz** opens the editor. Add a question, pick its type, tick the right answer. It saves as you type, and anything that needs fixing is flagged in red.
- **Import** takes a `.yaml` quiz file, or a `.zip` that has `quiz.yaml` and an `images` folder.

## 3. Start the quiz

1. Press **Run ▶** on a quiz.
2. The screen shows a **QR code**. On the projector or a TV, open the **TV screen ↗** link instead, so teams see only the questions. (Run the quiz from your laptop or phone.)
3. Each team scans the code with one phone and types a team name.
4. When the teams have joined, press **Start quiz**.

The first time you run it on a new computer, the internet link needs about 10–20 seconds to set up. The host screen says **🌐 Internet link** when it's ready. Teams who join before then need to be on the same Wi-Fi as your laptop.

## 4. Run the night

Press the yellow button (or **Space**, **→**, or a presentation clicker) to move on:

**Close question → Reveal answer → Show leaderboard → Next question**

- A question closes by itself when its time runs out, or when every team has answered.
- For picture and music questions, you'll see every team's answer grouped. Tick or untick each one, then reveal.
- **Pause** stops the clock for everyone. **+10 s** adds time. **Skip question** throws a question away.
- A team's phone drops or locks? It rejoins by itself with its score. A team that lost its page can type the **team code** shown at the bottom of every team screen.
- Closed the program by accident? Run it again and press **Resume** on the quiz. Same room code, scores kept.

At the end, the final screen shows a podium, and **Download results (CSV)** saves a spreadsheet with one column per question. A copy is also saved next to the quiz.

## Something not working?

See [VENUE-TROUBLESHOOTING.md](VENUE-TROUBLESHOOTING.md).

## Locking down the host controls

- `--host-pin <6+ characters>`: the host link also needs the PIN.
- `--host-local-only`: the host screen, host API, results download and PIN login only work on the laptop running the quiz. Requests through the internet tunnel or from another device on the Wi-Fi are refused. Teams and the TV screen are unaffected. (You can't run the quiz from a tablet in this mode.)
- `--new-key`: make a new host key at start-up. In the host screen, **🔑 New key** does it mid-quiz: the old host link and TV link stop working at once, and the TV needs opening again from the **TV screen** button.
- On shared public Wi-Fi, prefer the internet link (HTTPS) or your own router: in local mode the key travels over plain HTTP.

## Entry fee, admitting teams, prizes

On the start screen (before you press Start quiz) you can fill in an **entry fee** (for example "£5 per team") and up to three **prizes**. Both show big on the TV and on phones. Tick **Teams wait to be admitted** and new teams sit on a "Nearly there" screen on their phone until you press **Admit** next to their name (top of the right-hand panel, or **Admit** in the top bar), so you can check they have paid. Admit all, or turn a team away with ×. Waiting teams are not on the TV, the leaderboard or the results.

## Picture questions that reveal slowly

In the editor, tick **Reveal the picture slowly** on a picture question (or add `uncover: true` in the YAML). The picture starts behind black tiles that drop away, in a random order, as the time runs out. Everyone sees the same tiles. Faster answers still score more, so guessing early on a mostly-hidden picture is worth more.

## Long quizzes and big nights

`scripts/make-stress-quiz.ts` writes a 120-question quiz of long questions and long answers (it is in `examples/stress-test`; import it from the quizzes page to try it). `node scripts/stress.ts --external` plays it with 30 simulated phones, random reconnects and 4 extra teams knocking, then checks every phone's own results against the final scores. `scripts/sim-rounds.ts` plays 5 rounds of 10 with 20 teams and prints each round's scoreboard.

## Where your quizzes are kept

Quizzes, their pictures, your sound clips, the branding and saved games all live in one folder, `~/PubQuiz` by default. Back that folder up, or copy it to another computer, and you have everything. The program's own bits (the internet-link helper it downloads) live separately in `~/.pubquiz`.

To use a different folder (a Dropbox folder, say): open the quizzes page, press **⚙ Settings**, type the folder, leave "Copy my current quizzes…" ticked, and press **Save folder**. It takes effect the next time you start the program, and the old folder is left as it is. You can also set it outside the app: `--quizzes /path`, or the `PUBQUIZ_HOME` environment variable. Those two win over the app's setting (and the app tells you when that's the case).
