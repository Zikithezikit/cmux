// The tmux engine: options, key tables, config sourcing and command dispatch.
// It is UI-agnostic; the workspace page supplies a `ui` adapter (see
// src/workspace/workspace.js) and tests supply a stub.

import '../shared/keys.js';
import { tokenize, toCommandList, parseArgs, formatCommandList, argToString } from './parser.js';
import { expandFormat, strftime, plainText, parseStyle } from './format.js';
import { DEFAULT_OPTIONS, DEFAULT_BINDINGS, DEFAULT_COPY_BINDINGS } from './defaults.js';
import { Server, paneShortName } from './server.js';
import { COMMANDS, resolveCommand } from './commands.js';
import { panesInOrder } from './layout.js';

const { normalizeKey } = globalThis.CtmuxKeys;

/** tmux options that exist but have no meaning inside a browser. */
const INERT_OPTIONS = new Set([
  'allow-passthrough', 'terminal-overrides', 'terminal-features', 'default-shell', 'update-environment',
  'visual-activity', 'visual-bell', 'visual-silence', 'monitor-activity', 'monitor-bell', 'monitor-silence',
  'bell-action', 'activity-action', 'silence-action', 'word-separators', 'wrap-search', 'xterm-keys',
  'extended-keys', 'copy-command', 'set-clipboard', 'exit-empty', 'exit-unattached', 'buffer-limit',
  'command-alias', 'editor', 'message-limit', 'prompt-history-limit', 'remain-on-exit',
  'synchronize-panes', 'alternate-screen', 'cursor-style', 'cursor-colour', 'popup-style',
  'popup-border-style', 'popup-border-lines', 'menu-style', 'menu-selected-style', 'menu-border-style',
  'status-format', 'key-table', 'lock-after-time', 'lock-command', 'destroy-unattached', 'scroll-on-clear',
  'fill-character', 'pane-colours', 'copy-mode-match-style', 'copy-mode-current-match-style',
  'copy-mode-mark-style', 'other-pane-height', 'other-pane-width', 'window-size', 'default-size',
  'escape-time', 'history-limit', 'default-terminal', 'focus-events', 'aggressive-resize', 'utf8',
  'status-utf8', 'mouse-select-pane', 'mouse-resize-pane', 'mouse-select-window', 'mode-mouse',
  'assume-paste-time', 'backspace', 'remain-on-exit-format', 'lock-server', 'get-clipboard',
  'input-buffer-size', 'detach-on-destroy', 'activity-action', 'pane-border-indicators',
  'pane-border-lines', 'window-status-activity-style', 'window-status-bell-style', 'window-style',
  'window-active-style', 'status-bg', 'status-fg',
]);

/** Commands whose arguments are themselves a command list (`\;` stays inside). */
const LIST_COMMANDS = new Set(['bind-key', 'if-shell', 'confirm-before', 'command-prompt', 'set-hook', 'run-shell']);

export class Tmux {
  constructor({ ui, loadFile, now } = {}) {
    this.ui = ui || nullUi();
    this.loadFile = loadFile || (async () => { throw new Error('no file loader'); });
    this.now = now || (() => new Date());
    this.options = { ...DEFAULT_OPTIONS };
    this.optionOrigins = {};
    this.tables = new Map();
    this.env = {};
    this.messages = [];
    this.notices = [];
    this.buffers = [];
    this.formatVars = new Map();
    this.shellVars = new Map();
    this.clientPrefix = false;
    this.keyTable = 'root';
    this.plugins = null; // set by tpm
    this.hooks = {};
    this.pluginHooks = { afterConfig: [], change: [], paneReport: [] };
    this.server = new Server((name) => this.getOption(name));
    this.server.addEventListener('change', () => this.pluginHooks.change.forEach((f) => f()));
    this.sourcing = 0;
  }

  // -------------------------------------------------------------- logging

  log(message, level = 'info') {
    this.messages.push({ time: Date.now(), level, message });
    if (this.messages.length > 500) this.messages.shift();
  }

  /** Record a configuration notice (shown in the debug panel). */
  notice(message, { source, line, level = 'warn', key } = {}) {
    const k = key || `${source || ''}:${line || ''}:${message}`;
    if (this.notices.some((n) => n.key === k)) return;
    this.notices.push({ key: k, message, source, line, level });
    this.log(`${source ? source + (line ? ':' + line : '') + ': ' : ''}${message}`, level);
  }

