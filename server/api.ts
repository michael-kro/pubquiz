// HTTP API for the host's quiz library and editor. Every route needs the host key.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bundledBankFiles, sampleQuizFiles } from './assets.ts';
import { buildEntries, filterEntries, sample, summarise, type BankEntry } from './bank.ts';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrandingError, MAX_LOGO_BYTES, type BrandingStore } from './branding.ts';
import { Library, LibraryError, MAX_IMAGE_UPLOAD, MAX_IMPORT, type QuizDraft } from './library.ts';

export interface ApiContext {
  library: Library;
  branding?: BrandingStore;
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

    if (parts[0] === 'bank' && method === 'GET') {
      const entries = await bankEntries(library.dir);
      const q = url.searchParams;
      const matches = filterEntries(entries, {
        category: q.get('category') ?? undefined,
        type: q.get('type') ?? undefined,
        difficulty: q.get('difficulty') ?? undefined,
        region: q.get('region') ?? undefined,
        source: q.get('source') ?? undefined,
        search: q.get('search') ?? undefined,
      });
      if (parts[1] === 'summary') return void sendJson(res, 200, summarise(entries)), true;
      const limit = Math.min(Math.max(Number(q.get('limit') ?? 50) || 50, 1), 200);
      const picked = parts[1] === 'random' ? sample(matches, limit) : matches.slice(Math.max(Number(q.get('offset') ?? 0) || 0, 0), Math.max(Number(q.get('offset') ?? 0) || 0, 0) + limit);
      return void sendJson(res, 200, { total: matches.length, questions: picked }), true;
    }

    if (parts[0] === 'branding' && ctx.branding) {
      const branding = ctx.branding;
      if (parts.length === 1 && method === 'GET') {
        return void sendJson(res, 200, { ...(await branding.info()), editable: branding.editable }), true;
      }
      if (parts.length === 1 && method === 'PUT') {
        await branding.save(await readJson(req));
        return void sendJson(res, 200, { ...(await branding.info()), editable: branding.editable }), true;
      }
      if (parts[1] === 'logo' && method === 'POST') {
        await branding.setLogo(url.searchParams.get('name') ?? '', await readBody(req, MAX_LOGO_BYTES));
        return void sendJson(res, 200, { ...(await branding.info()), editable: branding.editable }), true;
      }
      if (parts[1] === 'logo' && method === 'DELETE') {
        await branding.removeLogo();
        return void sendJson(res, 200, { ...(await branding.info()), editable: branding.editable }), true;
      }
    }

    if (parts[0] === 'sample' && parts.length === 1 && method === 'POST') {
      return void sendJson(res, 201, { id: await library.addSample(await sampleQuizFiles()) }), true;
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
    if (error instanceof LibraryError || error instanceof BrandingError) sendJson(res, error.status, { error: error.message });
    else {
      console.error(error);
      sendJson(res, 500, { error: 'Something went wrong.' });
    }
  }
  return true;
}

// The question bank: the built-in files plus anything in a "bank" folder inside the quiz library.
let bankCache: { at: number; dir: string; entries: BankEntry[] } | undefined;

async function bankEntries(libraryDir: string): Promise<BankEntry[]> {
  if (bankCache && bankCache.dir === libraryDir && Date.now() - bankCache.at < 10_000) return bankCache.entries;
  const mine = new Map<string, string>();
  const dir = join(libraryDir, 'bank');
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (/\.ya?ml$/i.test(name)) mine.set(name, await readFile(join(dir, name), 'utf8'));
  }
  const entries = [...buildEntries(await bundledBankFiles(), 'built-in').entries, ...buildEntries(mine, 'mine').entries];
  bankCache = { at: Date.now(), dir: libraryDir, entries };
  return entries;
}
