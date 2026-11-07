import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Tmux } from '../src/core/tmux.js';
import { Tpm, memoryStorage, parsePluginSpec } from '../src/tpm/tpm.js';
import { panesInOrder } from '../src/core/layout.js';
import type { Server } from '../src/core/server.js';
import type { KeyValueStorage, Notice, Pane, SplitNode, Ui, Window as TmuxWindow } from '../src/core/types.js';

/** A stub UI: records messages; any method it doesn't define is a no-op. */
type StubUi = Ui & { messages: string[] };
type StubOverrides = { [K in keyof Ui]?: (...args: never[]) => unknown };

/** The engine as these tests use it (fields Tmux and Server set up in their constructors). */
type Engine = Tmux & {
  server: Server & { panes: Record<number, Pane> };
  notices: Notice[];
  handleKey(ev: { table: string; key: string; prefix?: boolean }): Promise<unknown>;
};

interface BootOptions {
  ui?: StubUi;
  storage?: KeyValueStorage;
  fetchImpl?: (url: string) => Promise<unknown>;
}

const fixture = readFileSync(new URL('./fixtures/user.tmux.conf', import.meta.url), 'utf8');
const timers = { setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout };

function stubUi(extra: StubOverrides = {}) {
  const messages: string[] = [];
  const ui = {
    messages,
    geometry: () => ({ rect: { x: 0, y: 0, w: 1600, h: 900 }, gap: 1, cell: { w: 8, h: 20 } }),
    message: (m: string) => messages.push(m),
    prompt: async () => null,
    confirm: async () => true,
    ...extra,
  };
  return new Proxy(ui, { get: (o, p) => (p in o ? o[p as keyof typeof o] : () => {}) }) as unknown as StubUi;
}

async function boot(conf: string, { ui = stubUi(), storage = memoryStorage(), fetchImpl }: BootOptions = {}) {
  const t = new Tmux({ ui }) as Engine;
  const tpm = new Tpm(t, { storage, timers, fetchImpl: fetchImpl || (async () => ({ ok: true, text: async () => 'Sunny +21°C' })) });
  await t.loadDefaults();
  if (conf) await t.runConfig(conf, { source: 'test.conf' });
  tpm.finish();
  t.server.newSession({});
  return { t, tpm, ui };
}

test('defaults load without notices', async () => {
  const { t } = await boot('');
  assert.deepEqual(t.notices, []);
  assert.equal(t.getOption('prefix'), 'C-b');
  assert.ok(t.lookupKey('prefix', '%'));
  assert.ok(t.lookupKey('copy-mode-vi', 'j'));
});

