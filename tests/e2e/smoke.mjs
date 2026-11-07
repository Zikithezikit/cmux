// Browser smoke test: loads the unpacked extension into Chromium and drives
// the workspace with real key presses.
//
//   npm run e2e                       # uses CHROME_PATH or the newest Playwright Chromium
//   SCREENSHOTS=/tmp/shots npm run e2e
//
// Branded Google Chrome ignores --load-extension, so use Chromium.

import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = process.env.SCREENSHOTS || null;
const fixture = fs.readFileSync(path.join(EXT, 'tests/fixtures/user.tmux.conf'), 'utf8');

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache/ms-playwright')].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(root, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error('Chromium not found; set CHROME_PATH');
}

const page = (title, body) => `<!doctype html><title>${title}</title><body style="font:16px sans-serif;margin:20px"><h1>${title}</h1>${body}</body>`;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/deny')) {
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
    res.end(page('Denied page', '<p id=t>This page forbids framing.</p><p>Second line of text.</p><a href="https://example.com/a">Example A</a><p>See https://github.com/tmux/tmux too</p>'));
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('Plain page', '<p>hello world</p><input id=i>'));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctmux-e2e-'));
const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  executablePath: findChromium(),
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1280, height: 760 },
});

let failures = 0;
const errors = [];
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.log(`not ok - ${name}\n  ${String(err.message).split('\n').join('\n  ')}`);
  }
}
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  const url = (p) => `chrome-extension://${id}/src/${p}`;

  const open = async () => {
    const ws = await ctx.newPage();
    ws.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    ws.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
    await ws.goto(url('workspace/workspace.html'));
    await ws.waitForSelector('#boot.done', { state: 'attached' });
    return ws;
  };
  const state = (ws) => ws.evaluate(() => {
    window.ctmux.render();
    const t = window.ctmux.t;
    const w = t.server.window;
    return {
      session: t.server.session.name,
      windows: t.server.sortedWindows(t.server.session).map((x) => x.index),
      panes: Object.values(t.server.panes).map((p) => ({ id: p.id, kind: p.kind, url: p.url, mode: p.mode || null })),
      active: w.active, zoomed: w.zoomed, layout: w.layout, prefix: t.clientPrefix,
      buffers: t.buffers.map((b) => b.data), overlay: window.ctmux.overlays.active?.kind || null,
      notices: t.notices.filter((n) => n.level !== 'info').map((n) => n.message),
      width1: window.ctmux.view.rects[1]?.w,
    };
  });
  const prefix = async (ws, key, p = 'Control+b') => { await ws.keyboard.press(p); await ws.keyboard.press(key); await ws.waitForTimeout(150); };

  // --- defaults (no config) -------------------------------------------------
  const ws0 = await open();
  await step('boots with built-in defaults', async () => {
    const s = await state(ws0);
    assert.equal(s.session, '0');
    assert.deepEqual(s.windows, [0]);
    assert.equal(s.panes[0].kind, 'launcher');
    assert.match(await ws0.textContent('#status'), /\[0\] 0:new\*/);
  });
  await shot(ws0, 'defaults');
  await ws0.focus('.launcher input');
  await step('splits, display-panes, zoom, resize, kill', async () => {
    await prefix(ws0, 'Shift+Digit5');
    await prefix(ws0, 'Shift+Quote');
    let s = await state(ws0);
    assert.equal(s.panes.length, 3);
    assert.equal(s.active, 3);
    await ws0.evaluate(() => window.ctmux.t.runString('set -g display-panes-time 10000'));
    await prefix(ws0, 'q');
    assert.equal((await state(ws0)).overlay, 'display-panes');
    await shot(ws0, 'display-panes');
    await ws0.keyboard.press('0');
    await ws0.waitForTimeout(150);
    assert.equal((await state(ws0)).active, 1);
    await prefix(ws0, 'z');
    assert.equal((await state(ws0)).zoomed, true);
    await prefix(ws0, 'z');
    const w = (await state(ws0)).width1;
    await prefix(ws0, 'Alt+ArrowRight');
    await ws0.keyboard.press('Alt+ArrowRight'); // repeat without prefix
    await ws0.waitForTimeout(100);
    assert.ok((await state(ws0)).width1 > w + 40, 'M-Right grows the pane (repeatable)');
    const div = await (await ws0.$('.divider.h')).boundingBox();
    await ws0.mouse.move(div.x + 0.5, div.y + 50);
    await ws0.mouse.down();
    await ws0.mouse.move(div.x - 150, div.y + 50, { steps: 4 });
    await ws0.mouse.up();
    assert.ok(Math.abs((await state(ws0)).width1 - (div.x - 150)) < 4, 'border drag');
    await prefix(ws0, 'x');
    await ws0.keyboard.press('y');
    await ws0.waitForTimeout(100);
    s = await state(ws0);
    assert.equal(s.panes.length, 2);
  });
  await step('overlays: clock, list-keys, command prompt, rename-session', async () => {
    await prefix(ws0, 't');
    assert.equal((await state(ws0)).overlay, 'clock');
    await shot(ws0, 'clock');
    await ws0.keyboard.press('a');
    await prefix(ws0, 'Shift+Slash');
    assert.equal((await state(ws0)).overlay, 'list');
    await shot(ws0, 'list-keys');
    await ws0.keyboard.press('q');
    await prefix(ws0, 'Shift+Semicolon');
    await ws0.keyboard.type('new-w');
    await ws0.keyboard.press('Tab');
    assert.equal(await ws0.inputValue('#status input'), 'new-window ');
    await shot(ws0, 'prompt');
    await ws0.keyboard.press('Escape');
    await prefix(ws0, 'Shift+Digit4');
    await ws0.keyboard.press('Control+u');
    await ws0.keyboard.type('work');
    await ws0.keyboard.press('Enter');
    await ws0.waitForTimeout(100);
    assert.equal((await state(ws0)).session, 'work');
  });
  await ws0.close();

  // --- the real-world config ---------------------------------------------------
  const opts = await ctx.newPage();
  await opts.goto(url('options/options.html'));
  await opts.fill('#text', fixture);
  await opts.click('#save-text');
  await opts.waitForTimeout(400);
  await step('options page understands the config', async () => {
    assert.match(await opts.textContent('#report'), /Everything in the file was understood/);
    assert.equal((await opts.$$('#report td.ok')).length, 4, 'four emulated plugins');
  });
  await shot(opts, 'options');

  const ws = await open();
  await step('config applied with no warnings', async () => {
    const s = await state(ws);
    assert.deepEqual(s.notices, []);
    assert.deepEqual(s.windows, [1]);
  });
  await step('X-Frame-Options/CSP stripped inside the workspace', async () => {
    await ws.fill('.launcher input', `${base}/deny`);
    await ws.press('.launcher input', 'Enter');
    await ws.waitForTimeout(1200);
    const frame = ws.frames().find((f) => f.url().includes('/deny'));
    assert.ok(frame, 'frame exists');
    assert.equal(await frame.textContent('#t'), 'This page forbids framing.');
    const s = await state(ws);
    assert.equal(s.panes[0].url, `${base}/deny`);
  });
  await step('prefix keys work from inside a page', async () => {
    const frame = ws.frames().find((f) => f.url().includes('/deny'));
    await frame.click('h1');
    await ws.keyboard.press('Control+s');
    await ws.waitForTimeout(100);
    assert.equal((await state(ws)).prefix, true, 'prefix indicator');
    await ws.keyboard.press('Shift+Digit5');
    await ws.waitForTimeout(300);
    const s = await state(ws);
    assert.equal(s.layout.dir, 'h');
    assert.equal(s.active, 2);
  });
  await step('root bindings (vim-tmux-navigator C-h) from a page', async () => {
    await ws.fill('.pane[data-pane="2"] .launcher input', `${base}/plain`);
    await ws.press('.pane[data-pane="2"] .launcher input', 'Enter');
    await ws.waitForTimeout(1000);
    const plain = ws.frames().find((f) => f.url().includes('/plain'));
    await plain.click('h1');
    await ws.keyboard.press('Control+h');
    await ws.waitForTimeout(300);
    assert.equal((await state(ws)).active, 1);
  });
  await step('copy mode selects and yanks', async () => {
    await ws.keyboard.press('Control+s');
    await ws.keyboard.press('BracketLeft');
    await ws.waitForTimeout(300);
    assert.equal((await state(ws)).panes[0].mode, 'copy-mode');
    await ws.keyboard.press('j');
    await ws.keyboard.press('Space');
    await ws.keyboard.press('e');
    await ws.keyboard.press('e');
    await shot(ws, 'copy-mode');
    await ws.keyboard.press('Enter'); // y needs tmux-yank, which this config doesn't use
    await ws.waitForTimeout(300);
    const s = await state(ws);
    assert.equal(s.buffers[0], 'This page');
    assert.equal(s.panes[0].mode, null);
  });
  await step('copy mode search via the / prompt', async () => {
    await ws.keyboard.press('Control+s');
    await ws.keyboard.press('BracketLeft');
    await ws.waitForTimeout(200);
    await ws.keyboard.press('Slash');
    await ws.waitForTimeout(100);
    await ws.keyboard.type('Second');
    await ws.keyboard.press('Enter');
    await ws.waitForTimeout(200);
    await ws.keyboard.press('Space');
    await ws.keyboard.press('e');
    await ws.keyboard.press('Enter');
    await ws.waitForTimeout(300);
    assert.equal((await state(ws)).buffers[0], 'Second');
  });
  await step('fzf-url lists page links', async () => {
    await ws.keyboard.press('Control+s');
    await ws.keyboard.press('u');
    await ws.waitForTimeout(400);
    const rows = await ws.$$eval('.ov-body .row', (r) => r.map((x) => x.textContent));
    assert.deepEqual(rows.map((r) => r.split(' ')[0]), ['https://example.com/a', 'https://github.com/tmux/tmux']);
    await shot(ws, 'fzf-url');
    await ws.keyboard.press('Escape');
  });
  await step('windows, choose-tree and status line', async () => {
    await ws.keyboard.press('Control+s');
    await ws.keyboard.press('c');
    await ws.waitForTimeout(200);
    assert.deepEqual((await state(ws)).windows, [1, 2]);
    await ws.keyboard.press('Control+s');
    await ws.keyboard.press('Shift+H');
    await ws.waitForTimeout(200);
    assert.match(await ws.textContent('#status'), / 1 127\.0\.0\.1\* +2 new-/);
    await shot(ws, 'workspace');
    await ws.keyboard.press('Control+s');
    await ws.keyboard.press('w');
    await ws.waitForTimeout(200);
    await shot(ws, 'choose-tree');
    await ws.keyboard.press('j');
    await ws.keyboard.press('j');
    await ws.keyboard.press('Enter');
    await ws.waitForTimeout(200);
  });
  await step('debug panel', async () => {
    await ws.keyboard.press('Control+s');
    await ws.keyboard.press('Shift+Backquote');
    await ws.waitForTimeout(200);
    await ws.keyboard.press('Tab');
    await ws.waitForTimeout(100);
    assert.match(await ws.textContent('.debug'), /dracula\/tmux.*?emulated/);
    await shot(ws, 'debug');
    await ws.keyboard.press('q');
  });
  await step('state survives a reload', async () => {
    await ws.reload();
    await ws.waitForSelector('#boot.done', { state: 'attached' });
    await ws.waitForTimeout(300);
    const s = await state(ws);
    assert.deepEqual(s.windows, [1, 2]);
    assert.equal(s.panes.length, 3);
  });

  await step('session manager (prefix s): new, rename, switch, kill', async () => {
    const sessions = () => ws.evaluate(() => ({
      names: window.ctmux.t.server.sessions.map((x) => x.name).sort(),
      current: window.ctmux.t.server.session.name,
    }));
    await ws.keyboard.press('Control+s');
    await ws.keyboard.press('s');
    await ws.waitForTimeout(200);
    assert.equal((await state(ws)).overlay, 'list');
    assert.match(await ws.textContent('.ov-body'), /\(0\)\s+\+ 0: 2 windows \(attached\)\s+1:127\.0\.0\.1\*? 2:new\*?/);
    await ws.keyboard.press('n');
    await ws.waitForTimeout(100);
    await ws.keyboard.type('work');
    await ws.keyboard.press('Enter');
    await ws.waitForTimeout(200);
    assert.deepEqual(await sessions(), { names: ['0', 'work'], current: 'work' });
    assert.equal((await state(ws)).overlay, null, 'chooser closes after creating');
    await ws.keyboard.press('Control+s');
    await ws.keyboard.press('s');
    await ws.waitForTimeout(200);
    await shot(ws, 'sessions');
    await ws.keyboard.press('Shift+Digit4'); // $: rename the highlighted (current) session
    await ws.waitForTimeout(100);
    await ws.keyboard.press('Control+u');
    await ws.keyboard.type('mail');
    await ws.keyboard.press('Enter');
    await ws.waitForTimeout(200);
    assert.deepEqual((await sessions()).names, ['0', 'mail']);
    assert.match(await ws.textContent('.ov-body'), /\(1\)\s+\+ mail: 1 window \(attached\)/, 'chooser stays open and updates');
    await ws.keyboard.press('j'); // focus must be back on the list, not the filter
    await ws.keyboard.press('0'); // shortcut picks row (0)
    await ws.waitForTimeout(200);
    assert.equal((await sessions()).current, '0');
    await ws.keyboard.press('Control+s');
    await ws.keyboard.press('s');
    await ws.waitForTimeout(200);
    await ws.keyboard.press('j');
    await ws.keyboard.press('x');
    await ws.keyboard.press('y');
    await ws.waitForTimeout(200);
    assert.deepEqual((await sessions()).names, ['0']);
    await ws.keyboard.press('q');
    await ws.waitForTimeout(100);
    assert.equal((await state(ws)).overlay, null);
  });

  // --- config by path + source-file -------------------------------------------
  await step('config read from disk and re-sourced with prefix r', async () => {
    const file = path.join(tmp, 'tmux.conf');
    fs.writeFileSync(file, fixture);
    await opts.fill('#path', file);
    await opts.click('#path-form button');
    await opts.waitForTimeout(400);
    assert.match(await opts.textContent('#status'), /Loaded/);
    const w2 = await open();
    fs.appendFileSync(file, '\nset -g @e2e reloaded\n');
    await w2.keyboard.press('Control+s');
    await w2.keyboard.press('r');
    await w2.waitForTimeout(400);
    assert.equal(await w2.evaluate(() => window.ctmux.t.getOption('@e2e')), 'reloaded');
  });

  // --- marked panes, display-menu, display-popup ------------------------------
  await step('marked pane, pane menu (prefix >) and a URL popup', async () => {
    const w = await open();
    const panes = async () => (await state(w)).panes.length;
    await prefix(w, '%', 'Control+s');
    assert.equal(await panes(), 2);
    await prefix(w, 'm', 'Control+s');
    assert.equal(await w.locator('.pane.marked').count(), 1, 'prefix m marks the pane');
    await prefix(w, '>', 'Control+s'); // pane menu
    assert.equal((await state(w)).overlay, 'menu');
    const text = await w.textContent('.ov-menu');
    assert.match(text, /Horizontal Split/);
    assert.match(text, /Unmark/, 'menu items are formats: the pane is marked');
    await shot(w, 'menu');
    await w.keyboard.press('v');
    await w.waitForTimeout(200);
    assert.equal((await state(w)).overlay, null);
    assert.equal(await panes(), 3, 'menu shortcut ran split-window -v');
    await w.evaluate((u) => window.ctmux.t.runString(`display-popup -w 60% -h 50% -T docs ${u}/plain`), base);
    await w.waitForTimeout(400);
    assert.equal((await state(w)).overlay, 'popup');
    assert.equal(await w.getAttribute('.ov-popup iframe', 'src'), `${base}/plain`);
    await shot(w, 'popup');
    await w.evaluate(() => window.ctmux.t.runString('display-popup -C'));
    await w.waitForTimeout(100);
    assert.equal((await state(w)).overlay, null);
    await prefix(w, 'M', 'Control+s');
    assert.equal(await w.locator('.pane.marked').count(), 0, 'prefix M clears the mark');
    await w.close();
  });

  await step('no console errors', async () => {
    assert.deepEqual(errors.filter((e) => !/wttr\.in|ERR_INTERNET|net::/.test(e)), []);
  });
} finally {
  await ctx.close();
  server.close();
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
