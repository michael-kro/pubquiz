# Pub Quiz

Run a live pub quiz from your laptop. Teams join on their own phones by scanning a QR code, nothing to install. The TV shows the questions and the leaderboard. Up to 30 teams, no accounts, no cloud.

## Quick start (about 5 minutes)

1. **Install Docker** if you don't have it: [Docker Desktop](https://www.docker.com/products/docker-desktop/) on a Mac or Windows, Docker Engine on Linux. (Prefer not to use Docker? See "From source" below.)
2. **Start the quiz program.** In a terminal:
   ```sh
   mkdir -p ~/PubQuiz
   docker run -d --name pubquiz -p 3000:3000 \
     -v ~/PubQuiz:/data/quizzes -v pubquiz-data:/data \
     ghcr.io/michael-kro/pubquiz:latest
   docker logs pubquiz        # prints the host link
   ```
   On Linux add `--user $(id -u):$(id -g)` so your files stay yours. On Windows use `-v "%USERPROFILE%\PubQuiz:/data/quizzes"`. Your quizzes, pictures, clips and saved games live in that `PubQuiz` folder.
3. **Open the host link** that `docker logs pubquiz` printed. Press **Add a sample quiz to try**, then **Run ▶**.
4. **Teams join.** Put the QR code on the TV (press **TV screen ↗** and open that link on the TV's browser). Teams scan it, or open the address shown, on the same Wi-Fi as your laptop. They type a team name and they are in. No code needed.
5. **Run the quiz** with the yellow button (or Space): **Start quiz → Close question → Reveal answer → Next question**.

That is a whole quiz night. Everything else is optional.

**From source** (Node.js 22.18 or newer, no Docker): `git clone https://github.com/michael-kro/pubquiz.git`, then in that folder `npm install` and `npm start`. Your browser opens the host screen.

**More ways to run it with Docker.** From a copy of the source: `docker compose up -d`, then `docker compose logs pubquiz` (it uses `~/PubQuiz` too). For venue Wi-Fi with no internet, add `-e PUBQUIZ_LAN=1 -e PUBQUIZ_PUBLIC_HOST=<your laptop's address>`.

**Why there is no download to double-click:** a program that runs on any computer without a warning has to be signed with a paid developer certificate (Apple charges $99 a year; Windows certificates cost too), and this is a free project. Docker and the source need no warning at all.

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

- Teams can't connect, or the venue Wi-Fi is awkward: [docs/VENUE-TROUBLESHOOTING.md](docs/VENUE-TROUBLESHOOTING.md) (the internet link works from 4G or any Wi-Fi, so teams don't need the venue's network).
- Phones that lose signal rejoin by themselves, and a laptop crash or restart picks the quiz up where it stopped: just start the program again and press **Resume ▶**.

## More

- [Getting started](docs/GETTING-STARTED.md): a longer walk-through of a first night.
- [Host guide](docs/HOST-GUIDE.md): everything the host screen can do.
- [Development](docs/DEVELOPMENT.md): building from source, Docker, tests and how timing stays fair.

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
