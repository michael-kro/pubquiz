# Writing a quiz

A quiz is one `quiz.yaml` file, plus an `images/` folder if it has pictures. Write it in the app's editor or by hand; [examples/sample-quiz.yaml](../examples/sample-quiz.yaml) has every question type. Writing it with an AI? Hand it [AI-QUIZ-GUIDE.md](AI-QUIZ-GUIDE.md). Check a file with `node scripts/check-quiz.ts quiz.yaml`: mistakes are reported by place, e.g. `Round 1, question 3, answer: must be the position of one of the options, counting from 0`.

## Question types

| Type | Teams see | You write |
|---|---|---|
| `multiple-choice` | 2–6 coloured buttons | `options`, and `answer`: the right option's position counting from 0 |
| `picture` | The picture and a text box | `image` and `accept`: the answers to accept. `uncover: true` reveals the picture slowly behind black tiles |
| `music` | A text box (you play the track) | `accept` |
| `ordering` | 5 items, shuffled, to drag into order | `items`, listed in the correct order |
| `letter` | An A–Z keypad: tap the answer's first letter | `answer`, e.g. `John Lennon` (letter J). A leading "The" is skipped; people go first name first. `letter: B` overrides |
| `number` | A box to type a number | `answer`, and optionally `tolerance` (give or take) |
| `nearest` | A box to type a number; the closest guess wins | `answer`. Good as a bonus question or tie-break |
| `buzzer` | One huge BUZZ button | `answer` (for you to judge with), optionally `penalty` |

Any question can also have `seconds` (default 20), `points` (default 10 in rank scoring, 100 otherwise), `info` (a fun fact shown with the answer), `image`, and `audio`: an mp3, m4a, ogg or wav clip up to 20 MB, a file next to the quiz or a web address. Audio plays on the host and TV screens, never on phones, with Play, Pause and Replay, and pauses with the game. Zip exports and imports include it.

Typed answers (`accept`) are matched ignoring case, punctuation, accents, a leading "the" and small typos. When a picture or music question closes, the host sees every answer grouped and ticks or unticks each before revealing.

**Buzzer questions** work like a pub buzzer round. The first team to press BUZZ answers out loud, the clock stops while they do, and the host presses **✓ Correct** or **✗ Wrong**. Right: the team scores and the question ends. Wrong: that team is out (and loses `penalty` points if set), the next team in the buzz order answers, and if nobody is waiting the clock carries on. Buzzes within a tenth of a second are ordered by latency-adjusted time, so a slow connection does not lose the buzz.

**Wager round (Jeopardy style):** `wager: true` on a round, usually the last. For each question teams first see only its `category` and bet points: up to their score (always at least 200, so a team on zero can play), and no more than the round's optional `wagerCap`. Then the host shows the question; a right answer wins the bet, a wrong or missing one loses it (scores can go below zero), and betting nothing risks nothing. The TV never shows the question while teams are betting.

**Halving round:** `halveOnWrong: true` on a round, usually the last. A team that gets **any** answer wrong in that round has its score **for that round** halved, before and after the wrong answer; earlier rounds are untouched. No answer is not penalised, a second wrong answer does not halve again, and closest-wins questions never trigger it. Phones and the TV warn during the round and the reveal shows what it cost. A round cannot be both wager and halving. In the results CSV the per-question points are before halving; the total includes it.

## Scoring

Set for the whole quiz in a `scoring:` block, overridable per round with `mode:`:

```yaml
scoring:
  mode: rank           # rank (default): a right answer is worth 10, plus 10 for the fastest right
                       # answer, 9 for the next, 8, and so on down to nothing
                       # speed: faster answers score more | flat: every right answer scores the same
                       # first: flat, plus `bonus` extra for the first right team
  rankBonus: 10        # rank mode: the bonus for the fastest team (the next gets one less)
  speedFactor: 0.5     # speed mode: a right answer at the buzzer earns half the points (0 = off)
  bonus: 50            # first mode
  fastBonus: 25        # extra for the quickest right teams in any mode (0 = off)
  fastPlaces: 3        # how many earn it: 1, 2 or 3 (100%, 60%, 30%)
  leaderboard: round   # or question: show the full leaderboard after every question
rounds:
  - name: Music
    mode: flat         # this round only
```

In speed mode a right answer earns full points if instant, falling to half at the deadline; music questions skip that by default, because teams cannot answer until they recognise the track. Ordering gives half the points for items in the right place and half for the whole order right.

Top-level extras: `entryFee` and `prizes` (shown on the start screen), `facts` (fun facts for the break screen, or leave it out for the built-in ones), and `readOut: true` (the host asks each question before the timer starts).

## Question bank

The editor's **📚 Question bank** has about 1,150 ready-made questions in 19 topics (general knowledge, science, geography, history, film, TV, music, sport, food and drink, literature, art, animals, technology and gaming, maths, words, mythology, business, 90s and 00s, space), each with a difficulty. Filter by topic, type, difficulty or words; see each answer before adding; **Add 10 random from these** builds a round in one click. Added questions are copies, so edit them freely.

Your own questions can live in the bank too: YAML files in a `bank` folder inside your library (same format as [bank/example.yaml](../bank/example.yaml)) appear marked "mine". Check one with `node scripts/validate-bank.ts <file>`.

The bank was written by AI and checked by separate AI reviewers from memory, not against sources, so skim the answers before a big night.