  // -------------------------------------------------------------- options

  getOption(name) {
    return this.options[name] ?? '';
  }

  setOption(name, value, origin = 'user') {
    this.options[name] = String(value);
    this.optionOrigins[name] = origin;
  }

  /** Set only if the user hasn't changed it from the built-in default (plugins use this). */
  setDefaultOption(name, value, origin) {
    if (this.optionOrigins[name] === 'user') return false;
    this.setOption(name, value, origin);
    return true;
  }

  isKnownOption(name) {
    return name[0] === '@' || name in DEFAULT_OPTIONS || INERT_OPTIONS.has(name) || /\[\d+\]$/.test(name);
  }

  // ----------------------------------------------------------- key tables

  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name);
  }

  bind(table, key, commands, { repeat = false, note = '', origin = 'user' } = {}) {
    const k = normalizeKey(key);
    if (!k) return null;
    this.table(table).set(k, { key: k, commands, repeat, note, origin });
    return k;
  }

  unbind(table, key) {
    const k = normalizeKey(key);
    if (k) this.table(table).delete(k);
  }

  lookupKey(table, key) {
    return this.tables.get(table)?.get(key) || null;
  }

  /** Config the pane agents (content scripts) need to route keys locally. */
  runtimeConfig() {
    const tables = {};
    const repeat = {};
    for (const [name, map] of this.tables) {
      if (name.startsWith('copy-mode')) continue;
      tables[name] = [...map.keys()];
      repeat[name] = [...map.values()].filter((b) => b.repeat).map((b) => b.key);
    }
    const copy = {};
    for (const name of ['copy-mode', 'copy-mode-vi']) {
      copy[name] = {};
      for (const [key, b] of this.table(name)) {
        const cmd = b.commands.length === 1 ? b.commands[0] : null;
        if (cmd && /^send(-keys)?$/.test(cmd[0]) && cmd.includes('-X')) {
          const x = cmd.indexOf('-X');
          copy[name][key] = { local: cmd.slice(x + 1) };
        } else {
          copy[name][key] = { remote: true };
        }
      }
    }
    return {
      prefix: normalizeKey(this.getOption('prefix')),
      prefix2: normalizeKey(this.getOption('prefix2')),
      tables,
      repeat,
      repeatTime: Number(this.getOption('repeat-time')) || 0,
      modeKeys: this.getOption('mode-keys'),
      modeColours: (({ fg, bg }) => ({ fg, bg }))(parseStyle(this.getOption('mode-style'))),
      mouse: this.getOption('mouse') === 'on',
      copy,
      yank: this.plugins?.isActive('tmux-plugins/tmux-yank')
        ? { mouse: this.getOption('@yank_with_mouse') !== 'off' }
        : null,
    };
  }

  // --------------------------------------------------------- configuration

  /** Load built-in defaults (options are already set in the constructor). */
  async loadDefaults() {
    await this.runConfig(DEFAULT_BINDINGS, { source: '(defaults)', origin: 'default' });
    await this.runConfig(DEFAULT_COPY_BINDINGS, { source: '(defaults)', origin: 'default' });
  }

  /**
   * Run configuration text. Commands are executed sequentially; async
   * commands (source-file) are awaited.
   */
  async runConfig(text, { source = '(config)', origin = 'user', depth = 0 } = {}) {
    if (depth > 10) { this.notice('source-file nested too deeply', { source }); return; }
    const { commands, errors } = tokenize(text, this.env);
    errors.forEach((e) => this.notice(e.message, { source, line: e.line, level: 'error' }));
    const cond = []; // stack of { active, taken }
    const active = () => cond.every((c) => c.active);
    this.sourcing++;
    try {
      for (const { args, line } of commands) {
        if (!args.length) continue;
        const name = String(args[0]);
        if (name === '%if' || name === '%elif' || name === '%else' || name === '%endif') {
          const val = () => {
            const v = expandFormat(argToString(args[1] ?? ''), this.lookup());
            return v !== '' && v !== '0';
          };
          if (name === '%if') {
            const parent = active();
            const on = parent && val();
            cond.push({ active: on, taken: on, parent });
          } else if (name === '%elif') {
            const top = cond[cond.length - 1];
            if (!top) { this.notice('%elif without %if', { source, line }); continue; }
            const on = top.parent && !top.taken && val();
            top.active = on;
            top.taken = top.taken || on;
          } else if (name === '%else') {
            const top = cond[cond.length - 1];
            if (!top) { this.notice('%else without %if', { source, line }); continue; }
            top.active = top.parent && !top.taken;
            top.taken = true;
          } else {
            if (!cond.pop()) this.notice('%endif without %if', { source, line });
          }
          continue;
        }
        if (!active()) continue;
        try {
          await this.execute(args, { source, line, origin, depth, fromConfig: true });
        } catch (err) {
          this.notice(String(err.message || err), { source, line, level: 'error' });
        }
      }
    } finally {
      this.sourcing--;
    }
    if (cond.length) this.notice('unterminated %if', { source, level: 'error' });
  }

  // ----------------------------------------------------------- execution

  /** Execute a command list (array of arg arrays) sequentially. */
  async runList(list, ctx = {}) {
    for (const args of list) {
      const r = await this.execute(args, ctx);
      if (r === false) break; // a failing command stops the list, like tmux
    }
  }

  /** Parse and run a command line typed at the command prompt. */
  async runString(str, ctx = {}) {
    const { commands, errors } = tokenize(str, { ...this.env });
    if (errors.length) { this.ui.message(errors[0].message); return; }
    for (const c of commands) {
      if (!c.args.length) continue;
      const r = await this.execute(c.args, ctx);
      if (r === false) break;
    }
  }

  async execute(args, ctx = {}) {
    const name = String(args[0]);
    const def = resolveCommand(name);
    if (def && !LIST_COMMANDS.has(def.name) && args.includes(';')) {
      return this.runList(toCommandList(args, this.env), ctx);
    }
    if (!def) {
      const msg = `unknown command: ${name}`;
      if (ctx.fromConfig) this.notice(msg, { source: ctx.source, line: ctx.line, level: 'error' });
      else this.ui.message(msg);
      return false;
    }
    const parsed = parseArgs(args.slice(1), def.flags);
    if (parsed.errors.length) {
      const msg = `${def.name}: ${parsed.errors.join(', ')}`;
      if (ctx.fromConfig) this.notice(msg, { source: ctx.source, line: ctx.line });
      else this.log(msg, 'warn');
    }
    const flags = parsed.flags;
    const rest = parsed.args;
    try {
      const r = await def.run(this, flags, rest, { ...ctx, invokedAs: name });
      if (!this.sourcing) this.server.changed(def.name);
      return r;
    } catch (err) {
      const msg = `${def.name}: ${err.message || err}`;
      if (ctx.fromConfig) this.notice(msg, { source: ctx.source, line: ctx.line, level: 'error' });
      else { this.ui.message(msg); this.log(msg, 'error'); }
      return false;
    }
  }

  /** Handle a key routed by a pane agent or the workspace page. */
  async handleKey({ table, key, prefix }, ctx = {}) {
    if (prefix) {
      this.clientPrefix = true;
      this.server.changed('prefix');
      return;
    }
    const wasPrefix = this.clientPrefix;
    this.clientPrefix = false;
    const b = this.lookupKey(table, key);
    if (!b) {
      if (wasPrefix) this.server.changed('prefix');
      return;
    }
    await this.runList(b.commands, { ...ctx, key, fromKey: true });
    if (wasPrefix) this.server.changed('prefix');
  }

  // --------------------------------------------------------------- formats

  /**
   * Build a lookup function for format expansion.
   * ctx: { session, window, pane (id) }
   */
  lookup(ctx = {}) {
    const srv = this.server;
    const session = ctx.session || srv.session;
    const window = ctx.window || (session && srv.activeWindow(session));
    const paneId = ctx.pane ?? window?.active;
    const pane = srv.panes[paneId];
    const winFlags = (w) => {
      if (!session) return '';
      let f = '';
      if (w.id === session.active) f += '*';
      else if (w.id === session.last) f += '-';
      if (w.zoomed) f += 'Z';
      return f;
    };
    const urlPath = (p) => (p ? (p.kind === 'web' ? p.url : p.prefill || '') : '');
    return (name) => {
      if (name.startsWith('#(')) {
        const cmd = name.slice(2, -1);
        for (const [re, fn] of this.shellVars) if (re.test(cmd)) return fn(cmd);
        this.notice(`#(${cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd}) — shell commands can't run in the browser`, { level: 'info', key: 'shell:' + cmd });
        return '';
      }
      if (this.formatVars.has(name)) return this.formatVars.get(name)(ctx);
      if (name[0] === '@') return this.options[name];
      switch (name) {
        case 'session_name': return session?.name;
        case 'session_id': return session ? '$' + session.id : '';
        case 'session_windows': return session?.windows.length;
        case 'session_attached': return '1';
        case 'session_many_attached': return '0';
        case 'session_created': return session ? Math.floor(session.created / 1000) : '';
        case 'session_alerts': return '';
        case 'session_grouped': return '0';
        case 'window_index': return window?.index;
        case 'window_id': return window ? '@' + window.id : '';
        case 'window_name': return window ? srv.windowName(window) : '';
        case 'window_flags': return window ? winFlags(window) : '';
        case 'window_raw_flags': return window ? winFlags(window) : '';
        case 'window_active': return window && session && window.id === session.active ? '1' : '0';
        case 'window_last_flag': return window && session && window.id === session.last ? '1' : '0';
        case 'window_zoomed_flag': return window?.zoomed ? '1' : '0';
        case 'window_panes': return window ? panesInOrder(window.layout).length : 0;
        case 'window_bigger': return '0';
        case 'window_activity_flag': case 'window_bell_flag': case 'window_silence_flag': return '0';
        case 'window_start_flag': return window && session && srv.sortedWindows(session)[0] === window ? '1' : '0';
        case 'window_end_flag': { const s = session && srv.sortedWindows(session); return window && s && s[s.length - 1] === window ? '1' : '0'; }
        case 'window_layout': return window?.layoutName || '';
        case 'pane_index': return window && paneId != null ? srv.paneIndex(window, paneId) : '';
        case 'pane_id': return paneId != null ? '%' + paneId : '';
        case 'pane_title': return pane ? (pane.title || (pane.kind === 'web' ? pane.url : 'chrome-tmux')) : '';
        case 'pane_current_path': return urlPath(pane);
        case 'pane_current_command': return pane ? paneShortName(pane) : '';
        case 'pane_url': return pane?.url || '';
        case 'pane_active': return window && paneId === window.active ? '1' : '0';
        case 'pane_last': return window && paneId === window.last ? '1' : '0';
        case 'pane_in_mode': return pane?.mode ? '1' : '0';
        case 'pane_mode': return pane?.mode || '';
        case 'pane_dead': return '0';
        case 'pane_tty': return '';
        case 'pane_pid': return '';
        case 'pane_width': case 'pane_height': return '';
        case 'client_prefix': return this.clientPrefix ? '1' : '0';
        case 'client_key_table': return this.keyTable;
        case 'client_session': return srv.session?.name;
        case 'client_termname': return 'chrome';
        case 'host': return 'chrome';
        case 'host_short': return 'chrome';
        case 'version': return '3.4-chrome';
        case 'pid': return '';
        case 'socket_path': return '';
        case 'start_time': return Math.floor(srv.created / 1000);
        case 'mouse_any_flag': return '0';
        case 'alternate_on': return '0';
        case 'cursor_flag': return '1';
      }
      return this.env[name];
    };
  }

  /** Expand a format with strftime, like status-left/right. */
  expand(fmt, ctx = {}, { time = false } = {}) {
    let f = String(fmt ?? '');
    if (time) f = strftime(f, this.now());
    return expandFormat(f, this.lookup(ctx));
  }

  expandPlain(fmt, ctx = {}, opts) {
    return plainText(this.expand(fmt, ctx, opts));
  }

  /** Format a binding for list-keys output. */
  describeBinding(table, b) {
    const flag = b.repeat ? ' -r' : '';
    return `bind-key${flag} -T ${table} ${b.key.padEnd(10)} ${formatCommandList(b.commands)}`;
  }
}

export function nullUi() {
  const noop = () => {};
  return new Proxy({}, {
    get: (_, prop) => {
      if (prop === 'prompt') return async () => null;
      if (prop === 'confirm') return async () => false;
      if (prop === 'geometry') return () => ({ rect: { x: 0, y: 0, w: 1600, h: 900 }, gap: 1, cell: { w: 8, h: 17 } });
      return noop;
    },
  });
}

export { COMMANDS, toCommandList };
