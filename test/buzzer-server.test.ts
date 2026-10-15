// Buzzin' over real WebSockets: teams buzz, the host judges, the TV watches and never sees the answer early.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const quiz = parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: buzzer, text: "Capital of Australia?", answer: Canberra, seconds: 30, penalty: 100 }\n');

test('three teams, one buzzer question: first buzz answers, wrong locks them out, next gets it right', async () => {
  const server = await createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  const teams: Client[] = [];
  for (const name of ['Ann', 'Bob', 'Cat']) {
    const c = await Client.connect(server.port);
    c.send({ t: 'join', room: server.roomCode, name });
    await c.waitFor((m) => m.t === 'joined');
    teams.push(c);
  }
  const [ann, bob, cat] = teams as [Client, Client, Client];

  host.send({ t: 'advance' });
  const open = await ann.state('open');
  assert.equal(open.question.type, 'buzzer');
  assert.deepEqual(open.question.buzz, { state: 'ready' });
  assert.equal((await tv.state('open')).question.answerText, '', 'the TV does not see what the host is looking for');
  assert.equal((await host.state('open')).question.answerText, 'Canberra');

  // Typing an answer to a buzzer question is refused; judging with nobody answering is refused.
  ann.send({ t: 'answer', value: 'Canberra' });
  assert.equal((await ann.waitFor((m) => m.t === 'error')).message, 'Press the buzzer.');
  host.send({ t: 'judge', correct: true });
  assert.equal((await host.waitFor((m) => m.t === 'error')).message, 'No team is answering right now.');
  ann.send({ t: 'judge', correct: true });
  assert.equal((await ann.waitFor((m) => m.t === 'error')).message, 'Only the host can do that.');

  bob.send({ t: 'buzz' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  cat.send({ t: 'buzz' });
  const live = await host.state('open', (v) => v.buzzers?.[0]?.status === 'answering');
  assert.deepEqual(live.buzzers.map((b: { name: string; status: string }) => `${b.name}:${b.status}`), ['Bob:answering', 'Cat:queued']);
  assert.equal(live.question.paused, true, 'the clock is held');
  const tvLive = await tv.state('open', (v) => v.buzzers?.[0]?.status === 'answering');
  assert.equal(tvLive.buzzers[0].name, 'Bob');
  assert.equal((await ann.state('open', (v) => v.question.buzz.answering === 'Bob')).question.buzz.state, 'ready');
  assert.equal((await cat.state('open', (v) => v.question.buzz.state === 'queued')).question.buzz.position, 2);

  host.send({ t: 'judge', correct: false });
  await host.state('open', (v) => v.buzzers?.[0]?.name === 'Cat' && v.buzzers[0].status === 'answering');
  assert.equal((await bob.state('open', (v) => v.question.buzz.state === 'locked')).question.buzz.state, 'locked');
  bob.send({ t: 'buzz' });
  assert.equal((await bob.waitFor((m) => m.t === 'error')).message, "You're out for this question.");

  host.send({ t: 'judge', correct: true });
  await host.state('closed');
  host.send({ t: 'advance' });
  const reveal = await cat.state('reveal');
  assert.equal(reveal.result.correct, true);
  assert.equal(reveal.result.points, 1000);
  assert.equal(reveal.question.buzz.state, 'won');
  const bobReveal = await bob.state('reveal');
  assert.equal(bobReveal.result.points, -100);
  assert.equal(bobReveal.result.detail, 'Wrong answer: -100');
  assert.equal((await tv.state('reveal')).question.answerText, 'Canberra');
  host.send({ t: 'advance' });
  const board = await host.state('leaderboard');
  assert.deepEqual(board.standings.map((r: { name: string; score: number }) => [r.name, r.score]), [['Cat', 1000], ['Ann', 0], ['Bob', -100]]);
  for (const c of [host, tv, ann, bob, cat]) await c.close();
  await server.close();
});
