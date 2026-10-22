// The `text` question type: teams type, the host marks after the question closes, then reveals.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const quiz = parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: text, text: "Capital of France?", accept: [Paris], seconds: 30 }\n');

test('a typed answer is matched for the host, who checks the list once the question has closed and can overrule it', async () => {
  const server = await createQuizServer({ closeEarly: false, lockOnStart: false, tvShowTeams: true, allowEmptyStart: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const teams: Record<string, Client> = {};
  for (const name of ['Ann', 'Bob', 'Cat', 'Dan']) {
    const c = await Client.connect(server.port);
    c.send({ t: 'join', room: server.roomCode, name, phone: true });
    await c.waitFor((m) => m.t === 'joined');
    teams[name] = c;
  }
  host.send({ t: 'advance' });
  const open = await teams['Ann']!.state('open');
  assert.equal(open.question.type, 'text');
  assert.equal(open.question.image, undefined);
  teams['Ann']!.send({ t: 'answer', value: 'PARIS' }); // capitals: exact
  teams['Bob']!.send({ t: 'answer', value: 'pariss' }); // a typo: close
  teams['Cat']!.send({ t: 'answer', value: 'Lyon' }); // wrong
  teams['Dan']!.send({ t: 'answer', value: '   ' }); // blank: refused, so Dan has no answer
  assert.match((await teams['Dan']!.waitFor((m) => m.t === 'error')).message, /Type an answer/);
  const during = await host.state('open', (v) => v.answeredCount === 3);
  assert.equal(during.review, undefined, 'nothing to mark while the question is open');
  const waiting = await teams['Ann']!.state('open');
  assert.equal(waiting.myAnswerText, 'PARIS', 'the team sees what it typed');

  host.send({ t: 'advance' }); // close: marking time
  const closed = await host.state('closed');
  const groups = closed.review.map((g: { text: string; correct: boolean; match: string; teams: string[] }) => [g.text, g.correct, g.match, g.teams]);
  assert.deepEqual(groups, [
    ['PARIS', true, 'exact', ['Ann']],
    ['pariss', true, 'close', ['Bob']],
    ['Lyon', false, 'none', ['Cat']],
  ]);
  const tvClient = await Client.connect(server.port);
  tvClient.send({ t: 'screen', key: server.screenKey });
  const tv = await tvClient.state('closed');
  assert.equal(tv.review, undefined, 'the TV never sees the answers');
  assert.equal(JSON.stringify(tv).includes('Paris'), false, 'nor the accepted answer, before the reveal');

  // The host decides Lyon deserves it after all, and that the typo does not.
  const lyon = closed.review.find((g: { text: string }) => g.text === 'Lyon');
  host.send({ t: 'mark', key: lyon.key, correct: true });
  const bobs = closed.review.find((g: { text: string }) => g.text === 'pariss');
  host.send({ t: 'mark', key: bobs.key, correct: false });
  await host.state('closed', (v) => v.review.find((g: { text: string }) => g.text === 'Lyon').correct === true && v.review.find((g: { text: string }) => g.text === 'pariss').correct === false);
  host.send({ t: 'advance' }); // reveal
  const reveal = await host.state('reveal');
  const scores = Object.fromEntries(reveal.teams.map((t: { name: string; score: number }) => [t.name, t.score]));
  assert.ok(scores['Ann'] > 0 && scores['Cat'] > 0, 'Ann and Cat score');
  assert.equal(scores['Bob'], 0);
  assert.equal(scores['Dan'], 0);
  assert.equal(reveal.question.answerText, 'Paris');
  const annReveal = await teams['Ann']!.state('reveal');
  assert.equal(annReveal.result.correct, true);
  for (const c of [host, tvClient, ...Object.values(teams)]) await c.close();
  await server.close();
});
