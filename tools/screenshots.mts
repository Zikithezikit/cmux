// @ts-nocheck
// Regenerates the README screenshots in docs/screenshots/ by driving the
// extension in Chromium with real websites in the panes.
//
//   make screenshots          (needs network access and Chromium; see tests/e2e/smoke.mjs)

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/screenshots');
const CONF = fs.readFileSync(path.join(ROOT, 'tests/fixtures/user.tmux.conf'), 'utf8');
const SIZE = { width: 1440, height: 820 };

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache/ms-playwright');
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => b.split('-')[1] - a.split('-')[1]) : [];
  for (const d of dirs) {
    const p = path.join(root, d, 'chrome-linux64/chrome');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chromium not found; set CHROME_PATH');
}

fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctmux-shots-'));
const ctx = await chromium.launchPersistentContext(tmp, {
  executablePath: findChromium(),
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  viewport: SIZE,
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`docs/screenshots/${name}.png`);
};

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;

  // Options page with the config loaded.
  const opts = await ctx.newPage();
  await opts.setViewportSize({ width: 1000, height: 1400 });
  await opts.goto(`chrome-extension://${id}/src/options/options.html`);
  await opts.fill('#text', CONF);
  await opts.click('#save-text');
  await pause(600);
  await opts.evaluate(() => { document.getElementById('status').textContent = ''; document.getElementById('text').scrollTop = 0; window.scrollTo(0, 0); });
  await shot(opts, 'options');
  await opts.close();

  const ws = await ctx.newPage();
  await ws.goto(`chrome-extension://${id}/src/workspace/workspace.html`);
  await ws.waitForSelector('#boot.done', { state: 'attached' });
  const run = (cmd) => ws.evaluate((c) => window.ctmux.t.runString(c), cmd);
  const key = async (...keys) => { for (const k of keys) { await ws.keyboard.press(k); await pause(120); } };

  // Sessions: "dev" (shown) plus two others for the session manager.
  await run('rename-session dev');
  await run('goto https://en.wikipedia.org/wiki/Tmux');
  await run('split-window -h https://news.ycombinator.com');
  await run('split-window -v https://github.com/tmux/tmux');
  await run('rename-window research');
  await run('new-window -d -n docs https://developer.chrome.com/docs/extensions');
  await run('new-window -d -n mail https://example.com');
  await run('new-session -d -s music https://example.org');
  await run('new-session -d -s notes https://example.net');
  await run('select-pane -t %1'); // pane ids: %1 Wikipedia, %2 Hacker News, %3 GitHub
  await pause(7000); // let the sites and the weather widget load
  await shot(ws, 'workspace');

  // Copy mode with a selection on the Wikipedia pane.
  // Headless input follows the last clicked frame, so click plain text first.
  await ws.mouse.click(160, 206);
  await key('Control+s', 'BracketLeft');
  await pause(300);
  await key('Slash');
  await ws.keyboard.type('open-source terminal');
  await key('Enter');
  await pause(200);
  await key('Space', 'e', 'e', 'e', 'e', 'e', 'e');
  await shot(ws, 'copy-mode');
  await key('q');

  // Session manager (prefix s).
  await key('Control+s', 's');
  await pause(300);
  await shot(ws, 'sessions');
  await key('q');

  // fzf-url picker on the Hacker News pane.
  await run('select-pane -t %2');
  await key('Control+s', 'u');
  await pause(600);
  await shot(ws, 'fzf-url');
  await key('Escape');

  // Debug panel: TPM plugins, with GitHub metadata fetched.
  await ws.evaluate(() => window.ctmux.t.plugins.fetchMetadata());
  await key('Control+s', 'Shift+Backquote', 'Tab');
  await pause(300);
  await shot(ws, 'plugins');
  await key('q');
} finally {
  await ctx.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
