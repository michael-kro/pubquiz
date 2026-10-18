# Writing a quiz

Writing it with an AI assistant? Hand it [AI-QUIZ-GUIDE.md](AI-QUIZ-GUIDE.md): a prompt and the whole format in one file. Check a file with `node scripts/check-quiz.ts quiz.yaml`.


See [examples/sample-quiz.yaml](../examples/sample-quiz.yaml), which has every question type:

| Type | Teams see | You write |
|---|---|---|
| `multiple-choice` | 2–6 coloured buttons | `options`, and `answer`: the right option's position counting from 0 |
| `picture` | The picture and a text box | `image` and `accept`: the answers to accept |
| `music` | A text box (you play the track) | `accept` |
| `ordering` | 5 items already on a list, shuffled, to move into order (▲▼ arrows, or drag the handle) | `items`, listed in the correct order |
| `letter` | An A–Z keypad: tap the answer's first letter | `answer`, e.g. `John Lennon` (letter J). Skip "The"; people go first name first. |
| `buzzer` | One huge BUZZ button | `answer` (for you to judge with), optionally `penalty` |
| `number` | A box to type a number | `answer`, and optionally `tolerance` (give or take) |
| `nearest` | A box to type a number; the closest guess wins | `answer`. Good as a bonus question or tie-break. |

**Buzzin' questions** work like a pub buzzer round. Read the question out; the first team to press BUZZ answers out loud, the game clock stops while they do, and you press **✓ Correct** or **✗ Wrong** (or **Y** / **N** on the keyboard). Right: the team scores the points and the question ends. Wrong: that team is out (and loses `penalty` points if you set one), the next team in the buzz order answers, and if nobody is waiting the clock carries on for everyone still in. Buzzes within a tenth of a second of each other are ordered by their latency-adjusted time, so a slow connection doesn't lose the buzz.

**Wager round (Jeopardy style):** put `wager: true` on a round, usually the last. For each question in it, teams first see only its `category` and bet points: up to their score (but always at least 200, so a team on zero can play), and no more than the round's optional `wagerCap`. A bet is locked once placed. You then press **Show question**; a right answer wins the bet, a wrong or missing one loses it (scores can go below zero), and betting nothing risks nothing. The TV never shows the question while teams are betting, and the reveal lists every team's bet. In the editor, tick **Wager round** on a round and give each question a **Category**.

**Halving round (high stakes):** put `halveOnWrong: true` on a round, usually the last. If a team gets **any answer wrong** in that round, its score **for that round** is halved: everything it earned in the round, before and after the wrong answer. Earlier rounds are untouched. A team that gives no answer is not penalised (it just earns nothing), a second wrong answer does not halve again, and closest-wins questions can never trigger it. Phones and the TV show a warning during the round, and the reveal tells the team what it lost ("Wrong: your score for this round is halved", with the points it cost). A round cannot be both a wager round and a halving round. In the editor, tick **Halve a team's round score if it gets an answer wrong** on the round. In the results CSV the per-question points are before halving; the Total includes it.

Any question can also have `audio`, a sound clip (mp3, m4a, ogg or wav, up to 20 MB; a file next to the quiz, or a web address). It plays on the host or TV screen, never on phones: the clip bar has Play, Pause and Replay, it starts by itself when that screen's 🔊 sound is on, and pausing the game pauses the clip. Upload clips in the editor's **Audio clip** field. Zip exports and imports include them.

Any question can also have `info`, a fun fact or source that is shown with the answer at the reveal.

Typed answers are matched ignoring case, punctuation, a leading "the" and small typos. When a picture or music question closes, you see every answer grouped together. Tick or untick each one, then reveal.

Scoring is set for the whole quiz in a `scoring:` block, and can be overridden per round with `mode:`:

```yaml
scoring:
  mode: rank           # rank (default): a right answer is worth 10, plus a bonus for the fastest right
                       # answers: 10 for the quickest team, 9 for the next, 8, and so on down to nothing.
                       # speed: faster answers score more
                       # flat: every correct answer scores the same
                       # first: flat, plus `bonus` extra points for the first correct team
  rankBonus: 10        # rank mode: the bonus for the fastest team (the next gets one less)
  speedFactor: 0.5     # speed mode: a correct answer at the buzzer earns half the points
  bonus: 50            # first mode
  fastBonus: 25        # extra points for the quickest correct teams (0 = off)
  fastPlaces: 3        # how many teams earn it: 1, 2 or 3 (100%, 60%, 30%)
  leaderboard: question  # or `round`: only show the leaderboard at the end of each round
rounds:
  - name: Music
    mode: flat         # this round only
```

Every question can also set `seconds` (default 20), `points` (default 10 in rank scoring, 100 otherwise), `image`, and `speedBonus`. A correct answer earns its full points if instant, falling to half at the deadline. The speed bonus is off by default for music, because teams can't answer until they recognise the track. Set `scoring.speedFactor: 0` to turn it off everywhere. Ordering gives half the points for items in the right place and half for getting the whole order right.

If the file has a mistake, the program says where, e.g. `Round 1, question 3, answer: must be the position of one of the options, counting from 0`.

## Question bank

The editor's **📚 Question bank** button opens about 1,100 ready-made questions in 20 categories (general knowledge, science, geography, history, film, TV, music, sport, food and drink, literature, art, animals, technology and gaming, maths, words, mythology, business, 90s and 00s, space), each with a difficulty. Filter by category, type, difficulty or search words; each question shows its answer before you add it; questions already in your quiz are marked; **Add 10 random from these** builds a round in one click. Added questions are copies, so edit them freely.

Your own questions can live in the bank too: put YAML files in a `bank` folder inside your quiz library (same format as the files in [bank/](bank/), see [bank/example.yaml](bank/example.yaml)) and they appear marked "mine". Check any bank file with `node scripts/validate-bank.ts <file>`.

The bank was written by AI and then checked by separate AI reviewers working from memory, who fixed or removed anything doubtful. It has not been checked against sources, so skim the answers on the preview before a big night, and tell us about any that are wrong.
