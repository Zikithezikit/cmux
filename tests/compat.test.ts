// Compatibility with real-world ~/.tmux.conf files and TPM plugins:
// the shell subset, hooks, marked panes, command aliases / array options,
// format loops and the commands that were missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tmux } from '../src/core/tmux.js';
import { Tpm, memoryStorage } from '../src/tpm/tpm.js';
import { runShell } from '../src/core/shell.js';
import { resolveCommand } from '../src/core/commands.js';
import { panesInOrder } from '../src/core/layout.js';
import type { TpmFetch, TpmTimers } from '../src/tpm/tpm.js';
import type { MenuOptions, PaneCommandMessage, PopupOptions, Ui } from '../src/core/types.js';

/** A stub UI: records messages; any method it doesn't define is a no-op. */
type StubUi = Ui & { messages: string[] };
type StubOverrides = { [K in keyof Ui]?: (...args: never[]) => unknown };

/** The engine with the stub UI. */
type Engine = Tmux & { ui: StubUi };

/** A fetch stub: resolves to a minimal Response-like object. */
type StubFetch = TpmFetch;

/** TPM's timer and fetch dependencies, stubbed (timers never fire). */
function tpmDeps(fetchImpl: StubFetch): { timers: TpmTimers; fetchImpl: TpmFetch } {
  return { timers: { setInterval: () => 0, clearInterval() {} }, fetchImpl };
}

/** Assert that a value is present and return it (an assertion failure, not a TypeError). */
function must<T>(value: T | null | undefined): T {
  assert.ok(value != null, 'expected a value');
  return value;
}

