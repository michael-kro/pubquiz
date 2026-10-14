# Getting started

Run a pub quiz from your laptop. Teams join on their phones by scanning a QR code. Nothing to install on the phones.

## 1. Get the program

Pick one:

- **A downloaded file** (no other software needed): `pubquiz-macos-arm64` (Apple silicon Mac), `pubquiz-macos-x64` (Intel Mac), `pubquiz-windows-x64.exe`, `pubquiz-linux-x64` or `pubquiz-linux-arm64`. Build them with `npm run build:binaries` (see the README).
- **From the source folder**, if you have Node.js 22.18 or newer: `npm install`, then `npm start`.
- **Docker**: `docker compose up -d`, then `docker compose logs pubquiz` for the host link.

These files are not signed, so your computer may warn about them the first time:

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