test("the user's real ~/.tmux.conf", async () => {
  const { t, tpm } = await boot(fixture);
  assert.equal(t.getOption('prefix'), 'C-s');
  assert.equal(t.getOption('mouse'), 'on');
  assert.equal(t.getOption('mode-keys'), 'vi');
  assert.equal(t.getOption('base-index'), '1');
  assert.equal(t.getOption('status-position'), 'top');
  assert.deepEqual(t.lookupKey('prefix', 'r')!.commands, [['source-file', '~/.tmux.conf']]);
  assert.deepEqual(t.lookupKey('prefix', '"')!.commands, [['split-window', '-v', '-c', '#{pane_current_path}']]);
  assert.deepEqual(t.lookupKey('prefix', 'H')!.commands, [['previous-window']]);
  assert.deepEqual(t.lookupKey('root', 'C-l')!.commands, [['select-pane', '-R']]);
  assert.ok(t.lookupKey('root', 'C-\\'), 'C-\\ binding survives the odd quoting');
  assert.ok(t.lookupKey('prefix', 'u'), 'fzf-url binding');
  assert.ok(t.lookupKey('prefix', 'I'), 'tpm install binding');
  const report = Object.fromEntries(tpm.report().map((r) => [r.repo, r.status]));
  assert.deepEqual(report, {
    'christoomey/vim-tmux-navigator': 'emulated', 'tmux-plugins/tpm': 'emulated',
    'dracula/tmux': 'emulated', 'wfxr/tmux-fzf-url': 'emulated',
  });
  assert.deepEqual(tpm.unclaimedOptions(), ['@tmux-weather-units']);
  const errors = t.notices.filter((n) => n.level === 'error');
  assert.deepEqual(errors, []);
  // Dracula powerline status
  const left = t.expand(t.getOption('status-left'));
  assert.match(left, /#\[bg=#50fa7b,fg=#282a36\] 0 /);
  assert.ok(t.getOption('status-right').includes('#{dracula_weather}'));
  assert.equal(t.server.session!.windows[0].index, 1, 'base-index 1');
});

test('keys drive splits, navigation, windows, zoom and kill', async () => {
  const { t } = await boot(fixture);
  const srv = t.server;
  await t.handleKey({ table: 'prefix', key: '%' });
  await t.handleKey({ table: 'prefix', key: '"' });
  let w = srv.window!;
  assert.deepEqual(panesInOrder(w.layout).length, 3);
  assert.equal((w.layout as SplitNode).dir, 'h');
  const third = w.active;
  await t.handleKey({ table: 'root', key: 'C-h' });
  assert.equal(w.active, panesInOrder(w.layout)[0]);
  await t.handleKey({ table: 'root', key: 'C-\\' });
  assert.equal(w.active, third, 'select-pane -l');
  await t.handleKey({ table: 'prefix', key: 'z' });
  assert.equal(w.zoomed, true);
  await t.handleKey({ table: 'prefix', key: 'c' });
  assert.equal(srv.session!.windows.length, 2);
  assert.equal(srv.window!.index, 2);
  await t.handleKey({ table: 'prefix', key: 'H' });
  assert.equal(srv.window!.index, 1);
  await t.handleKey({ table: 'prefix', key: 'x' }); // confirm-before -> stub confirms
  w = srv.window!;
  assert.equal(panesInOrder(w.layout).length, 2);
  await t.runString('kill-window -t :1');
  assert.equal(srv.session!.windows.length, 1);
  assert.equal(srv.session!.windows[0].index, 1, 'renumber-windows on');
});

test('command prompt templates and targets', async () => {
  const answers = [['github.com']];
  const ui = stubUi({ prompt: async () => answers.shift() });
  const { t } = await boot('', { ui });
  const srv = t.server;
  await t.handleKey({ table: 'prefix', key: 'g' });
  assert.equal(srv.pane!.kind, 'web');
  assert.equal(srv.pane!.url, 'https://github.com');
  await t.runString('rename-window web ; new-window -n docs https://developer.chrome.com');
  assert.equal(srv.window!.name, 'docs');
  assert.equal(srv.pane!.url, 'https://developer.chrome.com');
  await t.runString('select-window -t web');
  assert.equal(srv.windowName(srv.window!), 'web');
  await t.runString('swap-window -s :0 -t :1');
  assert.deepEqual(srv.sortedWindows(srv.session!).map((w: TmuxWindow) => w.name), ['docs', 'web']);
  await t.runString('new-session -d -s work');
  assert.equal(srv.session!.name, '0');
  await t.runString('switch-client -n');
  assert.equal(srv.session!.name, 'work');
  await t.runString('display-message "#S:#I"');
  assert.equal(ui.messages.at(-1), 'work:0');
});

test('%if / %elif / %else and if-shell -F', async () => {
  const { t } = await boot(`
%if "#{==:#{version},3.4}"
set -g @a yes
%elif 1
set -g @a elif
%else
set -g @a no
%endif
%if 0
set -g @b 1
%elif 1
set -g @b 2
%endif
if -F '#{==:a,a}' 'set -g @c on' 'set -g @c off'
if-shell 'test -n "$TMUX"' 'set -g @d on' 'set -g @d off'
set -g status-bg red
`);
  assert.equal(t.getOption('@a'), 'yes');
  assert.equal(t.getOption('@b'), '2');
  assert.equal(t.getOption('@c'), 'on');
  assert.equal(t.getOption('@d'), 'on', '$TMUX is set, like inside real tmux');
  assert.match(t.getOption('status-style'), /bg=red/);
});

test('unknown options and plugins are reported', async () => {
  const { t, tpm } = await boot(`
set -g @plugin 'someone/tmux-mystery'
set -g @mystery-colour blue
set -g not-a-real-option 1
`);
  assert.ok(t.notices.some((n) => /unknown option: not-a-real-option/.test(n.message)));
  assert.ok(t.notices.some((n) => /unknown plugin someone\/tmux-mystery/.test(n.message) && /@mystery-colour/.test(n.message)));
  assert.equal(tpm.report()[0].status, 'unknown');
});

test('plugin spec parsing', () => {
  assert.equal(parsePluginSpec('tmux-plugins/tmux-sensible')!.repo, 'tmux-plugins/tmux-sensible');
  assert.equal(parsePluginSpec('https://github.com/dracula/tmux.git')!.repo, 'dracula/tmux');
  assert.equal(parsePluginSpec('git@github.com:catppuccin/tmux.git#v2.1.0')!.branch, 'v2.1.0');
});

test('resurrect saves and restores layouts and URLs', async () => {
  const storage = memoryStorage();
  const conf = "set -g @plugin 'tmux-plugins/tmux-resurrect'\nset -g @plugin 'tmux-plugins/tmux-continuum'\nset -g @continuum-restore 'on'";
  const a = await boot(conf, { storage });
  await a.t.runString('goto https://example.com ; split-window -h https://example.org ; rename-session work');
  await a.t.handleKey({ table: 'prefix', key: 'C-s' });
  assert.ok(await storage.get('ctmux:resurrect:last'));

  const b = await boot(conf, { storage });
  await b.tpm.runStartup({ hadLiveState: false });
  const s = b.t.server.session!;
  assert.equal(s.name, 'work');
  const urls = panesInOrder(s.windows[0].layout).map((id) => b.t.server.panes[id].url);
  assert.deepEqual(urls, ['https://example.com', 'https://example.org']);
});

test('GitHub metadata is fetched once and cached', async () => {
  let calls = 0;
  const fetchImpl = async (url: string) => {
    calls++;
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/dracula\/tmux$/);
    return { ok: true, status: 200, json: async () => ({ full_name: 'dracula/tmux', stargazers_count: 1, html_url: 'https://github.com/dracula/tmux', description: 'theme' }) };
  };
  const storage = memoryStorage();
  const { tpm } = await boot("set -g @plugin 'dracula/tmux'", { storage, fetchImpl });
  await tpm.fetchMetadata();
  await tpm.fetchMetadata();
  assert.equal(calls, 1);
  assert.equal(tpm.report()[0].meta.fullName, 'dracula/tmux');
});

test('server state round-trips through JSON', async () => {
  const { t } = await boot('');
  await t.runString('split-window -h ; new-window');
  const json = JSON.parse(JSON.stringify(t.server.toJSON()));
  const { t: t2 } = await boot('');
  assert.ok(t2.server.load(json));
  assert.equal(t2.server.session!.windows.length, 2);
  assert.equal(Object.keys(t2.server.panes).length, 3);
});
