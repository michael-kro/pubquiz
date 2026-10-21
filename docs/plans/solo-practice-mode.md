# Plan: solo practice mode for test preparation

Status: **planned, not started.** Saved so it can be picked up later.

## The idea

One learner works through a quiz at their own pace, with no host, no teams and no live scoring. There is no timer by default. After each question they see whether they were right and why, and at the end they get a breakdown of what to work on. The aim is to help someone prepare for a test, for example the 11+, SATs or a driving theory test.

What changes from a live quiz: no fastest-answer bonus, no rank or speed scoring, no wagers, no buzzers, no halving rounds. A score is simply how many were right.

## Decisions

- **Separate from the live game.** A new `/practice` page with its own link key (like the TV link), so it is safe to use through the internet link. The live game code is not changed.
- **Learners are names, not accounts.** A name and an optional PIN. History is saved in the library folder, so nothing leaves the machine.
- **Reuse the marking.** Move answer matching (including the typo-tolerant text matching), validation and ordering marking into shared functions that both the live game and practice use. Practice gets its own small session engine, `server/practice.ts`.
- **Answers may go to the learner's browser.** There is no opponent to cheat against, so practice can check answers on the server per question (preferred, keeps one source of truth) without worrying about secrecy.

## Stage 1: the useful core (a few days)

- Pick a quiz, or a topic from the question bank.
- Options: number of questions, shuffle, **learn mode** (answer and explanation straight after each question) or **test mode** (marked at the end), and an optional soft timer that shows time spent but never stops anything.
- Back, skip, and flag-for-review.
- Results: a percentage, a breakdown by round or topic, "review what I missed", and "retry only the ones I missed".
- Save and resume.
- A "Practice" button on each quiz card on the host screen, with a link and QR code to give to the learner.

## Stage 2

- Progress over time and weak topics, per learner.
- Spaced repetition: missed questions come back after a delay (Leitner boxes).
- A parent or teacher view of a learner's stats, from the host screen.
- Exam simulation: a countdown for the whole paper, marked at the end.
- Results export (CSV or printable).

## Stage 3

- More question types: several right answers, true/false, hints that reveal step by step.
- Editor fields for `topic`, `explain` and `hint`; extend the AI quiz-writing guide to ask for them.
- Accessibility options: larger text, a dyslexia-friendly font, full keyboard use, no timer ever.

## Work breakdown

1. Extract the pure marking and validation functions from the game code and cover them with tests.
2. Practice session engine and per-learner store.
3. HTTP routes (a WebSocket is not needed for one learner).
4. `public/practice.html` and `practice.js`, reusing the team phone styles with a calmer layout, also usable on a tablet or laptop.
5. Host launcher on the quiz card, and the link key.
6. Results and history screens.
7. Editor fields and quiz format docs.
8. Tests: engine unit tests, plus the browser screen tour extended to the practice screens.

## Questions to settle before starting

- Who is the learner: one child at home, or several?
- Which test is it?
- Which device will they use?
- Does a parent or teacher want to see progress?

## Risks

- **Wrong answers do more harm in practice than in a pub quiz.** Every question needs checking, and AI-written questions need a human pass.
- **Exam-board content is copyrighted.** Write original questions; do not copy past papers.
- **Children's data.** Keep it local, say so plainly, and keep the practice link private.
