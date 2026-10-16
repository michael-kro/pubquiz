# Pub Quiz

Run a live pub quiz from your laptop. Teams join on their own phones by scanning a QR code, nothing to install. The TV shows the questions and the leaderboard. Up to 30 teams, no accounts, no cloud.

## Quick start (about 5 minutes)

1. **Download** the file for your computer from the [latest release](../../releases/latest):

   | Computer | File |
   |---|---|
   | Mac (Apple chip) | `pubquiz-macos-arm64` |
   | Mac (Intel) | `pubquiz-macos-x64` |
   | Windows | `pubquiz-windows-x64.exe` |
   | Linux | `pubquiz-linux-x64` or `pubquiz-linux-arm64` |

2. **Run it.** Windows: double-click (if SmartScreen appears: **More info → Run anyway**). Mac/Linux: in a terminal, `chmod +x pubquiz-macos-arm64` then `./pubquiz-macos-arm64` (on a Mac, if it is blocked, right-click the file and choose **Open**). The files are not signed, so a first-run warning is normal.
3. **Your browser opens the host screen.** Press **Add a sample quiz to try**, then **Run ▶**.
4. **Teams join.** Put the QR code on the TV (press **TV screen ↗** and open that link on the TV's browser). Teams scan it, or open the address shown, on the same Wi-Fi as your laptop. They type a team name and they are in. No code needed.
5. **Run the quiz** with the yellow button (or Space): **Start quiz → Close question → Reveal answer → Next question**.

That is a whole quiz night. Everything else is optional.

**Docker instead:** `docker compose up -d`, then `docker compose logs pubquiz` for the host link.
**From source** (Node.js 22.18+): `npm install`, then `npm start`.

## Where your things live

Your quizzes, pictures, sound clips, branding and saved games are in one folder:

- **Mac / Linux:** `~/PubQuiz`
- **Windows:** `C:\Users\<you>\PubQuiz`

Back that folder up and you have everything. To use a different folder (a Dropbox folder, say), press **⚙ Settings** on the quizzes page, or start with `--quizzes <folder>`, or set `PUBQUIZ_HOME`.

## Make your own quiz

- Press **New quiz** for the built-in editor, or **Import** a `.yaml` file or a `.zip` with pictures.
- About 1,160 ready-made questions are built in: pick them from the editor's **Question bank**.
- Let an AI write one: give it [docs/AI-QUIZ-GUIDE.md](docs/AI-QUIZ-GUIDE.md) and a topic.
- Question types: multiple choice, picture (optionally revealed slowly), music, ordering, first letter, number, closest wins, buzzer, and a Jeopardy-style wager round. See [docs/QUIZ-FORMAT.md](docs/QUIZ-FORMAT.md).

## If something goes wrong

- Teams can't connect, or the venue Wi-Fi is awkward: [docs/VENUE-TROUBLESHOOTING.md](docs/VENUE-TROUBLESHOOTING.md) (a small travel router is the reliable fix: [docs/ROUTER-SETUP.md](docs/ROUTER-SETUP.md)).
- Phones that lose signal rejoin by themselves, and a laptop crash or restart picks the quiz up where it stopped: just start the program again and press **Resume ▶**.

## More

- [Getting started](docs/GETTING-STARTED.md): a longer walk-through of a first night.
- [Host guide](docs/HOST-GUIDE.md): everything the host screen can do.
- [Development](docs/DEVELOPMENT.md): building from source, the single-file programs, tests and how timing stays fair.
