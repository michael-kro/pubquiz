// M7a: a QR code for joining the venue's Wi-Fi, beside the one for joining the quiz.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wifiQrText } from '../server/net.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { Client } from './client.ts';

test('the Wi-Fi QR text follows the format phones read, escaping the special characters', () => {
  assert.equal(wifiQrText('QuizNight', 'beer1234'), 'WIFI:T:WPA;S:QuizNight;P:beer1234;;');
  assert.equal(wifiQrText('Pub Guest'), 'WIFI:T:nopass;S:Pub Guest;;', 'an open network has no password');
  assert.equal(wifiQrText('Bar; "Quiz"', String.raw`p:a;s,s\w`), String.raw`WIFI:T:WPA;S:Bar\; \"Quiz\";P:p\:a\;s\,s\\w;;`);
});

const quiz = parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n');

test('the host and TV get the Wi-Fi details and its QR code; teams and strangers do not', async () => {
  const server = await createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', wifi: { ssid: 'QuizNight', password: 'beer1234' } });
  const base = `http://127.0.0.1:${server.port}`;
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  const tv = await Client.connect(server.port);
  tv.send({ t: 'screen', key: server.screenKey });
  const team = await Client.connect(server.port);
  team.send({ t: 'join', room: server.roomCode, name: 'Ann' });
  await team.waitFor((m) => m.t === 'joined');

  assert.deepEqual((await host.state('lobby')).wifi, { ssid: 'QuizNight', password: 'beer1234' });
  assert.deepEqual((await tv.state('lobby')).wifi, { ssid: 'QuizNight', password: 'beer1234' });
  assert.equal((await team.state('lobby')).wifi, undefined, "a team's phone is told nothing about it");

  for (const key of [server.hostKey, server.screenKey]) {
    const res = await fetch(`${base}/wifi-qr.svg?key=${key}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /<svg/);
  }
  assert.equal((await fetch(`${base}/wifi-qr.svg`)).status, 404, 'no key, no password');
  assert.equal((await fetch(`${base}/wifi-qr.svg?key=guess`)).status, 404);
  for (const c of [host, tv, team]) await c.close();
  await server.close();

  const none = await createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const plainHost = await Client.connect(none.port);
  plainHost.send({ t: 'host', key: none.hostKey });
  assert.equal((await plainHost.state('lobby')).wifi, undefined);
  assert.equal((await fetch(`http://127.0.0.1:${none.port}/wifi-qr.svg?key=${none.hostKey}`)).status, 404);
  await plainHost.close();
  await none.close();
});
