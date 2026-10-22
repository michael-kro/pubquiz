// Shut down from the host screen: everyone is told, then the program is asked to stop. Only the host may.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const quiz = parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n');

test('the host can shut the program down; a team cannot; every screen hears about it first', async () => {
  let asked = 0;
  const server = await createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, allowEmptyStart: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', onShutdown: () => asked++ });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  await host.state('lobby');
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  await tv.state('lobby');
  const team = await Client.connect(server.port);
  team.send({ t: 'join', room: server.roomCode, name: 'Stayers', phone: true });
  await team.waitFor((m) => m.t === 'joined');

  team.send({ t: 'shutdown' });
  assert.equal((await team.waitFor((m) => m.t === 'error')).message, 'Only the host can do that.');
  assert.equal(asked, 0);

  host.send({ t: 'shutdown' });
  await Promise.all([host, tv, team].map((c) => c.waitFor((m) => m.t === 'shutdown')));
  assert.equal(asked, 1, 'the program was asked to stop, once everyone had been told');

  for (const c of [host, tv, team]) await c.close();
  await server.close();
});
