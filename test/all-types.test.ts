// M1b exit test: a quiz with one question of each type runs end to end over WebSockets,
// and the host overrides an auto-marked typed answer.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadQuizFile } from '../server/quiz.ts';
import { createQuizServer, type QuizServer } from '../server/server.ts';
import { Client, type Message } from './client.ts';

let server: QuizServer;

before(async () => {
  const quiz = await loadQuizFile(fileURLToPath(new URL('fixtures/all-types.yaml', import.meta.url)));
  server = await createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, allowEmptyStart: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
});

after(async () => {
  await server.close();
});

test('serves quiz images with a locked-down content policy', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/media/q2.svg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/media/missing.png`)).status, 404);
});

test('one question of each type, with a host override', async () => {
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const lobby = await host.state('lobby');
  assert.equal(lobby.preloadImage, '/media/q1.svg', 'first image is preloaded in the lobby');

  const teams: Client[] = [];
  for (const name of ['Ann', 'Bob']) {
    const c = await Client.connect(server.port);
    c.send({ t: 'join', room: server.roomCode, name });
    await c.waitFor((m) => m.t === 'joined');
    teams.push(c);
  }
  const [ann, bob] = teams as [Client, Client];

  const play = async (annAnswer: (q: Message) => unknown, bobAnswer: (q: Message) => unknown) => {
    host.send({ t: 'advance' });
    const q = (await ann.state('open')).question;
    await bob.state('open');
    ann.send({ t: 'answer', value: annAnswer(q) });
    bob.send({ t: 'answer', value: bobAnswer(q) });
    return { q, closed: await host.state('closed') };
  };
  const reveal = async () => {
    host.send({ t: 'advance' });
    const results = [(await ann.state('reveal')).result, (await bob.state('reveal')).result];
    host.send({ t: 'advance' });
    await host.state('leaderboard');
    return results;
  };

  // Multiple choice with an image.
  const { q: mc } = await play(
    () => 1,
    () => 0,
  );
  assert.equal(mc.image, '/media/q1.svg');
  let [a, b] = await reveal();
  assert.equal(a.correct, true);
  assert.equal(b.correct, false);

  // Picture: Bob's typo is auto-accepted as close, then the host rules it out.
  const marking = await play(
    () => 'japan',
    () => 'Japn',
  );
  assert.deepEqual(
    marking.closed.review.map((g: Message) => [g.text, g.match, g.correct]),
    [
      ['japan', 'exact', true],
      ['Japn', 'close', true],
    ],
  );
  host.send({ t: 'mark', key: 'japn', correct: false });
  await host.waitFor((m) => m.t === 'state' && m.view.review?.[1]?.correct === false);
  ann.send({ t: 'mark', key: 'japan', correct: false });
  assert.match((await ann.waitFor((m) => m.t === 'error')).message, /Only the host/);
  [a, b] = await reveal();
  assert.equal(a.correct, true);
  assert.equal(b.correct, false);

  // Ordering: Ann gets it right, Bob swaps the last two.
  const inOrder = (q: Message, order: string[]) => order.map((item) => q.items.indexOf(item));
  await play(
    (q) => inOrder(q, ['1', '2', '3', '4', '5']),
    (q) => inOrder(q, ['1', '2', '3', '5', '4']),
  );
  [a, b] = await reveal();
  assert.equal(a.correct, true);
  assert.equal(b.detail, '3 of 5 in the right place');

  // Music.
  await play(
    () => 'Queen',
    () => 'ABBA',
  );
  [a, b] = await reveal();
  assert.equal(a.points, 1000, 'no speed bonus for music');
  assert.equal(b.points, 0);

  // Letter.
  const letters = await play(
    () => 'j',
    () => 'P',
  );
  assert.equal(letters.closed.summary, 'J ×1   P ×1');
  [a, b] = await reveal();
  assert.equal(a.correct, true);
  assert.equal(a.answerText, 'J: John Lennon');
  assert.equal(b.correct, false);

  host.send({ t: 'advance' });
  const final = await ann.state('finished');
  assert.deepEqual(
    final.standings.map((r: Message) => r.name),
    ['Ann', 'Bob'],
  );
  for (const c of [host, ann, bob]) await c.close();
});
