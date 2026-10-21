# Plan: solo practice mode for test preparation

Status: **stage 1 built** (2026-10-21): `/practice` with its own key, `server/practice.ts` and `server/marking.ts`, `public/practice.js`, the **🎓 Practice** button and QR code on the host screen, learn and test modes, back/skip/flag, save and carry on, results by round, review and retry-what-I-missed, per-learner history in `practice/` in the library, tests and a pass in the browser tour. Questions that were open were settled with defaults: several learners by name (no PIN), any device (phone, tablet or laptop), no parent view yet. **Stage 2 built** the same day: progress per learner (attempts, topics weakest first, most-missed questions), Leitner-box review ("due for another look", per quiz), the parent/teacher view in the host's Practice pop-up, exam simulation (a time limit in test mode, marked when it runs out) and CSV/print export. "Topic" means the round name until stage 3 adds a `topic` field. Stage 3 below is still to do.

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

## Notes from stage 1

- "Nearest" questions count only an exact answer as right (there is nobody to be closer than); buzzer questions become "show me the answer, did I have it?", marked by the learner.
- Explanations come from the existing `info:` field, so no quiz format change was needed. Stage 3's `topic`, `explain` and `hint` fields are still open.
- A quiz that changes while a session is unfinished ends that session (what was done stays in the history).

## Risks

- **Wrong answers do more harm in practice than in a pub quiz.** Every question needs checking, and AI-written questions need a human pass.
- **Exam-board content is copyrighted.** Write original questions; do not copy past papers.
- **Children's data.** Keep it local, say so plainly, and keep the practice link private.
