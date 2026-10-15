# Writing a quiz with AI

Give this file to an AI assistant (Claude, ChatGPT, Gemini…) together with your topic, and it can write a quiz file you can import straight into the app. Copy the prompt below, fill in the brackets, and paste this whole document after it.

## The prompt

> Write a pub quiz as a single `quiz.yaml` file, following the format in the guide below exactly.
> Topic/theme: **[e.g. 80s music and film]**. Audience: **[e.g. a mixed pub crowd, friendly difficulty]**.
> Size: **[e.g. 5 rounds of 10 questions]**. Use a mix of question types: **[e.g. mostly multiple choice, a few letter, number and ordering questions]**.
> Every question must have one clear correct answer you are confident about. Add a short `info` fun fact to about a third of them. Put the hardest question at the end of each round.
> Reply with only the YAML in one code block, then a list of any answers you are not 100% sure of.

Then save the YAML as `quiz.yaml`, check it (see the end), and import it in the app (**Import…** on the quizzes page).

## The file

```yaml
title: Friday Night Quiz            # required
entryFee: £5 per team               # optional, shown on the start screen
prizes: [A round of drinks, Bar tab, Chocolate]   # optional, up to 3: 1st, 2nd, 3rd
facts:                              # optional: fun facts for the break screen (max 200 characters each)
  - Honey never spoils.
scoring:                            # optional
  mode: speed                       # speed (default) | flat | first
  leaderboard: round                # round (default) | question
rounds:                             # required, at least one
  - name: General knowledge         # required
    questions:                      # required, at least one
      - { type: multiple-choice, text: "Capital of Australia?", options: [Sydney, Canberra, Melbourne, Perth], answer: 1 }
```

Everything is plain YAML. Indentation matters, and **text with a colon, a quote or a leading special character must be in double quotes**: `text: "Who said: 'I'll be back'?"`.

## Question types

Every question has `type` and `text` (required). Optional on any question: `seconds` (5 to 300, default 20), `points` (default 100), `info` (a fun fact shown with the answer, up to 300 characters), `image` (a file name or web address), `audio` (a clip the host plays).

| type | what to write | notes |
|---|---|---|
| `multiple-choice` | `options:` 2 to 6 choices, `answer:` the right one's position **counting from 0** | The most reliable type. Vary which position is right. |
| `letter` | `answer:` the full answer, for example `John Lennon` | Teams tap the **first letter** of the answer on a keypad. A leading "The", "A" or "An" is ignored (`The Beatles` is a B). For people, write the first name first (`John Lennon` is a J). If the answer starts with a number or symbol, add `letter: B` to say which letter to tap. |
| `number` | `answer:` a number, optional `tolerance:` (give or take) | Exact numbers: years, counts. |
| `nearest` | `answer:` a number | The closest guess wins. Good for "how many/how tall" bonus questions. |
| `ordering` | `items:` exactly **5** items **in the correct order** | The app shuffles them for teams. Items must all be different. |
| `picture` | `image:` and `accept:` a list of acceptable typed answers | Add `uncover: true` to reveal the picture slowly behind black tiles. Needs a picture file. |
| `music` | `accept:` a list of acceptable typed answers | The host plays the track; teams type the answer. |
| `buzzer` | `answer:` (for the host), optional `penalty:` | Teams race to buzz; the host judges. |

Typed answers (`accept`) ignore capitals, punctuation, accents, a leading "the" and small typos, so list the main ways to write it: `accept: [Queen]`, `accept: [Bohemian Rhapsody, Bohemian Rhapsody by Queen]`.

### Examples of each type

```yaml
- { type: multiple-choice, text: "Which planet is closest to the Sun?", options: [Venus, Mercury, Mars], answer: 1, info: "A year on Mercury is just 88 Earth days." }
- { type: letter, text: "Who sang Imagine?", answer: John Lennon }
- { type: number, text: "In which year did the Berlin Wall fall?", answer: 1989 }
- { type: nearest, text: "How many bones are in the adult human body?", answer: 206 }
- { type: ordering, text: "Smallest planet first", items: [Mercury, Mars, Venus, Earth, Jupiter] }
- { type: picture, text: "Whose flag is this?", image: images/flag.png, accept: [Japan], uncover: true }
- { type: music, text: "Name the band", accept: [Queen] }
```

## Rounds and extras

- **Wager round (Jeopardy style):** `wager: true` on a round, usually the last. Teams bet points before seeing each question, so give every question in it a `category:` (a short topic like `Rivers`). Optional `wagerCap:` limits the bet.
- **Per-round scoring:** `mode: flat` on a round overrides the quiz's mode for that round.
- **Ask first:** `readOut: true` at the top makes the host ask each question (and read out the multiple-choice answers one by one) before starting the timer.

## Rules that keep the quiz working

1. Exactly one correct answer. Check facts; do not guess. If the AI is unsure, drop the question.
2. `answer:` for multiple choice is a **number from 0**, not text.
3. `ordering` needs exactly 5 different items, listed in the correct order.
4. Don't repeat a question. Keep question text short for phones (under about 200 characters reads best; long passages work but are harder to read).
5. 6 to 10 questions per round, about 4 to 6 rounds, makes a good night.
6. Put images in an `images/` folder next to `quiz.yaml` and refer to them as `images/name.png`, or use a web address. Zip the folder to import it with its pictures.
7. Mix the types. Start each round with an easier question.

## Check the file

```
node scripts/check-quiz.ts path/to/quiz.yaml
```

prints `OK: "Friday Night Quiz", 5 rounds, 50 questions (…)` or exactly what is wrong and where, for example `Round 1, question 3, answer: must be the position of one of the options, counting from 0`. Paste any error back to the AI and ask it to fix the file. The app's **Import…** button gives the same messages.

## Other ways to build a quiz

- **From the question bank:** about 1,150 ready-made questions across 20 topics are built in; pick them in the editor's **Question bank** panel, or ask the AI to write a quiz and then swap in bank questions.
- **Fun facts for the break screen:** a `facts:` list in the quiz, or leave it out to use the built-in facts.
- **A music round from a track list:** `node scripts/music-round.ts tracks.txt out-folder "Name that tune"`, with one `Artist - Title` per line.
