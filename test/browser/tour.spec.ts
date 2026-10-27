// The screen tour: a real browser plays the sample quiz (every question type, a wager round, a break) while
// watching the host screen on a laptop and on a phone, the TV and a team's phone. It visits the library, the
// editor, the branding panel and every pop-up on the way. Every screen state is screenshotted into
// test-results/tour/ (kept as a CI artifact), and the test fails if any page throws, logs an error, lets
// anything stick out sideways, pushes a main button off the screen, or if the quiz cannot be finished.
//
// The server runs as it does for a host: `node server/main.ts` on a throwaway library. The host screens are
// driven by the pages' own keyboard shortcuts and buttons; the quiz is moved along over a host WebSocket, with
// six simulated teams answering alongside the real team phone.
import { createHmac } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import WebSocket from 'ws';

const ROOT = join(import.meta.dirname, '..', '..');
const SHOTS = join(ROOT, 'test-results', 'tour');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A page under watch: its errors and its overflow, checked at every state. */
interface View {
  name: string;
  page: Page;
  errors: string[];
}

interface HostView {
  phase: string;
  onBreak?: boolean;
  question?: { type: string; index: number; lastInRound?: boolean; options?: string[] };
  reading?: { shown?: number };
  buzzers?: { status: string }[];
  standings?: { score: number }[];
}

// Browser noise that is not a defect: a missing favicon, and the socket closing when a page navigates away.
const IGNORED_CONSOLE = /favicon|WebSocket is closed|WebSocket connection to .* failed.*(going away|navigat)/i;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

/** Anything wider than the viewport that is not inside a horizontally scrolling box, and any main button off the screen. */
const PROBE = `(() => {
  const W = document.documentElement.clientWidth, sw = document.documentElement.scrollWidth, bad = [];
  if (sw > W + 1) {
    for (const e of document.querySelectorAll('body *')) {
      const r = e.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0 && r.right > W + 1) || bad.length >= 4) continue;
      let p = e, clipped = false;
      while ((p = p.parentElement) && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'hidden' || o === 'auto' || o === 'scroll' || o === 'clip') { clipped = true; break; } }
      if (!clipped) bad.push((e.tagName + '.' + (e.className || '')).slice(0, 60) + ' right=' + Math.round(r.right));
    }
  }
  const offscreen = [...document.querySelectorAll('button.primary, .phone-actions button')]
    .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.right > W + 1 || r.left < -1); })
    .map((b) => (b.textContent || '').trim().slice(0, 30));
  return { W, sw, bad, offscreen };
})()`;

