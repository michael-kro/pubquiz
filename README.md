# Pub Quiz

Run a live pub quiz from your laptop. Teams join on their own phones by scanning a QR code; nothing to install. The TV shows the questions and the leaderboard. Up to 30 teams, no accounts, no cloud.

## Quick start

1. **Install [Docker](https://www.docker.com/products/docker-desktop/).**
2. **Start it:**
   ```sh
   mkdir -p ~/PubQuiz
   docker run -d --name pubquiz -p 3000:3000 \
     -v ~/PubQuiz:/data/quizzes -v pubquiz-data:/data \
     --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
     ghcr.io/michael-kro/pubquiz:latest
   docker logs pubquiz        # prints the host link
   ```
   Linux: add `--user $(id -u):$(id -g)` so files stay yours. Windows: use `-v "%USERPROFILE%\PubQuiz:/data/quizzes"`.
3. **Open the host link**, press **Add a sample quiz to try**, then **Run ▶**.
4. **Put the QR code on the TV**: **TV ↗** opens a page for it. Teams scan the code, type a team name, and they are in.
5. **Run the quiz** with the yellow button (or Space): **Start quiz → Close question → Reveal answer → Next question**.

## Your files

Quizzes, pictures, sound clips, branding, saved games and results all live in one folder: `~/PubQuiz` (`C:\Users\<you>\PubQuiz` on Windows). Back it up and you have everything. Change it under **⚙ Settings**, or with `--quizzes <folder>` or `PUBQUIZ_HOME`.

## Make a quiz

- **New quiz** opens the editor; **Import** takes a `.yaml` file or a `.zip` with pictures.
- About 1,150 ready-made questions in 19 topics are built in: the editor's **Question bank**.
- Let an AI write one: give it [docs/AI-QUIZ-GUIDE.md](docs/AI-QUIZ-GUIDE.md) and a topic.
- Question types: multiple choice, picture (optionally revealed slowly), music, ordering, first letter, number, closest wins and buzzer, plus wager and halving rounds. See [docs/QUIZ-FORMAT.md](docs/QUIZ-FORMAT.md).
- **🎓 Practice**: any quiz doubles as revision for one person, at their own pace, with the answers and explanations as they go. The host screen gives the link.

## Docs

- [Host guide](docs/HOST-GUIDE.md): everything the host screen does, hosting from your phone, practice mode, how phones connect, and what to do when something goes wrong.
- [Writing a quiz](docs/QUIZ-FORMAT.md), and [writing one with AI](docs/AI-QUIZ-GUIDE.md).
- [Development](docs/DEVELOPMENT.md): running from source, code layout, tests, Docker, CI and security scanning.
- [Releasing](docs/RELEASING.md): a release every Friday, cut and published by a workflow; `feature/` and `fix/` branches off `develop`, `hotfix/` off `main`; every change is a pull request that passes CI and adds a line to [CHANGELOG.md](CHANGELOG.md).

## Licence

[MIT](LICENSE). Logos, clips and photos you add to your own library are yours or their owners', not part of this project.
