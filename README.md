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

2. **Run it.** Windows: double-click. Mac/Linux: in a terminal, `chmod +x pubquiz-macos-arm64`, then `./pubquiz-macos-arm64`.

   **Why your computer warns you:** the programs aren't code-signed. Signing costs money (Apple charges $99 a year for a developer account, and Windows certificates cost too), and this is a free project, so I haven't paid for it. Nothing is wrong with the files: the checksums are in the release, and the source is all here. Your computer just can't vouch for who made them. You'll see the warning once:
   - **Windows:** SmartScreen says "Windows protected your PC": choose **More info → Run anyway**.
   - **Mac:** if it says the developer can't be verified, open **System Settings → Privacy & Security** and choose **Open Anyway** next to the message. Or skip the warning by downloading in Terminal instead of the browser: `curl -L -o pubquiz https://github.com/michael-kro/pubquiz/releases/latest/download/pubquiz-macos-arm64 && chmod +x pubquiz && ./pubquiz` (use `pubquiz-macos-x64` on an Intel Mac).
   - **Linux:** no warning.
   If you'd rather not run an unsigned program, use Docker or run it from source (below): they need no warning at all.
3. **Your browser opens the host screen.** Press **Add a sample quiz to try**, then **Run ▶**.
4. **Teams join.** Put the QR code on the TV (press **TV screen ↗** and open that link on the TV's browser). Teams scan it, or open the address shown, on the same Wi-Fi as your laptop. They type a team name and they are in. No code needed.
5. **Run the quiz** with the yellow button (or Space): **Start quiz → Close question → Reveal answer → Next question**.

That is a whole quiz night. Everything else is optional.

**Docker instead** (no download warning, and it runs on Intel and Apple-silicon machines):
```sh
mkdir -p ~/PubQuiz
docker run -d --name pubquiz -p 3000:3000 \
  -v ~/PubQuiz:/data/quizzes -v pubquiz-data:/data \
  ghcr.io/michael-kro/pubquiz:latest
docker logs pubquiz        # prints the host link
```
This uses your own `~/PubQuiz` folder, the same one the downloaded program uses, so your quizzes and clips are in both (run only one at a time). On Linux add `--user $(id -u):$(id -g)` so files stay yours; on Windows use `-v "%USERPROFILE%\PubQuiz:/data/quizzes"`. Or from a copy of the source: `docker compose up -d`, then `docker compose logs pubquiz` (it uses `~/PubQuiz` too). For HTTPS on port 443 with your own name, see [docs/HTTPS.md](docs/HTTPS.md). For venue Wi-Fi with no internet, add `-e PUBQUIZ_LAN=1 -e PUBQUIZ_PUBLIC_HOST=<your laptop's address>`.
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
- [HTTPS](docs/HTTPS.md): your own name on port 443 with a certificate.
- [Development](docs/DEVELOPMENT.md): building from source, the single-file programs, tests and how timing stays fair.

## Releases and contributing

**A new version every two weeks, on a Monday** (the first is 2 November 2026). The Friday before is a freeze: only fixes go in, so the weekend is for testing on a real phone and TV. Anything not ready waits for the next release.

| Branch | For | Made from | Merges into |
|---|---|---|---|
| `main` | What has been released, always tagged | | |
| `develop` | The next release, always green | | |
| `feature/<name>` | New functionality | `develop` | `develop` |
| `fix/<name>` | A bug fix that can wait for the next release | `develop` | `develop` |
| `hotfix/<name>` | An urgent fix to a released version (a crash, a wrong score, a security problem) | `main` | `main`, then back into `develop` |

Every change is a pull request that passes the tests and the security scans, adds a line to [CHANGELOG.md](CHANGELOG.md), and (for a fix) comes with a test that fails without it. A hotfix gets a patch release straight away (`0.2.1`) and does not wait for the schedule. The full process, the release-day checklist and the hotfix steps are in [docs/RELEASING.md](docs/RELEASING.md).