function stubUi(extra: StubOverrides = {}): StubUi {
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

async function boot(conf: string, { ui = stubUi() }: { ui?: StubUi } = {}): Promise<{ t: Engine; ui: StubUi }> {
  const t = new Tmux({ ui }) as Engine;
  t.platform = 'Linux';
  const tpm = new Tpm(t, { storage: memoryStorage(), ...tpmDeps(async () => ({ ok: false, status: 0, json: async () => null })) });
  await t.loadDefaults();
  t.server.newSession({});
  if (conf) await t.runConfig(conf, { source: 'test.conf' });
  tpm.finish();
  return { t, ui };
}

/** Run tmux commands and capture what they print (like `tmux ...` in a shell). */
async function capture(t: Engine, cmd: string): Promise<string> {
  const r = await t.shell(cmd);
  assert.ok(r, `shell subset should handle: ${cmd}`);
  return r.out;
}

const errors = (t: Engine) => t.notices.filter((n) => n.level === 'error');

// ------------------------------------------------------------------- shell

test('shell subset: version checks, tests and pipelines', async () => {
  const host = { env: { HOME: '/home/me' }, platform: 'Darwin', version: '3.4', tmux: async () => ({ code: 0, out: '' }) };
  const sh = (src: string) => runShell(src, host);
  assert.equal((await sh('tmux -V | cut -c 6-')).out, '3.4\n');
  assert.equal((await sh("tmux -V | cut -d' ' -f2")).out, '3.4\n');
  assert.equal((await sh("tmux -V | sed -En 's/^tmux ([0-9]+(.[0-9]+)?).*/\\1/p'")).out, '3.4\n');
  assert.equal((await sh("tmux -V | awk '{print $2}'")).out, '3.4\n');
  assert.equal((await sh('[ "$(echo "3.4 >= 2.1" | bc)" = 1 ]')).code, 0);
  assert.equal((await sh('[ "$(echo "3.4 < 2.1" | bc)" = 1 ]')).code, 1);
  assert.equal((await sh('test "$(uname)" = "Darwin"')).code, 0);
  assert.equal((await sh('[ "$(uname -s)" = Linux ] && echo linux || echo other')).out, 'other\n');
  assert.equal((await sh('command -v tmux >/dev/null 2>&1')).code, 0);
  assert.equal((await sh('command -v reattach-to-user-namespace')).code, 1);
  assert.equal((await sh('[ -n "$SSH_CLIENT" ]')).code, 1);
  assert.equal((await sh('[ -z "$SSH_CLIENT" ] && [ "$HOME" = /home/me ]')).code, 0);
  assert.equal((await sh('[ 4 -ge 3 -a 2 -lt 1 ]')).code, 1);
  assert.equal((await sh('! false')).code, 0);
  assert.equal((await sh('tmux -V | grep -q "3\\.[2-9]"')).code, 0);
  assert.equal((await sh('echo "${UNSET:-fallback}"')).out, 'fallback\n');
  assert.equal((await sh('V=1.2; echo $V')).out, '1.2\n');
  assert.equal((await sh("sh -c 'echo hi'")).out, 'hi\n');
  assert.equal((await sh('[ -f ~/.tmux.local ]')).code, 1, 'no file system: file tests are false');
  // Outside the subset: callers fall back to "condition false".
  await assert.rejects(sh("ps -o state= -o comm= -t /dev/pts/1 | grep -iqE 'vim'"), /command "ps"/);
  await assert.rejects(sh('if true; then echo; fi'), /keyword/);
});

test('if-shell and run-shell run tmux commands through the shell subset', async () => {
  const { t } = await boot(String.raw`
run-shell 'tmux setenv -g TMUX_VERSION $(tmux -V | cut -c 6-)'
if-shell -b '[ "$(echo "$TMUX_VERSION >= 2.1" | bc)" = 1 ]' "set -g @modern yes" "set -g @modern no"
if-shell 'test "$(uname)" = "Darwin"' 'set -g @mac yes' 'set -g @mac no'
if-shell '[ -n "$TMUX" ]' 'set -g @inside yes'
run -b 'tmux set -g @a 1 && tmux set -g @b "$(tmux show -gqv @a)2"'
if-shell "tmux -V | awk '{print \$2}' | grep -q '^3'" 'set -g @three yes'
set -g @vim_check "#{pane_current_command}"
if-shell "ps -o comm= -t '#{pane_tty}' | grep -iqE vim" 'set -g @vim yes' 'set -g @vim no'
`);
  assert.equal(t.env.TMUX_VERSION, '3.4');
  assert.equal(t.getOption('@modern'), 'yes');
  assert.equal(t.getOption('@mac'), 'no');
  assert.equal(t.getOption('@inside'), 'yes');
  assert.equal(t.getOption('@a'), '1');
  assert.equal(t.getOption('@b'), '12');
  assert.equal(t.getOption('@three'), 'yes');
  assert.equal(t.getOption('@vim'), 'no', 'unsupported shell (ps) still falls back to false');
  assert.ok(t.notices.some((n) => n.message.includes('shell condition treated as false')));
  assert.deepEqual(errors(t), []);
});

test('tmux commands print to a calling shell', async () => {
  const { t } = await boot('set -g @theme "nord"\nsetenv -g FOO bar');
  assert.equal(await capture(t, 'tmux show-option -gqv @theme'), 'nord\n');
  assert.equal(await capture(t, 'tmux show -gqv @nope'), '');
  assert.equal(await capture(t, "tmux display -p '#{session_name}:#{window_index}'"), '0:0\n');
  assert.equal(await capture(t, 'tmux show-environment -g FOO'), 'FOO=bar\n');
  assert.match(await capture(t, 'tmux list-windows -F "#{window_index} #{window_panes}"'), /^0 1\n$/);
  assert.match(await capture(t, 'tmux list-keys -T prefix c'), /new-window/);
  assert.equal(must(await t.shell('tmux show -gv @nope')).code, 1);
  assert.equal(await capture(t, 'tmux list-panes -F "#{pane_index}" -f "#{pane_active}"'), '0\n');
});

// ------------------------------------------------------------------- hooks

test('hooks fire for commands and for server events', async () => {
  const { t } = await boot(String.raw`
set-hook -g after-new-window 'set -gF @after-new "#{window_index}"'
set-hook -g session-created 'set -gaF @events "created:#{hook_session_name} "'
set-hook -g client-session-changed 'set -ga @events "changed "'
set-hook -g window-renamed 'set -gaF @events "renamed:#{window_name} "'
set-hook -g window-linked[0] 'set -ga @events "linked "'
set-hook -ga window-linked 'set -ga @events "linked2 "'
set-hook -g pane-focus-in 'set -gF @focus "#{hook_pane}"'
set-hook -g window-layout-changed 'set -ga @events "layout "'
set-hook -g session-closed 'set -ga @events "closed "'
`);
  const run = (c: string) => t.runString(c);
  await run('new-window');
  assert.equal(t.getOption('@after-new'), '1');
  await run('rename-window build');
  await run('new-session -s work');
  await run('split-window -h');
  await run('kill-session -t work');
  const ev = t.getOption('@events').trim().split(' ');
  assert.deepEqual(ev, ['linked', 'linked2', 'renamed:build', 'created:work', 'linked', 'linked2', 'changed', 'layout', 'closed', 'changed']);
  assert.match(t.getOption('@focus'), /^%\d+$/);

  // show-hooks lists every array element.
  const shown = await capture(t, 'tmux show-hooks -g');
  assert.match(shown, /^window-linked\[0\] set -ga @events 'linked '$/m);
  assert.match(shown, /^window-linked\[1\] /m);

  // -u removes one element or the whole hook; -R runs it now.
  await run('set-hook -gu window-linked[1]');
  await run('set -g @events ""');
  await run('new-window');
  assert.equal(t.getOption('@events'), 'linked ');
  await run('set-hook -gu window-linked');
  await run('set-hook -g -R session-created');
  assert.match(t.getOption('@events'), /created:/);
});

test('set-hook rejects unknown hooks and notes ones that never fire', async () => {
  const { t } = await boot('set-hook -g not-a-hook "display hi"\nset-hook -g pane-died "display died"');
  assert.ok(errors(t).some((n) => n.message.includes('invalid hook: not-a-hook')));
  assert.ok(t.notices.some((n) => n.message.includes('pane-died: this event never happens')));
});

test('hooks cannot recurse forever', async () => {
  const { t } = await boot("set-hook -g after-set-option 'set -ga @n x'");
  await t.runString('set -g @n ""');
  assert.ok(t.getOption('@n').length < 10);
});

// ------------------------------------------------------------ marked panes

test('marked panes: select-pane -m/-M, ~ target, flags and join-pane', async () => {
  const { t } = await boot('');
  const srv = t.server;
  await t.runString('split-window -h');
  const w0 = must(srv.window);
  const [a, b] = panesInOrder(w0.layout);
  await t.runString(`select-pane -m -t %${a}`);
  assert.equal(srv.markedPane(), a);
  assert.equal(t.expand('#{pane_marked_set}#{window_marked_flag}#{window_flags}', { window: w0, pane: a }), '11*M');
  assert.equal(t.expand('#{pane_marked}', { window: w0, pane: b }), '0');
  assert.equal(t.expand('#{?pane_marked,marked,}', { window: w0, pane: a }), 'marked');

  await t.runString('display -p "#{pane_id}"');
  assert.equal(await capture(t, "tmux display -p -t '~' '#{pane_id}'"), `%${a}\n`);
  assert.equal(await capture(t, "tmux display -p -t '{marked}' '#{pane_id}'"), `%${a}\n`);

  // join-pane with no -s takes the marked pane.
  await t.runString('new-window');
  const w1 = must(srv.window);
  await t.runString('join-pane -h');
  assert.deepEqual(panesInOrder(w1.layout).length, 2);
  assert.ok(panesInOrder(w1.layout).includes(a));
  assert.deepEqual(panesInOrder(w0.layout), [b]);

  // Toggle off, then -M clears.
  await t.runString(`select-pane -m -t %${a}`);
  assert.equal(srv.markedPane(), null);
  await t.runString(`select-pane -m -t %${b}`);
  await t.runString('select-pane -M');
  assert.equal(srv.markedPane(), null);
  await assert.doesNotReject(t.runString('join-pane'));
  assert.ok(t.ui.messages.some((m) => m.includes('no marked pane')));

  // A killed marked pane is no longer marked.
  await t.runString(`select-pane -m -t %${a}`);
  await t.runString(`kill-pane -t %${a}`);
  assert.equal(srv.markedPane(), null);
});

test('swap-pane uses the marked pane when -s is omitted', async () => {
  const { t } = await boot('');
  await t.runString('split-window -h');
  await t.runString('split-window -v');
  const w = must(t.server.window);
  const [a, b, c] = panesInOrder(w.layout);
  await t.runString(`select-pane -m -t %${a}`);
  await t.runString(`swap-pane -t %${c}`);
  assert.deepEqual(panesInOrder(w.layout), [c, b, a]);
});

test('default bindings include m/M and the < > menus', async () => {
  const { t } = await boot('');
  assert.deepEqual(must(t.lookupKey('prefix', 'm')).commands, [['select-pane', '-m']]);
  assert.deepEqual(must(t.lookupKey('prefix', 'M')).commands, [['select-pane', '-M']]);
  assert.equal(must(t.lookupKey('prefix', '<')).commands[0][0], 'display-menu');
  assert.equal(must(t.lookupKey('prefix', '>')).commands[0][0], 'display-menu');
  assert.deepEqual(t.notices, []);
});

// ------------------------------------------------- aliases & array options

test('command-alias and array options', async () => {
  const { t } = await boot(String.raw`
set -s command-alias[100] zoom='resize-pane -Z'
set -sa command-alias "sv=split-window -v"
set -ga terminal-overrides ",xterm-256color:Tc"
set -as terminal-features ",xterm*:RGB"
set -g status-format[1] "#[align=centre]second line"
set -g update-environment "DISPLAY SSH_AUTH_SOCK"
set -ga update-environment " WAYLAND_DISPLAY"
`);
  assert.deepEqual(errors(t), []);
  assert.ok(!t.notices.some((n) => n.message.includes('unknown option')), JSON.stringify(t.notices));
  assert.equal(t.getOption('command-alias[100]'), 'zoom=resize-pane -Z');
  assert.equal(t.getOption('command-alias[101]'), 'sv=split-window -v');
  assert.deepEqual(t.arrayOption('terminal-overrides'), [[0, 'xterm-256color:Tc']]);
  assert.deepEqual(t.arrayOption('update-environment').map(([, v]) => v), ['DISPLAY', 'SSH_AUTH_SOCK', 'WAYLAND_DISPLAY']);
  assert.equal(t.getOption('status-format[1]'), '#[align=centre]second line');

  // Built-in aliases still work, user aliases get the remaining arguments.
  await t.runString('split-pane -h');
  await t.runString('sv');
  const w = must(t.server.window);
  assert.equal(panesInOrder(w.layout).length, 3);
  await t.runString('zoom');
  assert.equal(w.zoomed, true);

  const shown = await capture(t, 'tmux show -s command-alias');
  assert.match(shown, /^command-alias\[0\] split-pane=split-window$/m);
  assert.match(shown, /^command-alias\[100\] 'zoom=resize-pane -Z'$/m);

  await t.runString('set -su command-alias');
  assert.equal(t.getOption('command-alias[100]'), '');
  assert.equal(t.getOption('command-alias[0]'), 'split-pane=split-window', '-u restores the defaults');
});

// ----------------------------------------------------------------- formats

test('formats: loops, option lookup, sizes and new modifiers', async () => {
  const { t } = await boot('set -g base-index 1\nset -g @accent blue');
  await t.runString('new-window -n two');
  await t.runString('new-window -n three');
  await t.runString('select-window -t 1'); // the session predates base-index 1, so windows are 0..2
  await t.runString('new-session -d -s other');
  const ex = (f: string) => t.expandPlain(f);
  assert.equal(ex('#{W:#{window_name} ,[#{window_name}] }'), 'new [two] three ');
  assert.equal(ex('#{W/r:#{window_index}}'), '210');
  assert.equal(ex('#{S:#{session_name}#{?session_format,*,} }'), '0* other* ');
  assert.equal(ex('#{S/n:#{session_name},<#{session_name}>}'), '<0>other');
  await t.runString('split-window -h');
  assert.equal(ex('#{P:#{pane_index}#{?pane_active,*,} }'), '0 1* ');
  assert.equal(ex('#{status-left-length}|#{base-index}|#{@accent}'), '10|1|blue');
  assert.equal(ex('#{N/w:three}#{N/w:nope}#{N/s:other}'), '101');
  assert.equal(ex('#{!:0}#{!:1}#{!!:yes}'), '101');
  assert.equal(ex('#{a:65}#{w:hello}#{c:red}'), 'A5#cd3131');
  assert.equal(ex('#{R:-,3}'), '---');
  assert.equal(ex('#{client_width}x#{client_height}'), '200x45');
  assert.equal(ex('#{pane_at_left}#{pane_at_right}'), '01', 'active pane is the right half');
  assert.equal(ex('#{pane_width}'), '100');
  assert.equal(ex('#{?#{<:#{client_width},100},narrow,wide}'), 'wide');
  assert.equal(ex('#{version}'), '3.4');
  assert.equal(ex('#{e|>=|f|:#{version},3.2}'), '1');
});

test('vim-tmux-navigator style pane_at_* bindings work', async () => {
  const { t } = await boot(String.raw`
bind -n C-h if -F '#{pane_at_left}' '' 'select-pane -L'
bind -n C-l if -F '#{pane_at_right}' '' 'select-pane -R'
`);
  await t.runString('split-window -h');
  const w = must(t.server.window);
  const [left, right] = panesInOrder(w.layout);
  await t.handleKey({ table: 'root', key: 'C-l' });
  assert.equal(w.active, right, 'already at the right edge: no-op');
  await t.handleKey({ table: 'root', key: 'C-h' });
  assert.equal(w.active, left);
  await t.handleKey({ table: 'root', key: 'C-h' });
  assert.equal(w.active, left);
});

// ---------------------------------------------------------- new commands

test('every tmux 3.4 command name resolves', () => {
  const names = `attach-session bind-key break-pane capture-pane choose-buffer choose-client choose-tree clear-history
    clear-prompt-history clock-mode command-prompt confirm-before copy-mode customize-mode delete-buffer detach-client
    display-menu display-message display-popup display-panes find-window has-session if-shell join-pane kill-pane
    kill-server kill-session kill-window last-pane last-window link-window list-buffers list-clients list-commands
    list-keys list-panes list-sessions list-windows load-buffer lock-client lock-server lock-session move-pane
    move-window new-session new-window next-layout next-window paste-buffer pipe-pane previous-layout previous-window
    refresh-client rename-session rename-window resize-pane resize-window respawn-pane respawn-window rotate-window
    run-shell save-buffer select-layout select-pane select-window send-keys send-prefix server-access set-buffer
    set-environment set-hook set-option set-window-option show-buffer show-environment show-hooks show-messages
    show-options show-prompt-history show-window-options source-file split-window start-server suspend-client
    swap-pane swap-window switch-client unbind-key unlink-window wait-for popup menu attach`.split(/\s+/);
  assert.deepEqual(names.filter((n) => !resolveCommand(n)), []);
});

test('display-menu runs the chosen item; disabled items and separators are skipped', async () => {
  let shown: MenuOptions | undefined;
  const ui = stubUi({ menu: async (opts: MenuOptions) => { shown = opts; return opts.items.find((i) => i.key === 'v'); } });
  const { t } = await boot('', { ui });
  await t.runString('display-menu -T "#[align=centre]Pane #{pane_index}" "Split" v { split-window -h } "" "-Nope" n { kill-server } "#{?pane_marked,Unmark,Mark}" m "select-pane -m"');
  assert.equal(must(shown).title, 'Pane 0');
  assert.deepEqual(must(shown).items.map((i) => (i.separator ? '---' : `${i.disabled ? '!' : ''}${i.label}`)), ['Split', '---', '!Nope', 'Mark']);
  assert.equal(panesInOrder(must(t.server.window).layout).length, 2);
});

test('the default pane menu (prefix >) runs block commands from a binding', async () => {
  const ui = stubUi({ menu: async (opts: MenuOptions) => opts.items.find((i) => i.key === 'v') });
  const { t } = await boot('', { ui });
  await t.handleKey({ table: 'prefix', key: '>' });
  assert.equal(panesInOrder(must(t.server.window).layout).length, 2);
  assert.deepEqual(ui.messages, []);
});

test('display-popup opens URLs in a popup and runs tmux commands', async () => {
  const popups: PopupOptions[] = [];
  const ui = stubUi({ popup: (o: PopupOptions) => popups.push(o) });
  const { t } = await boot('', { ui });
  await t.runString('display-popup -w 80% -h 60% -T Docs https://man7.org/linux/man-pages/man1/tmux.1.html');
  assert.equal(popups[0].url, 'https://man7.org/linux/man-pages/man1/tmux.1.html');
  assert.equal(popups[0].width, '80%');
  assert.equal(popups[0].title, 'Docs');
  // The classic "scratch session" popup.
  await t.runString('display-popup -E "tmux new-session -A -s scratch"');
  assert.equal(must(t.server.session).name, 'scratch');
  await t.runString('display-popup -E "lazygit"');
  assert.ok(ui.messages.some((m) => m.includes("can't run 'lazygit'")));
});

test('wait-for signals waiters and locks channels', async () => {
  const { t } = await boot('');
  let woke = false;
  const waiting = t.runString('wait-for ready').then(() => { woke = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(woke, false);
  await t.runString('wait-for -S ready');
  await waiting;
  assert.equal(woke, true);
  // A signal with nobody waiting is remembered for the next wait.
  await t.runString('wait-for -S early');
  await t.runString('wait-for early');
  await t.runString('wait-for -L lock');
  let got = false;
  const second = t.runString('wait-for -L lock').then(() => { got = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(got, false);
  await t.runString('wait-for -U lock');
  await second;
  assert.equal(got, true);
});

test('capture-pane, buffers and the clipboard', async () => {
  let clip: string | null = null;
  const ui = stubUi({
    paneCommand: async (_id: number, msg: PaneCommandMessage) => (msg.type === 'capture' ? { text: 'line one\nline two\nline three' } : null),
    writeClipboard: (s: string) => { clip = s; },
  });
  const { t } = await boot('', { ui });
  must(t.server.pane).kind = 'web';
  must(t.server.pane).url = 'https://example.com';
  await t.runString('capture-pane');
  assert.equal(t.buffers[0].data, 'line one\nline two\nline three');
  assert.equal(await capture(t, 'tmux capture-pane -p -S 1 -E 1'), 'line two\n');
  await t.runString('set-buffer -b mine hello');
  await t.runString('set-buffer -b mine -n renamed');
  assert.ok(t.buffers.some((b) => b.name === 'renamed' && b.data === 'hello'));
  await t.runString('save-buffer -b renamed ~/out.txt');
  assert.equal(clip, 'hello');
  assert.equal(await capture(t, 'tmux save-buffer -b renamed -'), 'hello\n');
});

// ------------------------------------------------- a kitchen-sink config

test('a kitchen-sink modern config loads without errors', async () => {
  const { t } = await boot(String.raw`
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",*256col*:Tc"
set -as terminal-features ",xterm-256color:RGB"
set -g allow-passthrough on
set -g focus-events on
set -s extended-keys on
set -s escape-time 0
set -g history-limit 50000
set -g set-clipboard on
set -g detach-on-destroy off
set -g pane-border-lines heavy
set -g pane-border-indicators arrows
set -g popup-border-lines rounded
set -gw synchronize-panes off
set -s command-alias[10] reload='source-file ~/.tmux.conf'
bind g display-popup -d "#{pane_current_path}" -w 80% -h 80% -E "lazygit"
bind f display-popup -E "tmux new -A -s scratch"
bind M-m display-menu -T "Quick" "New window" n new-window "Kill pane" x kill-pane
bind -T copy-mode-vi y send -X copy-pipe-and-cancel "pbcopy"
bind y run -b "tmux save-buffer - | pbcopy"
bind C-l send-keys "clear" Enter \; clear-history
bind S setw synchronize-panes \; display "sync #{?pane_synchronized,on,off}"
set-hook -g after-split-window "select-layout -E"
set-hook -g client-attached 'run -b "true"'
if-shell 'test "$(uname)" = "Darwin"' 'set -g default-command "reattach-to-user-namespace -l $SHELL"'
if-shell '[ -f ~/.tmux.local.conf ]' 'source ~/.tmux.local.conf'
%if #{>=:#{version},3.3}
set -g @modern on
%endif
run-shell "tmux set -g @loaded yes"
`);
  assert.deepEqual(errors(t), []);
  assert.equal(t.getOption('@modern'), 'on');
  assert.equal(t.getOption('@loaded'), 'yes');
  assert.ok(!t.notices.some((n) => n.message.includes('unknown option')), JSON.stringify(t.notices.filter((n) => n.message.includes('unknown option'))));
  await t.runString('reload');
  // after-split-window hook runs select-layout -E.
  await t.handleKey({ table: 'prefix', key: '%' });
  assert.equal(panesInOrder(must(t.server.window).layout).length, 2);
});
