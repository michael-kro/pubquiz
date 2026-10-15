// M3b: the quiz library and editor API, ending with the exit test: build a 3-round quiz,
// export it, re-import it and run it.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { Library } from '../server/library.ts';
import { createQuizServer, type QuizServer } from '../server/server.ts';
import { Client, type Message } from './client.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function setup(): Promise<{ server: QuizServer; library: Library; api: Api }> {
  const library = new Library(await mkdtemp(join(tmpdir(), 'pubquiz-library-')));
  const server = await createQuizServer({ closeEarly: true, lockOnStart: false, library, port: 0, bindHost: '127.0.0.1', publicHost: '127.0.0.1' });
  return { server, library, api: new Api(server) };
}

class Api {
  readonly base: string;
  readonly key: string;
  constructor(server: QuizServer) {
    this.base = `http://127.0.0.1:${server.port}/api`;
    this.key = server.hostKey;
  }

  async call(method: string, path: string, body?: unknown, raw?: Uint8Array): Promise<{ status: number; json: Message }> {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'x-host-key': this.key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: (raw as BodyInit | undefined) ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    return { status: res.status, json: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  }

  async bytes(path: string): Promise<Uint8Array> {
    const res = await fetch(`${this.base}${path}?key=${this.key}`);
    assert.equal(res.status, 200);
    return new Uint8Array(await res.arrayBuffer());
  }
}

test('the API needs the host key', async () => {
  const { server, api } = await setup();
  const res = await fetch(`${api.base}/quizzes`);
  assert.equal(res.status, 401);
  assert.equal((await fetch(`${api.base}/quizzes?key=wrong`)).status, 401);
  assert.equal((await api.call('GET', '/quizzes')).status, 200);
  await server.close();
});

test('create, save drafts with problems, duplicate and delete', async () => {
  const { server, library, api } = await setup();
  const { json: created } = await api.call('POST', '/quizzes');
  const { json: blank } = await api.call('GET', `/quizzes/${created.id}`);
  assert.equal(blank.draft.title, 'New quiz');
  assert.ok(blank.issues.length > 0, 'a blank question has problems to fix');
  assert.deepEqual(blank.issues[0].path.slice(0, 4), ['rounds', 0, 'questions', 0]);

  const draft = {
    title: 'Pub Night',
    rounds: [{ name: 'One', questions: [{ type: 'letter', text: 'Who sang Imagine?', answer: 'John Lennon' }] }],
  };
  const { json: saved } = await api.call('PUT', `/quizzes/${created.id}`, draft);
  assert.deepEqual(saved.issues, []);
  assert.match(await readFile(library.quizPath(created.id), 'utf8'), /answer: John Lennon/);

  const { json: list } = await api.call('GET', '/quizzes');
  assert.deepEqual(
    list.map((q: Message) => [q.title, q.rounds, q.questions, q.problems]),
    [['Pub Night', 1, 1, 0]],
  );

  const { json: copy } = await api.call('POST', `/quizzes/${created.id}/duplicate`);
  assert.equal((await api.call('GET', `/quizzes/${copy.id}`)).json.draft.title, 'Pub Night (copy)');
  assert.equal((await api.call('DELETE', `/quizzes/${copy.id}`)).status, 200);
  assert.equal((await api.call('GET', `/quizzes/${copy.id}`)).status, 404);
  assert.ok((await readdir(join(library.dir, '.trash'))).length === 1, 'deleted quizzes go to the trash');

  assert.equal((await api.call('GET', '/quizzes/..%2F..%2Fetc')).status, 404);
  assert.equal((await api.call('PUT', `/quizzes/${created.id}`, [1, 2])).status, 400);
  await server.close();
});

test('images: upload, served back to the editor, bad files refused', async () => {
  const { server, api } = await setup();
  const { json: created } = await api.call('POST', '/quizzes');
  const up = await api.call('POST', `/quizzes/${created.id}/images?name=${encodeURIComponent('My Photo.PNG')}`, undefined, PNG);
  assert.equal(up.status, 201);
  assert.equal(up.json.path, 'images/my-photo.png');
  const again = await api.call('POST', `/quizzes/${created.id}/images?name=my-photo.png`, undefined, PNG);
  assert.equal(again.json.path, 'images/my-photo-2.png', 'never overwrites');
  assert.deepEqual(Buffer.from(await api.bytes(`/quizzes/${created.id}/images/my-photo.png`)), PNG);
  assert.equal((await api.call('POST', `/quizzes/${created.id}/images?name=evil.html`, undefined, PNG)).status, 400);
  assert.equal((await api.call('GET', `/quizzes/${created.id}/images/..%2Fquiz.yaml`)).status, 404);
  await server.close();
});

test('importing zips is safe: only quiz.yaml and images are taken', async () => {
  const { server, library, api } = await setup();
  const zip = zipSync({
    'my quiz/quiz.yaml': strToU8('title: Zipped\nrounds:\n  - name: R\n    questions:\n      - { type: picture, text: Q, image: images/Pic.png, accept: [x] }\n'),
    'my quiz/images/Pic.png': PNG,
    'my quiz/../escape.txt': strToU8('nope'),
    'my quiz/notes.txt': strToU8('ignored'),
    '.hidden/quiz.yaml': strToU8('title: Hidden'),
  });
  const { status, json } = await api.call('POST', '/import?name=bundle.zip', undefined, zip);
  assert.equal(status, 201);
  assert.deepEqual(json.issues, []);
  assert.deepEqual((await readdir(join(library.dir, json.id))).sort(), ['images', 'quiz.yaml']);
  assert.deepEqual(await readdir(join(library.dir, json.id, 'images')), ['Pic.png']);
  assert.equal((await api.call('POST', '/import?name=x.zip', undefined, strToU8('not a zip'))).status, 400);
  assert.equal((await api.call('POST', '/import?name=x.docx', undefined, strToU8('x'))).status, 400);
  const noYaml = zipSync({ 'images/a.png': PNG });
  assert.match((await api.call('POST', '/import?name=x.zip', undefined, noYaml)).json.error, /quiz\.yaml/);
  await server.close();
});

test('exit test: build a 3-round quiz, export it, re-import it and run it', async () => {
  const { server, api } = await setup();
  const { json: created } = await api.call('POST', '/quizzes');
  const id = created.id;
  const image = (await api.call('POST', `/quizzes/${id}/images?name=flag.png`, undefined, PNG)).json.path;

  const draft = {
    title: 'Editor Built',
    scoring: { leaderboard: 'question' },
    rounds: [
      {
        name: 'Openers',
        questions: [
          { type: 'multiple-choice', text: 'Capital of Australia?', options: ['Sydney', 'Canberra'], answer: 1 },
          { type: 'letter', text: 'Who sang Imagine?', answer: 'John Lennon' },
        ],
      },
      { name: 'Pictures', questions: [{ type: 'picture', text: 'Which flag?', image, accept: ['Japan'] }] },
      {
        name: 'Order & Music',
        questions: [
          { type: 'ordering', text: 'Smallest first', items: ['1', '2', '3', '4', '5'] },
          { type: 'music', text: 'Name the band', accept: ['Queen'] },
        ],
      },
    ],
  };
  assert.deepEqual((await api.call('PUT', `/quizzes/${id}`, draft)).json.issues, []);

  // Export both ways, then bring the zip back in as a new quiz.
  const yaml = new TextDecoder().decode(await api.bytes(`/quizzes/${id}/export.yaml`));
  assert.match(yaml, /title: Editor Built/);
  const zip = await api.bytes(`/quizzes/${id}/export.zip`);
  assert.deepEqual(Object.keys(unzipSync(zip)).sort(), ['images/flag.png', 'quiz.yaml']);
  const { json: imported } = await api.call('POST', '/import?name=editor-built.zip', undefined, zip);
  assert.notEqual(imported.id, id);
  assert.deepEqual((await api.call('GET', `/quizzes/${imported.id}`)).json.draft, draft, 'round-trips exactly');

  // Run the imported copy and play it through.
  const host = await Client.connect(server.port);
  host.send({ t: 'host', key: server.hostKey });
  assert.equal((await host.waitFor((m) => m.t === 'state')).view.phase, 'idle');
  assert.equal((await api.call('POST', `/quizzes/${imported.id}/run`, {})).status, 200);
  const lobby = await host.state('lobby');
  assert.equal(lobby.quizTitle, 'Editor Built');
  assert.equal(lobby.canEnd, true);

  const team = await Client.connect(server.port);
  team.send({ t: 'join', room: server.roomCode, name: 'Testers' });
  await team.waitFor((m) => m.t === 'joined');
  const answers: ((q: Message) => unknown)[] = [
    () => 1,
    () => 'J',
    () => 'Japan',
    (q) => ['1', '2', '3', '4', '5'].map((item) => q.items.indexOf(item)),
    () => 'Queen',
  ];
  for (const [i, answer] of answers.entries()) {
    host.send({ t: 'advance' });
    const q = (await team.state('open', (v) => v.question.index === i)).question;
    if (i === 2) assert.match(q.image, /^\/media\/q3\.png$/);
    team.send({ t: 'answer', value: answer(q) });
    await host.state('closed', (v) => v.question.index === i);
    host.send({ t: 'advance' });
    assert.equal((await team.state('reveal', (v) => v.question.index === i)).result.correct, true, `question ${i + 1}`);
    host.send({ t: 'advance' });
    await host.state('leaderboard', (v) => v.question.index === i);
  }
  host.send({ t: 'advance' });
  const final = await host.state('finished');
  assert.ok(final.standings[0].score > 4000);

  // Back to the library: phones are told the quiz is over.
  host.send({ t: 'end-quiz' });
  await host.state('idle');
  await team.waitFor((m) => m.t === 'quiz-ended');
  for (const c of [host, team]) await c.close();
  await server.close();
});

test('a quiz with problems will not run, and the problems say where', async () => {
  const { server, api } = await setup();
  const { json: created } = await api.call('POST', '/quizzes');
  const run = await api.call('POST', `/quizzes/${created.id}/run`, {});
  assert.equal(run.status, 422);
  assert.match(run.json.issues[0], /^Round 1, question 1/);
  await server.close();
});

test('an unfinished library quiz resumes, or starts fresh on request', async () => {
  const { server, api } = await setup();
  const { json: created } = await api.call('POST', '/quizzes');
  await api.call('PUT', `/quizzes/${created.id}`, {
    title: 'Resumable',
    rounds: [{ name: 'R', questions: [1, 2].map((n) => ({ type: 'letter', text: `Q${n}`, answer: 'Abba' })) }],
  });
  await api.call('POST', `/quizzes/${created.id}/run`, {});
  const room = server.roomCode;
  server.game!.advance();
  await server.endQuiz();
  const { json: list } = await api.call('GET', '/quizzes');
  assert.deepEqual(list[0].unfinished, { question: 1, total: 2 });

  await api.call('POST', `/quizzes/${created.id}/run`, {});
  assert.equal(server.roomCode, room, 'same room code, so phones can rejoin');
  assert.equal(server.game!.phase, 'open');
  await api.call('POST', `/quizzes/${created.id}/run`, { fresh: true });
  assert.equal(server.game!.phase, 'lobby');
  await server.close();
});
