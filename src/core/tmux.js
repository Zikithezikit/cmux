// The tmux engine: options, key tables, config sourcing and command dispatch.
// It is UI-agnostic; the workspace page supplies a `ui` adapter (see
// src/workspace/workspace.js) and tests supply a stub.

import '../shared/keys.js';
import { tokenize, toCommandList, parseArgs, formatCommandList, argToString } from './parser.js';
import { expandFormat, strftime, plainText, parseStyle } from './format.js';
import { DEFAULT_OPTIONS, DEFAULT_BINDINGS, DEFAULT_COPY_BINDINGS, ARRAY_OPTIONS, EVENT_HOOKS } from './defaults.js';
import { Server, paneShortName } from './server.js';
import { COMMANDS, resolveCommand } from './commands.js';
import { panesInOrder, computeRects } from './layout.js';
import { Shell, Unsupported } from './shell.js';

const { normalizeKey } = globalThis.CtmuxKeys;

/** tmux options that exist but have no meaning inside a browser. */
const INERT_OPTIONS = new Set([
  'allow-passthrough', 'terminal-overrides', 'terminal-features', 'default-shell', 'update-environment',
  'visual-activity', 'visual-bell', 'visual-silence', 'monitor-activity', 'monitor-bell', 'monitor-silence',
  'bell-action', 'activity-action', 'silence-action', 'word-separators', 'wrap-search', 'xterm-keys',
  'extended-keys', 'copy-command', 'set-clipboard', 'exit-empty', 'exit-unattached', 'buffer-limit',
  'editor', 'message-limit', 'prompt-history-limit', 'remain-on-exit',
  'synchronize-panes', 'alternate-screen', 'cursor-style', 'cursor-colour', 'popup-style',
  'popup-border-style', 'popup-border-lines', 'menu-style', 'menu-selected-style', 'menu-border-style',
  'key-table', 'lock-after-time', 'lock-command', 'destroy-unattached', 'scroll-on-clear',
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
    this.hooks = {}; // name -> sparse array of command lists
    this.hookDepth = 0;
    this.hookInfo = null; // { hook, session, window, pane } of the running hook
    this.execDepth = 0;
    this.waitChannels = new Map();
    this.platform = guessPlatform();
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
    const base = name.replace(/\[\d+\]$/, '');
    return name[0] === '@' || name in DEFAULT_OPTIONS || INERT_OPTIONS.has(name) || base in ARRAY_OPTIONS || /\[\d+\]$/.test(name);
  }

  /** Elements of an array option, as [index, value] pairs sorted by index. */
  arrayOption(base) {
    const out = [];
    for (const [k, v] of Object.entries(this.options)) {
      if (!k.startsWith(base + '[')) continue;
      const m = /^\[(\d+)\]$/.exec(k.slice(base.length));
      if (m) out.push([Number(m[1]), v]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }

  /** command-alias lookup: alias name -> command string. */
  commandAlias(name) {
    for (const [, v] of this.arrayOption('command-alias')) {
      const eq = v.indexOf('=');
      if (eq > 0 && v.slice(0, eq) === name) return v.slice(eq + 1);
    }
    return null;
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
    // command-alias takes priority over command names, like tmux.
    const alias = ctx.aliasDepth > 8 ? null : this.commandAlias(name);
    if (alias != null) {
      const { commands } = tokenize(alias, { ...this.env });
      const list = commands.map((c) => c.args).filter((a) => a.length);
      if (list.length) list[list.length - 1] = list[list.length - 1].concat(args.slice(1));
      return this.runList(list, { ...ctx, aliasDepth: (ctx.aliasDepth || 0) + 1 });
    }
    const def = resolveCommand(name);
    if (def && !LIST_COMMANDS.has(def.name) && args.includes(';')) {
      return this.runList(toCommandList(args, this.env), ctx);
    }
    if (!def) {
      const msg = `unknown command: ${name}`;
      if (ctx.fromConfig) this.notice(msg, { source: ctx.source, line: ctx.line, level: 'error' });
      else if (ctx.print) throw new Error(msg);
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
    const before = this.execDepth === 0 && this.hasHooks() ? this.hookSnapshot() : null;
    this.execDepth++;
    let r;
    try {
      r = await def.run(this, flags, rest, { ...ctx, invokedAs: name });
    } catch (err) {
      const msg = `${def.name}: ${err.message || err}`;
      if (ctx.print) throw new Error(msg);
      if (ctx.fromConfig) this.notice(msg, { source: ctx.source, line: ctx.line, level: 'error' });
      else { this.ui.message(msg); this.log(msg, 'error'); }
      return false;
    } finally {
      this.execDepth--;
    }
    if (!this.sourcing) this.server.changed(def.name);
    if (r !== false && this.hasHooks()) {
      if (before) await this.fireEventHooks(before);
      await this.fireHook(`after-${def.name}`, ctx);
    }
    return r;
  }

  // ----------------------------------------------------------------- hooks

  hasHooks() {
    for (const k in this.hooks) if (this.hooks[k]?.some(Boolean)) return true;
    return false;
  }

  /** Run the commands attached to hook `name` (all array indexes, in order). */
  async fireHook(name, ctx = {}) {
    const list = this.hooks[name];
    if (!list || !list.some(Boolean) || this.hookDepth > 4) return;
    const srv = this.server;
    const prev = this.hookInfo;
    const session = ctx.session || srv.session;
    const window = ctx.window || (session && srv.activeWindow(session));
    this.hookInfo = { hook: name, session, window, pane: ctx.pane ?? window?.active };
    this.hookDepth++;
    try {
      for (const cmds of list) {
        if (!cmds) continue;
        await this.runList(cmds, { ...ctx, fromConfig: false, fromKey: false, fromHook: name });
      }
    } finally {
      this.hookDepth--;
      this.hookInfo = prev;
    }
  }

  hookSnapshot() {
    const srv = this.server;
    const windows = new Map();
    for (const s of srv.sessions) {
      for (const w of s.windows) windows.set(w.id, { s, w, name: srv.windowName(w), layout: JSON.stringify(w.layout), active: w.active, zoomed: w.zoomed });
    }
    return {
      sessions: new Map(srv.sessions.map((s) => [s.id, { s, name: s.name, active: s.active }])),
      windows,
      current: srv.currentId,
      pane: srv.window?.active ?? null,
      modes: Object.fromEntries(Object.values(srv.panes).map((p) => [p.id, p.mode || ''])),
      titles: Object.fromEntries(Object.values(srv.panes).map((p) => [p.id, p.title || ''])),
    };
  }

  /** Fire the event hooks implied by the state change since `before`. */
  async fireEventHooks(before) {
    const srv = this.server;
    const after = this.hookSnapshot();
    const fire = [];
    for (const [id, a] of after.sessions) {
      const b = before.sessions.get(id);
      if (!b) fire.push(['session-created', { session: a.s }]);
      else {
        if (b.name !== a.name) fire.push(['session-renamed', { session: a.s }]);
        if (b.active !== a.active) fire.push(['session-window-changed', { session: a.s }]);
      }
    }
    for (const [id, b] of before.sessions) if (!after.sessions.has(id)) fire.push(['session-closed', { session: null, closed: b.name }]);
    for (const [id, a] of after.windows) {
      const b = before.windows.get(id);
      if (!b) { fire.push(['window-linked', { session: a.s, window: a.w }]); continue; }
      if (b.name !== a.name) fire.push(['window-renamed', { session: a.s, window: a.w }]);
      if (b.layout !== a.layout || b.zoomed !== a.zoomed) fire.push(['window-layout-changed', { session: a.s, window: a.w }]);
      if (b.active !== a.active) fire.push(['window-pane-changed', { session: a.s, window: a.w, pane: a.active }]);
    }
    for (const [id, b] of before.windows) if (!after.windows.has(id)) fire.push(['window-unlinked', { session: srv.sessions.includes(b.s) ? b.s : null }]);
    if (after.current !== before.current && after.current != null) fire.push(['client-session-changed', {}]);
    if (after.pane !== before.pane) {
      if (before.pane != null && srv.panes[before.pane]) {
        const loc = srv.locate(before.pane);
        fire.push(['pane-focus-out', { session: loc?.session, window: loc?.window, pane: before.pane }]);
      }
      if (after.pane != null) fire.push(['pane-focus-in', { pane: after.pane }]);
    }
    for (const [id, m] of Object.entries(after.modes)) {
      if (id in before.modes && before.modes[id] !== m) {
        const loc = srv.locate(Number(id));
        fire.push(['pane-mode-changed', { session: loc?.session, window: loc?.window, pane: Number(id) }]);
      }
    }
    for (const [id, title] of Object.entries(after.titles)) {
      if (id in before.titles && before.titles[id] !== title) {
        const loc = srv.locate(Number(id));
        fire.push(['pane-title-changed', { session: loc?.session, window: loc?.window, pane: Number(id) }]);
      }
    }
    for (const [name, ctx] of fire) await this.fireHook(name, ctx);
  }

  // ----------------------------------------------------------------- shell

  /**
   * Run a shell command string with the built-in shell subset (src/core/shell.js).
   * Resolves to { code, out } or null when the command is outside the subset.
   */
  async shell(src, ctx = {}) {
    const paneId = ctx.pane ?? this.server.window?.active;
    const env = {
      TMUX: '/tmp/tmux-chrome/default,1,0', TMUX_PANE: paneId != null ? '%' + paneId : '',
      TERM: this.getOption('default-terminal') || 'tmux-256color', SHELL: '/bin/sh', ...this.env,
    };
    const host = {
      env,
      platform: this.platform,
      version: VERSION,
      note: (msg) => this.notice(msg, { source: ctx.source, line: ctx.line, level: 'info', key: 'sh:' + msg }),
      tmux: async (argv) => {
        let text = '';
        const print = (line) => { text += String(line) + '\n'; };
        try {
          const r = await this.execute(argv, { ...ctx, print, fromShell: true });
          return { code: r === false ? 1 : 0, out: text };
        } catch (err) {
          return { code: 1, out: text, err: String(err.message || err) };
        }
      },
    };
    try {
      return await new Shell(host).run(src);
    } catch (err) {
      if (err instanceof Unsupported) {
        this.log(`shell: ${err.message} in: ${src}`, 'info');
        return null;
      }
      throw err;
    }
  }

  /** Emit lines: to the calling shell (`tmux show ...` inside run-shell) or a list overlay. */
  output(ctx, lines, title) {
    if (ctx?.print) { lines.forEach((l) => ctx.print(l)); return; }
    this.ui.showList({ title, lines });
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
      if (marked != null && panesInOrder(w.layout).includes(marked)) f += 'M';
      if (w.zoomed) f += 'Z';
      return f;
    };
    const marked = srv.markedPane();
    let geo = null;
    const rects = () => {
      if (geo) return geo;
      const g = this.ui.geometry?.() || { rect: { x: 0, y: 0, w: 1600, h: 900 }, gap: 1, cell: { w: 8, h: 17 } };
      const cw = g.cell?.w || 8, ch = g.cell?.h || 17;
      const r = window ? (window.zoomed ? { panes: { [window.active]: g.rect } } : computeRects(window.layout, g.rect, g.gap)) : { panes: {} };
      geo = { g, cw, ch, panes: r.panes };
      return geo;
    };
    const paneRect = () => (paneId != null ? rects().panes[paneId] : null);
    const cells = (px, c) => String(Math.max(1, Math.round(px / c)));
    const urlPath = (p) => (p ? (p.kind === 'web' ? p.url : p.prefill || '') : '');
    const fn = (name) => {
      if (name.startsWith('#(')) {
        const cmd = name.slice(2, -1);
        for (const [re, fn] of this.shellVars) if (re.test(cmd)) return fn(cmd);
        this.notice(`#(${cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd}) — shell commands can't run in the browser`, { level: 'info', key: 'shell:' + cmd });
        return '';
      }
      if (this.formatVars.has(name)) return this.formatVars.get(name)(ctx);
      if (name[0] === '@') return this.options[name];
      if (name.startsWith('hook')) {
        const h = this.hookInfo;
        switch (name) {
          case 'hook': return h?.hook ?? '';
          case 'hook_session': return h?.session ? '$' + h.session.id : '';
          case 'hook_session_name': return h?.session?.name ?? '';
          case 'hook_window': return h?.window ? '@' + h.window.id : '';
          case 'hook_window_name': return h?.window ? srv.windowName(h.window) : '';
          case 'hook_pane': return h?.pane != null ? '%' + h.pane : '';
          case 'hook_client': return h ? 'chrome' : '';
        }
      }
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
        case 'pane_width': { const r = paneRect(); return r ? cells(r.w, rects().cw) : ''; }
        case 'pane_height': { const r = paneRect(); return r ? cells(r.h, rects().ch) : ''; }
        case 'pane_left': { const r = paneRect(); return r ? String(Math.round((r.x - rects().g.rect.x) / rects().cw)) : ''; }
        case 'pane_top': { const r = paneRect(); return r ? String(Math.round((r.y - rects().g.rect.y) / rects().ch)) : ''; }
        case 'pane_right': { const r = paneRect(); return r ? String(Math.round((r.x + r.w - rects().g.rect.x) / rects().cw) - 1) : ''; }
        case 'pane_bottom': { const r = paneRect(); return r ? String(Math.round((r.y + r.h - rects().g.rect.y) / rects().ch) - 1) : ''; }
        case 'pane_at_left': case 'pane_at_right': case 'pane_at_top': case 'pane_at_bottom': {
          const r = paneRect();
          if (!r) return '';
          const a = rects().g.rect, tol = 2;
          const at = { pane_at_left: r.x - a.x <= tol, pane_at_top: r.y - a.y <= tol,
            pane_at_right: a.x + a.w - (r.x + r.w) <= tol, pane_at_bottom: a.y + a.h - (r.y + r.h) <= tol }[name];
          return at ? '1' : '0';
        }
        case 'window_width': case 'client_width': return cells(rects().g.rect.w, rects().cw);
        case 'window_height': case 'client_height': return cells(rects().g.rect.h, rects().ch);
        case 'pane_marked': return paneId != null && paneId === marked ? '1' : '0';
        case 'pane_marked_set': return marked != null ? '1' : '0';
        case 'window_marked_flag': return window && marked != null && panesInOrder(window.layout).includes(marked) ? '1' : '0';
        case 'pane_synchronized': return this.getOption('synchronize-panes') === 'on' ? '1' : '0';
        case 'pane_start_command': return pane?.kind === 'web' ? pane.url : '';
        case 'pane_start_path': return urlPath(pane);
        case 'pane_format': return ctx.loop === 'P' ? '1' : '0';
        case 'window_format': return ctx.loop === 'W' ? '1' : '0';
        case 'session_format': return ctx.loop === 'S' ? '1' : '0';
        case 'window_visible_layout': return window?.layoutName || '';
        case 'window_offset_x': case 'window_offset_y': return '0';
        case 'window_activity': case 'session_activity': case 'client_activity': case 'session_last_attached':
        case 'client_created': return String(Math.floor(Date.now() / 1000));
        case 'window_linked': return '0';
        case 'window_stack_index': return window && session ? String(Math.max(0, srv.sortedWindows(session).indexOf(window))) : '';
        case 'session_path': return '';
        case 'session_stack': return session ? String(session.id) : '';
        case 'server_sessions': return String(srv.sessions.length);
        case 'client_name': return 'chrome';
        case 'client_tty': return '';
        case 'client_pid': return '';
        case 'client_readonly': return '0';
        case 'client_utf8': return '1';
        case 'client_flags': return 'attached,focused,UTF-8';
        case 'client_last_session': return srv.sessionById(srv.lastSessionId)?.name ?? '';
        case 'cursor_x': case 'cursor_y': case 'scroll_position': case 'history_size': case 'history_bytes': return '0';
        case 'history_limit': return this.getOption('history-limit');
        case 'config_files': return '~/.tmux.conf';
        case 'buffer_name': return this.buffers[0]?.name ?? '';
        case 'buffer_size': return this.buffers[0] ? String(this.buffers[0].data.length) : '';
        case 'buffer_sample': return this.buffers[0]?.data.slice(0, 50) ?? '';
        case 'client_prefix': return this.clientPrefix ? '1' : '0';
        case 'client_key_table': return this.keyTable;
        case 'client_session': return srv.session?.name;
        case 'client_termname': return 'chrome';
        case 'host': return 'chrome';
        case 'host_short': return 'chrome';
        case 'version': return VERSION;
        case 'pid': return '';
        case 'socket_path': return '';
        case 'start_time': return Math.floor(srv.created / 1000);
        case 'mouse_any_flag': return '0';
        case 'alternate_on': return '0';
        case 'cursor_flag': return '1';
      }
      if (Object.prototype.hasOwnProperty.call(this.env, name)) return this.env[name];
      // Any option can be used as a format variable: #{status-left-length}, #{base-index}.
      if (name in this.options) return this.options[name];
      return undefined;
    };
    // Loops (#{S:...} / #{W:...} / #{P:...}) and existence tests (#{N/w:name}).
    fn.loop = (kind, flags = '') => {
      const items = [];
      if (kind === 'S' || kind === 'L') {
        let list = kind === 'L' ? [srv.session].filter(Boolean) : srv.sessions.slice();
        if (flags.includes('n')) list.sort((a, b) => a.name.localeCompare(b.name));
        else list.sort((a, b) => a.id - b.id);
        for (const s of list) items.push({ lookup: this.lookup({ session: s, loop: 'S' }), current: s === srv.session });
      } else if (kind === 'W') {
        if (!session) return [];
        let list = srv.sortedWindows(session);
        if (flags.includes('n')) list.sort((a, b) => srv.windowName(a).localeCompare(srv.windowName(b)));
        for (const w of list) items.push({ lookup: this.lookup({ session, window: w, loop: 'W' }), current: w.id === session.active });
      } else if (kind === 'P') {
        if (!window) return [];
        for (const id of panesInOrder(window.layout)) items.push({ lookup: this.lookup({ session, window, pane: id, loop: 'P' }), current: id === window.active });
      }
      if (flags.includes('r')) items.reverse();
      return items;
    };
    fn.exists = (kind, nm) => {
      if (kind === 's') return !!srv.sessionByName(nm);
      return !!(session && session.windows.some((w) => srv.windowName(w) === nm));
    };
    return fn;
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

/** The tmux version this emulates (`#{version}`, `tmux -V`). */
export const VERSION = '3.4';

function guessPlatform() {
  const p = String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '');
  if (/mac/i.test(p)) return 'Darwin';
  if (/win/i.test(p)) return 'MINGW64_NT';
  return 'Linux';
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

export { COMMANDS, toCommandList, ARRAY_OPTIONS, EVENT_HOOKS };
