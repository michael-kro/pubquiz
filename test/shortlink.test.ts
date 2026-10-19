// Short links: only keyless addresses are sent to the shortener, and any failure leaves the full address in use.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuiz } from '../server/quiz.ts';
import { createQuizServer } from '../server/server.ts';
import { shorten, shortLinksFor } from '../server/shortlink.ts';
import { Client } from './client.ts';

const reply = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

test('shorten returns the is.gd address, and nothing for errors, odd replies or network failures', async () => {
  assert.equal(await shorten('https://x.trycloudflare.com/', reply({ shorturl: 'https://is.gd/R709K6' })), 'https://is.gd/R709K6');
  assert.equal(await shorten('https://x', reply({ errorcode: 3, errormessage: 'rate limit' })), undefined);
  assert.equal(await shorten('https://x', reply({ shorturl: 'https://evil.example/abc' })), undefined, 'only is.gd addresses are trusted');
  assert.equal(await shorten('https://x', (async () => { throw new Error('offline'); }) as unknown as typeof fetch), undefined);
});

test('the TV page is only shortened when it needs no key, and the host link is never sent', async () => {
  const sent: string[] = [];
  const fake = (async (input: string) => {
    sent.push(decodeURIComponent(String(input).split('url=')[1] ?? ''));
    return new Response(JSON.stringify({ shorturl: `https://is.gd/a${sent.length}` }));
  }) as unknown as typeof fetch;
  const keyed = await shortLinksFor('https://x.trycloudflare.com', false, fake);
  assert.deepEqual(sent, ['https://x.trycloudflare.com/']);
  assert.deepEqual(keyed, { join: 'https://is.gd/a1' });
  sent.length = 0;
  const open = await shortLinksFor('https://x.trycloudflare.com', true, fake);
  assert.deepEqual(sent.sort(), ['https://x.trycloudflare.com/', 'https://x.trycloudflare.com/screen']);
  assert.ok(open.join && open.tv);
  assert.ok(sent.every((u) => !u.includes('key=') && !u.includes('/host')));
});

test('the host and TV views carry the short links once set, and drop them again', async () => {
  const server = await createQuizServer({ quiz: parseQuiz('title: S\nrounds:\n  - name: R\n    questions:\n      - { type: multiple-choice, text: Q, options: [a, b], answer: 0 }\n'), port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  assert.equal((await host.state('lobby')).shortLinks, undefined);
  server.setShortLinks({ join: 'https://is.gd/abc12' });
  assert.deepEqual((await host.state('lobby', (v) => v.shortLinks)).shortLinks, { join: 'https://is.gd/abc12' });
  server.setShortLinks(undefined);
  assert.equal((await host.state('lobby', (v) => !v.shortLinks)).shortLinks, undefined);
  await host.close();
  await server.close();
});
