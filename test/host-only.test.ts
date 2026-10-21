// Every message the server accepts is either open to the people it is meant for, or host-only. This test makes
// adding a new message type a decision: it fails until the type is listed below, and every host-only type is
// then tried from a team, from the TV and from someone who has not signed in, and must be refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLIENT_MESSAGE_TYPES } from '../server/protocol.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

/** Messages that are not host-only: the ways in, and what a team does. */
const NOT_HOST_ONLY = ['host', 'screen', 'join', 'rejoin', 'answer', 'wager', 'buzz'];

/** One valid example of each host-only message. */
const HOST_ONLY_SAMPLES: Record<string, object> = {
  advance: {},
  pause: {},
  resume: {},
  extend: { seconds: 10 },
  skip: {},
  'end-round': {},
  leaderboard: {},
  break: { minutes: 5 },
  'end-break': {},
  'set-answer': { value: 1 },
  'tv-teams': { visible: false },
  'tv-questions': { visible: false },
  'head-start': { teamId: 'x', seconds: 5 },
  'show-join': { shown: true },
  'read-out': { on: true },
  'rotate-key': {},
  'lock-joining': { locked: true },
  'allow-empty-start': { on: true },
  'set-max-teams': { max: 3 },
  'play-clip': { name: 'a.mp3' },
  'stop-clips': {},
  admit: { teamId: 'x' },
  'admit-all': {},
  'set-entry-fee': { fee: '£5 per person' },
  'require-admission': { on: true },
  'set-prizes': { prizes: ['a', 'b', 'c'] },
  'lock-on-start': { on: true },
  'start-on-last': { on: true },
  'close-early': { on: true },
  'start-timer': {},
  judge: { correct: true },
  kick: { teamId: 'x' },
  mark: { key: 'x', correct: true },
  network: { action: 'use-lan' },
  'end-quiz': {},
  photos: { enabled: false },
  'remove-photo': { teamId: 'x' },
};

test('every message type is classified as host-only or open, so a new one cannot slip through unchecked', () => {
  const classified = new Set([...NOT_HOST_ONLY, ...Object.keys(HOST_ONLY_SAMPLES)]);
  const unclassified = CLIENT_MESSAGE_TYPES.filter((type) => !classified.has(type));
  assert.deepEqual(unclassified, [], `New message type(s) ${unclassified.join(', ')}: add them to NOT_HOST_ONLY or, if only the host may send them, to HOST_ONLY_SAMPLES in test/host-only.test.ts`);
  const stale = [...classified].filter((type) => !CLIENT_MESSAGE_TYPES.includes(type));
  assert.deepEqual(stale, [], `Listed here but no longer in the protocol: ${stale.join(', ')}`);
});

test('a team, the TV and a stranger are all refused every host-only message, and nothing changes', async () => {
  const quiz = parseQuiz('title: Guard\nrounds:\n  - name: R\n    questions:\n      - { type: multiple-choice, text: Q, options: [a, b], answer: 0 }\n');
  const server = await createQuizServer({ quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', allowEmptyStart: true, closeEarly: false, lockOnStart: false, tvShowTeams: true });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const team = await Client.connect(server.port);
  team.send({ t: 'join', name: 'Ann' });
  await team.waitFor((m) => m.t === 'joined');
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  const stranger = await Client.connect(server.port);

  const before = JSON.stringify((await host.state('lobby', (v) => v.teams.length === 1)).teams.map((t: { name: string }) => t.name));
  const keyBefore = server.hostKey;
  for (const [name, client] of [['team', team], ['tv', tv], ['stranger', stranger]] as const) {
    for (const [type, body] of Object.entries(HOST_ONLY_SAMPLES)) {
      client.send({ t: type, ...body });
    }
    // One more round trip so every message above has been handled before looking.
    client.send({ t: 'rejoin', token: 'nothing' });
    await client.waitFor((m) => m.t === 'rejoin-failed' || m.t === 'error', 3000).catch(() => undefined);
    void name;
  }
  await new Promise((r) => setTimeout(r, 300));
  // The host re-sends a setting it already has, which makes the server send everyone a fresh view to compare.
  host.send({ t: 'tv-questions', visible: true });
  const view = await host.state('lobby', () => true, 3000);
  assert.equal(JSON.stringify(view.teams.map((t: { name: string }) => t.name)), before, 'the teams are unchanged');
  assert.equal(view.phase, 'lobby', 'the quiz did not start');
  assert.equal(server.hostKey, keyBefore, 'the host key was not rotated');
  assert.equal(view.tvShowTeams, true);
  assert.equal(view.joiningLocked, false);
  assert.equal(view.showJoin, false);
  for (const c of [host, team, tv, stranger]) await c.close();
  await server.close();
});