test('a whole quiz on every screen: host on a laptop and a phone, the TV and a team phone', async ({ browser }, testInfo) => {
  const work = await mkdtemp(join(tmpdir(), 'pubquiz-tour-'));
  const library = join(work, 'library');
  await mkdir(join(library, 'tour-quiz'), { recursive: true });
  await cp(join(ROOT, 'examples', 'sample-quiz.yaml'), join(library, 'tour-quiz', 'quiz.yaml'));
  await cp(join(ROOT, 'examples', 'images'), join(library, 'tour-quiz', 'images'), { recursive: true });
  await mkdir(join(library, 'clips'));
  await writeFile(join(library, 'clips', 'ding.mp3'), Buffer.concat([Buffer.from('ID3\x04\0\0\0\0\0\0'), Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(64)]));
  await mkdir(SHOTS, { recursive: true });

  const port = await freePort();
  const base = `http://localhost:${port}`;
  const findings: string[] = [];
  const note = (what: string) => {
    findings.push(what);
    console.log(`!! ${what}`);
  };

  // The server, as a host would run it.
  const server = spawn(process.execPath, ['server/main.ts', '--quizzes', library, '-p', String(port), '--public-url', base, '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, PUBQUIZ_CONFIG_DIR: join(work, 'config') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const key = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the server did not start:\n${out}`)), 20_000);
    const look = (chunk: Buffer) => {
      out += chunk.toString();
      const m = /\/host#key=(\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    };
    server.stdout!.on('data', look);
    server.stderr!.on('data', look);
    server.on('exit', (code) => reject(new Error(`the server exited with ${code}:\n${out}`)));
  });
  server.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) note(`server stderr: ${text.slice(0, 300)}`);
  });
  const screenKey = createHmac('sha256', key).update('screen').digest('base64url').slice(0, 24);

  const views: View[] = [];
  const open = async (name: string, url: string, viewport: { width: number; height: number }, mobile: boolean): Promise<View> => {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const view: View = { name, page, errors: [] };
    page.on('pageerror', (error) => view.errors.push(`exception: ${error.message.split('\n')[0]}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !IGNORED_CONSOLE.test(msg.text())) view.errors.push(`console.error: ${msg.text().slice(0, 200)}`);
    });
    await page.goto(url);
    views.push(view);
    return view;
  };

  // Every screen state: errors, overflow, a screenshot.
  const seen = new Set<string>();
  let shotIndex = 0;
  const check = async (label: string, shots = true) => {
    const tag = `${String(shotIndex++).padStart(3, '0')}_${label}`;
    for (const v of views) {
      const p = (await v.page.evaluate(PROBE)) as { W: number; sw: number; bad: string[]; offscreen: string[] };
      if (p.sw > p.W + 1 || p.offscreen.length) note(`overflow on ${v.name} at ${label}: scrollWidth ${p.sw} > ${p.W}; ${p.bad.join(' | ')}${p.offscreen.length ? `; buttons off the screen: ${p.offscreen.join(', ')}` : ''}`);
      while (v.errors.length) note(`${v.name} at ${label}: ${v.errors.shift()}`);
      if (shots) await v.page.screenshot({ path: join(SHOTS, `${tag}__${v.name}.png`) });
    }
  };
  const pressEscape = async (hosts: View[], label: string) => {
    for (const v of hosts) {
      await v.page.keyboard.press('Escape');
      await sleep(300);
      if (await v.page.locator('.codes-overlay').count()) note(`Escape did not close the pop-up on ${v.name} at ${label}`);
    }
  };
  /** Clicks a visible button (or menu item) by its text, looking under the "⋯" menu when it is not on the screen itself. */
  const clickButton = async (v: View, text: string, { required = true } = {}): Promise<boolean> => {
    const visible = () => v.page.locator('button, [role="menuitem"]').filter({ hasText: text }).filter({ visible: true }).first();
    if (!(await visible().count())) {
      const more = v.page.getByRole('button', { name: 'More actions' }).filter({ visible: true }).first();
      if (await more.count()) {
        await more.click();
        await sleep(200);
      }
    }
    if (await visible().count()) {
      await visible().click();
      return true;
    }
    if (required) note(`no "${text}" button on ${v.name}`);
    return false;
  };

  // The host's own control connection and six simulated teams.
  const connect = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      w.on('open', () => resolve(w));
      w.on('error', reject);
    });
  const control = await connect();
  let view: HostView | undefined;
  control.on('message', (d) => {
    const m = JSON.parse(d.toString()) as { t: string; view?: HostView; message?: string };
    if (m.t === 'state' && m.view) view = m.view;
    if (m.t === 'error') note(`the server refused a host command: ${m.message}`);
  });
  const H = (m: object) => control.send(JSON.stringify(m));
  H({ t: 'host', key });
  const bots: WebSocket[] = [];
  const botAnswer = (q: NonNullable<HostView['question']>, i: number): unknown => {
    switch (q.type) {
      case 'multiple-choice': return i % (q.options?.length ?? 4);
      case 'ordering': return [[0, 1, 2, 3, 4], [1, 0, 2, 3, 4], [4, 3, 2, 1, 0]][i % 3];
      case 'letter': return 'ABCDEFGHIJ'[i];
      case 'number': case 'nearest': return 100 * (i + 1);
      case 'picture': case 'music': return ['Paris', 'Japan', 'Queen', 'Abba', 'Nope', 'France'][i];
      default: return null;
    }
  };

  const hostDesk = await open('host-laptop', `${base}/host#key=${key}`, { width: 1280, height: 800 }, false);
  const hostPhone = await open('host-phone', `${base}/host#key=${key}`, { width: 390, height: 844 }, true);
  const hosts = [hostDesk, hostPhone];
  const tv = await open('tv', `${base}/screen#key=${screenKey}`, { width: 1280, height: 720 }, false);
  const team = await open('team-phone', `${base}/`, { width: 390, height: 844 }, true);
  await sleep(2000);

  try {
    await test.step('the library, the editor, branding and the pop-ups', async () => {
      await check('library');
      for (const v of hosts) expect(await v.page.evaluate('location.href'), 'the key is taken out of the address bar').not.toContain('key=');
      for (const [label, hash] of [['branding', '#branding'], ['editor', '#edit/tour-quiz'], ['library-again', '']] as const) {
        for (const v of hosts) await v.page.evaluate((h) => (location.hash = h), hash);
        await sleep(1200);
        await check(label);
      }
      for (const [label, text] of [['settings', 'Settings'], ['clips', 'Clips'], ['host-qr', 'Phone host']] as const) {
        for (const v of hosts) await clickButton(v, text, { required: v === hostDesk }); // a phone has no "Phone host"
        await sleep(1000);
        await check(label);
        await pressEscape(hosts, label);
      }
    });

    await test.step('practice mode: a learner answers a question and sees the feedback', async () => {
      const practiceKey = createHmac('sha256', key).update('practice').digest('base64url').slice(0, 24);
      const learner = await open('learner-tablet', `${base}/practice#key=${practiceKey}`, { width: 820, height: 1180 }, true);
      await sleep(800);
      expect(await learner.page.evaluate('location.href'), 'the key is taken out of the address bar').not.toContain('key=');
      await check('practice-name');
      await learner.page.locator('input[name=learner]').fill('Tour Learner');
      await learner.page.locator('form').first().evaluate((f) => (f as HTMLFormElement).requestSubmit());
      await sleep(800);
      await check('practice-home');
      await learner.page.getByRole('button', { name: 'Practise' }).first().click();
      await sleep(300);
      await check('practice-options');
      await learner.page.getByRole('button', { name: 'Start ▶' }).click();
      await sleep(800);
      await check('practice-question');
      await learner.page.locator('.option').first().click();
      await sleep(600);
      await check('practice-feedback');
      await expect(learner.page.locator('.pr-feedback')).toBeVisible();
      await learner.page.getByRole('button', { name: '‹ Quizzes' }).click();
      await sleep(400);
      await learner.page.getByRole('button', { name: 'Finish now' }).click();
      await sleep(800);
      await check('practice-results');
      await expect(learner.page.locator('.pr-pct')).toBeVisible();
      await learner.page.context().close();
      views.splice(views.indexOf(learner), 1);
    });

    await test.step('teams join and are admitted', async () => {
      const res = await fetch(`${base}/api/quizzes/tour-quiz/run`, { method: 'POST', headers: { 'x-host-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ fresh: true }) });
      expect(res.status, 'the quiz starts').toBe(200);
      await sleep(1200);
      await team.page.goto(`${base}/`);
      await sleep(1200);
      await check('lobby-before-join');
      for (const name of ['Dragons', 'Wizards', 'Pirates', 'Robots', 'Ninjas', 'Pandas']) {
        const w = await connect();
        w.send(JSON.stringify({ t: 'join', name, phone: true })); // a bot has no browser; it says it is a phone, as the real team page does
        bots.push(w);
      }
      await team.page.locator('input').first().fill('Tour Team');
      await team.page.locator('form').first().evaluate((f) => (f as HTMLFormElement).requestSubmit());
      await sleep(1200);
      await check('team-waiting-to-be-admitted');
      H({ t: 'admit-all' });
      await sleep(1200);
      await check('lobby-admitted');
      for (const v of hosts) await clickButton(v, 'Head starts');
      await sleep(600);
      await check('head-starts');
      await pressEscape(hosts, 'head starts');
      for (const v of hosts) await v.page.evaluate(() => scrollTo(0, 0));
      // The phone's bottom bar: ☕ and ⋯ are sheets in the same place, so opening one must close the other, and a tap elsewhere closes both.
      const menus = () => hostPhone.page.locator('.break-menu').count();
      await hostPhone.page.getByRole('button', { name: 'Break' }).tap();
      await sleep(300);
      expect(await menus(), 'the Break sheet opens').toBe(1);
      await hostPhone.page.getByRole('button', { name: 'More actions' }).tap();
      await sleep(300);
      expect(await menus(), 'More replaces Break rather than stacking on it').toBe(1);
      await expect(hostPhone.page.getByRole('menuitem', { name: /Clips/ })).toBeVisible();
      await check('phone-more-menu');
      await hostPhone.page.touchscreen.tap(195, 300);
      await sleep(300);
      expect(await menus(), 'a tap elsewhere closes the sheet').toBe(0);
    });

    await test.step('the whole quiz', async () => {
      const teamAct = async (q: NonNullable<HostView['question']>, phase: string) => {
        const p = team.page;
        if (phase === 'wagering') {
          await p.locator('input').first().fill('200').catch(() => {});
          await p.getByRole('button', { name: /bet|wager|place/i }).first().click().catch(() => {});
          return;
        }
        if (phase !== 'open') return;
        const click = (selector: string) => p.locator(selector).first().click({ timeout: 1500 }).catch(() => {});
        if (q.type === 'multiple-choice') return click('.option');
        if (q.type === 'ordering') return p.getByRole('button', { name: /lock/i }).first().click({ timeout: 1500 }).catch(() => {});
        if (q.type === 'letter') return click('.keypad button');
        if (q.type === 'buzzer') return click('.buzz');
        const input = p.locator('input:not([type=file])').first();
        await input.fill(q.type === 'number' || q.type === 'nearest' ? '42' : 'Paris').catch(() => {});
        await p.locator('form').first().evaluate((f) => (f as HTMLFormElement).requestSubmit()).catch(() => {});
      };
      const observe = async () => {
        const q = view?.question;
        const state = `${view?.phase}${q ? `-${q.type}` : ''}${view?.onBreak ? '-break' : ''}`;
        const first = !seen.has(state);
        seen.add(state);
        await check(state, first);
      };

      let breakDone = false;
      let last = '';
      for (let guard = 0; view && view.phase !== 'finished'; guard++) {
        expect(guard, `the quiz could not be finished; stuck at ${last}`).toBeLessThan(400);
        const q = view.question;
        const sig = `${view.phase}|${q?.index}|${view.onBreak ? 'b' : ''}|${view.reading?.shown ?? ''}`;
        if (sig !== last) {
          last = sig;
          await sleep(500);
          await observe();
        }
        if (view.onBreak) {
          await sleep(600);
          H({ t: 'end-break' });
        } else if (view.phase === 'wagering') {
          for (const b of bots) b.send(JSON.stringify({ t: 'wager', amount: 200 }));
          await teamAct(q!, 'wagering');
          await sleep(600);
          H({ t: 'advance' });
        } else if (view.phase === 'reading') {
          // The host page's own shortcut: S starts the timer.
          await hostDesk.page.keyboard.press('s');
        } else if (view.phase === 'open' && q) {
          if (q.type === 'buzzer') {
            bots[0]!.send(JSON.stringify({ t: 'buzz' }));
            await sleep(800);
            await observe();
            await teamAct(q, 'open');
            await hostDesk.page.keyboard.press('y'); // Correct
          } else {
            bots.forEach((b, i) => {
              const a = botAnswer(q, i);
              if (a !== null) b.send(JSON.stringify({ t: 'answer', value: a }));
            });
            await teamAct(q, 'open');
            await sleep(1200);
            await observe();
            if (view.phase === 'open') await hostDesk.page.keyboard.press(' '); // Close the question
          }
        } else if (view.phase === 'leaderboard' && !breakDone && q?.lastInRound) {
          breakDone = true;
          H({ t: 'break', minutes: 5 });
          await sleep(1000);
          await observe();
        } else {
          await sleep(300);
          await hostPhone.page.keyboard.press(' '); // the phone moves it on too
        }
        await sleep(400);
      }
      await sleep(1500);
      await check('finished');
      expect(view?.phase).toBe('finished');
      for (const row of view?.standings ?? []) expect(Number.isFinite(row.score), 'every score is a number').toBe(true);
      await expect(team.page.getByText('Tour Team').first()).toBeVisible();
    });
  } finally {
    for (const w of [control, ...bots]) w.terminate();
    for (const v of views) await v.page.context().close();
    server.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      server.once('exit', () => resolve());
      setTimeout(resolve, 3000);
    });
    await rm(work, { recursive: true, force: true });
    testInfo.annotations.push({ type: 'screens', description: `${shotIndex} states, screenshots in ${SHOTS}` });
  }

  expect(findings, 'no page threw, logged an error, or let anything stick out sideways').toEqual([]);
});
