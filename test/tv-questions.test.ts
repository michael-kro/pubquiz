// Keeping the questions off the TV: it shows a countdown while a question is open, and the question again only with the answer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Game } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const QUIZ = `
title: TV
readOut: false
rounds:
  - name: R
    questions:
      - { type: multiple-choice, text: Secret question one, options: [Alpha, Beta, Gamma], answer: 1, seconds: 30 }
      - { type: ordering, text: Secret ordering, items: [a, b, c, d, e], seconds: 30 }
`;

async function setup() {
  const server = await createQuizServer({ closeEarly: false, lockOnStart: false, tvShowTeams: true, allowEmptyStart: true, quiz: parseQuiz(QUIZ), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  const team = await Client.connect(server.port);
  team.send({ t: 'join', name: 'Ann' });
  await team.waitFor((m) => m.t === 'joined');
  return { server, host, tv, team };
}

test('by default the TV shows the question, and the host can switch that off and on', async () => {
  const { server, host, tv, team } = await setup();
  assert.equal((await host.state('lobby')).tvShowQuestions, true);
  host.send({ t: 'advance' });
  const shown = await tv.state('open');
  assert.equal(shown.question.text, 'Secret question one');
  assert.equal(shown.question.hidden, undefined);

  host.send({ t: 'tv-questions', visible: false });
  const hidden = await tv.state('open', (v) => v.question.hidden === true);
  assert.equal(hidden.question.text, '');
  assert.equal(hidden.question.options, undefined);
  assert.equal(hidden.question.remainingMs !== undefined, true, 'the countdown still runs');
  assert.equal(hidden.question.total, 2, 'it can still say which question this is');
  assert.equal((await team.state('open')).question.text, 'Secret question one', 'the phones are unaffected');
  assert.equal((await host.state('open', (v) => v.tvShowQuestions === false)).question.text, 'Secret question one', 'and so is the host screen');
  for (const c of [host, tv, team]) await c.close();
  await server.close();
});

test('with questions off the TV shows nothing of the question until the answer, then shows it with the answer', async () => {
  const { server, host, tv, team } = await setup();
  host.send({ t: 'tv-questions', visible: false });
  host.send({ t: 'advance' });
  const open = await tv.state('open');
  assert.equal(open.question.hidden, true);
  assert.equal(JSON.stringify(open).includes('Secret question one'), false, 'the text is nowhere in what the TV is sent');
  assert.equal(JSON.stringify(open).includes('Beta'), false, 'nor the options');

  team.send({ t: 'answer', value: 1 });
  host.send({ t: 'advance' }); // close
  const closed = await tv.state('closed');
  assert.equal(closed.question.hidden, true);
  assert.equal(JSON.stringify(closed).includes('Secret question one'), false);
  host.send({ t: 'advance' }); // reveal
  const reveal = await tv.state('reveal');
  assert.equal(reveal.question.hidden, undefined);
  assert.equal(reveal.question.text, 'Secret question one');
  assert.equal(reveal.question.answerText, 'Beta');
  for (const c of [host, tv, team]) await c.close();
  await server.close();
});

test('ordering items are kept off the TV too', async () => {
  const { server, host, tv, team } = await setup();
  host.send({ t: 'tv-questions', visible: false });
  host.send({ t: 'advance' });
  host.send({ t: 'advance' });
  host.send({ t: 'advance' });
  host.send({ t: 'advance' }); // question 2 is open
  const open = await tv.state('open', (v) => v.question.index === 1);
  assert.equal(open.question.items, undefined);
  assert.equal(open.question.hidden, true);
  for (const c of [host, tv, team]) await c.close();
  await server.close();
});

test('the choice survives a restart', () => {
  const game = new Game(parseQuiz(QUIZ));
  game.setTvShowQuestions(false);
  const restored = Game.restore(game.quiz, JSON.parse(JSON.stringify(game.snapshot())));
  assert.equal(restored.hostView().tvShowQuestions, false);
  game.dispose();
  restored.dispose();
});
