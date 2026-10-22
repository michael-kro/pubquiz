// Teams must join from a phone: a desktop browser is turned away unless the host has switched the rule off.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { Game } from '../server/game.ts';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer, looksLikePhone, type QuizServer } from '../server/server.ts';
import { Client } from './client.ts';

const quiz = parseQuiz('title: T\nrounds:\n  - name: R\n    questions:\n      - { type: letter, text: Q, answer: Abba }\n');
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const LAPTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const start = (extra: Parameters<typeof createQuizServer>[0] = {}): Promise<QuizServer> =>
  createQuizServer({ closeEarly: true, lockOnStart: false, tvShowTeams: true, allowEmptyStart: true, quiz, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1', ...extra });

async function tryJoin(server: QuizServer, name: string, userAgent: string, phone?: boolean) {
  const client = await Client.connect(server.port, { 'user-agent': userAgent });
  client.send({ t: 'join', room: server.roomCode, name, ...(phone === undefined ? {} : { phone }) });
  const reply = await client.waitFor((m) => m.t === 'joined' || m.t === 'error');
  return { client, reply };
}

test('looksLikePhone: phone and tablet browsers pass, desktop browsers do not, and a touch screen vouches for a tablet in desktop mode', () => {
  for (const ua of [PHONE, ANDROID, 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'Mozilla/5.0 (Linux; Android 13; SM-X700) Safari/537.36', 'Mozilla/5.0 (Linux; U; Android 4.4.3; KFTHWI Build/KTU84M) Silk/47.1']) {
    assert.ok(looksLikePhone(ua), ua);
  }
  for (const ua of [LAPTOP, WINDOWS, 'Mozilla/5.0 (X11; Linux x86_64) Firefox/125.0', '', 'curl/8.4.0']) assert.ok(!looksLikePhone(ua), ua || '(no user agent)');
  assert.ok(looksLikePhone(LAPTOP, true), 'an iPad asking for desktop sites says it is a Mac, but its page knows it has a touch screen');
  assert.ok(!looksLikePhone(LAPTOP, false));
});

test('with the rule on, a laptop is turned away with a message that says to use a phone; phones join', async () => {
  const server = await start();
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  host.send({ t: 'phones-only', on: true });
  await host.state('lobby', (v) => v.phonesOnly === true);

  const laptop = await tryJoin(server, 'Laptop Larks', LAPTOP);
  assert.equal(laptop.reply.t, 'error');
  assert.equal(laptop.reply.code, 'phones-only');
  assert.match(laptop.reply.message, /phone/i);
  const windows = await tryJoin(server, 'Desk Jockeys', WINDOWS, false);
  assert.equal(windows.reply.code, 'phones-only');
  const nothing = await tryJoin(server, 'Script Kiddies', '');
  assert.equal(nothing.reply.code, 'phones-only', 'a client with no browser at all is not a phone');

  const iphone = await tryJoin(server, 'iPhoners', PHONE);
  assert.equal(iphone.reply.t, 'joined');
  const android = await tryJoin(server, 'Androids', ANDROID, true);
  assert.equal(android.reply.t, 'joined');
  const ipad = await tryJoin(server, 'iPad Desktop Mode', LAPTOP, true);
  assert.equal(ipad.reply.t, 'joined', 'the page vouching for a touch screen is enough');

  const view = await host.state('lobby', (v) => v.teams.length === 3);
  assert.deepEqual(view.teams.map((t: { name: string }) => t.name).sort(), ['Androids', 'iPad Desktop Mode', 'iPhoners']);

  // The rule covers rejoining by code too: a team cannot carry on from a laptop.
  const code = view.teams.find((t: { name: string }) => t.name === 'iPhoners').code as string;
  const mover = await Client.connect(server.port, { 'user-agent': LAPTOP });
  mover.send({ t: 'rejoin', code });
  assert.equal((await mover.waitFor((m) => m.t === 'error' || m.t === 'rejoin-failed' || m.t === 'joined')).code, 'phones-only');
  const samePhone = await Client.connect(server.port, { 'user-agent': PHONE });
  samePhone.send({ t: 'rejoin', code });
  assert.equal((await samePhone.waitFor((m) => m.t === 'error' || m.t === 'rejoin-failed' || m.t === 'joined')).t, 'joined');

  for (const c of [laptop.client, windows.client, nothing.client, iphone.client, android.client, ipad.client, mover, samePhone, host]) await c.close();
  await server.close();
});

test('the host can switch the rule off, and only the host can', async () => {
  const server = await start();
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  host.send({ t: 'phones-only', on: true });
  await host.state('lobby', (v) => v.phonesOnly === true);

  const phone = await tryJoin(server, 'Phonies', PHONE);
  assert.equal(phone.reply.t, 'joined');
  phone.client.send({ t: 'phones-only', on: false });
  assert.equal((await phone.client.waitFor((m) => m.t === 'error')).message, 'Only the host can do that.');
  const stillOn = await host.state('lobby');
  assert.equal(stillOn.phonesOnly, true);

  host.send({ t: 'phones-only', on: false });
  await host.state('lobby', (v) => v.phonesOnly === false);
  const laptop = await tryJoin(server, 'Laptop Larks', LAPTOP);
  assert.equal(laptop.reply.t, 'joined', 'with the rule off, anything may join');

  for (const c of [phone.client, laptop.client, host]) await c.close();
  await server.close();
});

test('the setting is saved with the game and comes back on resume', () => {
  const game = new Game(quiz);
  assert.equal(game.phonesOnly, false, 'the tests run with the default off');
  game.setPhonesOnly(true);
  const restored = Game.restore(quiz, game.snapshot());
  assert.equal(restored.phonesOnly, true);
  assert.equal(restored.hostView().phonesOnly, true);
});

test('the rule is on by default for a real night (PUBQUIZ_PHONES_ONLY_DEFAULT unset)', () => {
  const env = { ...process.env };
  delete env['PUBQUIZ_PHONES_ONLY_DEFAULT'];
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', "import { Game } from './server/game.ts'; import { parseQuiz } from './server/quiz.ts'; console.log(new Game(parseQuiz('title: T\\nrounds:\\n  - name: R\\n    questions:\\n      - { type: letter, text: Q, answer: Abba }\\n')).phonesOnly);"], { env, encoding: 'utf8' });
  assert.equal(out.stdout.trim(), 'true', out.stderr);
});
