// HTTP API for the host's quiz library and editor. Every route needs the host key.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Library, LibraryError, MAX_IMAGE_UPLOAD, MAX_IMPORT, type QuizDraft } from './library.ts';

export interface ApiContext {
  library: Library;
  isHost(key: string | undefined): boolean;
  /** Starts a library quiz; returns problems that stop it running, if any. */
  runQuiz(id: string, fresh: boolean): Promise<{ ok: true } | { ok: false; issues: string[] }>;
}

const MAX_JSON = 2 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new LibraryError('That file is too big.', 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new LibraryError('That file is too big.', 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req, MAX_JSON);
  try {
    return body.length ? JSON.parse(body.toString('utf8')) : {};
  } catch {
    throw new LibraryError('Expected JSON.');
  }
}

/** Handles /api/… requests. Returns false if the path isn't an API route. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ApiContext): Promise<boolean> {
  if (!url.pathname.startsWith('/api/')) return false;
  const key = (req.headers['x-host-key'] as string | undefined) ?? url.searchParams.get('key') ?? undefined;
  if (!ctx.isHost(key)) {
    sendJson(res, 401, { error: 'Use the host link printed when the quiz program started.' });
    return true;
  }

  const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
  const method = req.method ?? 'GET';
  const { library } = ctx;

  try {
    // /api/quizzes
    if (parts[0] === 'quizzes' && parts.length === 1) {
      if (method === 'GET') return void sendJson(res, 200, await library.list()), true;
      if (method === 'POST') return void sendJson(res, 201, { id: await library.create() }), true;
    }

    // /api/import?name=quiz.zip
    if (parts[0] === 'import' && parts.length === 1 && method === 'POST') {
      const result = await library.importFile(url.searchParams.get('name') ?? '', await readBody(req, MAX_IMPORT));
      return void sendJson(res, 201, result), true;
    }

    if (parts[0] === 'quizzes' && parts[1]) {
      const id = parts[1];
      const action = parts[2];

      if (!action) {
        if (method === 'GET') return void sendJson(res, 200, await library.read(id)), true;
        if (method === 'PUT') return void sendJson(res, 200, { issues: await library.save(id, (await readJson(req)) as QuizDraft) }), true;
        if (method === 'DELETE') {
          await library.remove(id);
          return void sendJson(res, 200, { ok: true }), true;
        }
      }

      if (action === 'duplicate' && method === 'POST') {
        return void sendJson(res, 201, { id: await library.duplicate(id) }), true;
      }

      if (action === 'images' && parts.length === 3 && method === 'POST') {
        const path = await library.addImage(id, url.searchParams.get('name') ?? '', await readBody(req, MAX_IMAGE_UPLOAD));
        return void sendJson(res, 201, { path }), true;
      }

      if (action === 'images' && parts[3] && method === 'GET') {
        const image = await library.image(id, parts[3]);
        res.writeHead(200, {
          'content-type': image.contentType,
          'cache-control': 'private, max-age=3600',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          'x-content-type-options': 'nosniff',
        });
        res.end(image.data);
        return true;
      }

      if (action === 'export.yaml' && method === 'GET') {
        res.writeHead(200, {
          'content-type': 'application/yaml; charset=utf-8',
          'content-disposition': `attachment; filename="${id}.yaml"`,
        });
        res.end(await library.exportYaml(id));
        return true;
      }

      if (action === 'export.zip' && method === 'GET') {
        const zip = await library.exportZip(id);
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${id}.zip"` });
        res.end(zip);
        return true;
      }

      if (action === 'run' && method === 'POST') {
        const body = (await readJson(req)) as { fresh?: unknown };
        const result = await ctx.runQuiz(id, body.fresh === true);
        return void sendJson(res, result.ok ? 200 : 422, result), true;
      }
    }

    sendJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (error instanceof LibraryError) sendJson(res, error.status, { error: error.message });
    else {
      console.error(error);
      sendJson(res, 500, { error: 'Something went wrong.' });
    }
  }
  return true;
}
