// tmux command implementations. Each entry: { name, alias, flags, run(t, f, a, ctx) }
// where `t` is the Tmux engine, `f` parsed flags, `a` positional args and
// `ctx` the command context ({ source, line, fromConfig, fromKey, pane, ... }).

import * as L from './layout.js';
import { resolveTarget } from './target.js';
import { toCommandList, argToString, quoteArg, formatCommandList } from './parser.js';
import { DEFAULT_OPTIONS, FLAG_OPTIONS, ARRAY_OPTIONS, EVENT_HOOKS as EVENT_HOOK_NAMES, KNOWN_UNFIRED_HOOKS } from './defaults.js';
import { paneShortName } from './server.js';

export const COMMANDS = new Map();
const ALIASES = new Map();

export function registerCommand(def) {
  COMMANDS.set(def.name, def);
  for (const a of [].concat(def.alias || [])) ALIASES.set(a, def.name);
}

export function resolveCommand(name) {
  if (COMMANDS.has(name)) return COMMANDS.get(name);
  if (ALIASES.has(name)) return COMMANDS.get(ALIASES.get(name));
  // tmux accepts unambiguous prefixes of command names.
  const matches = [...COMMANDS.keys()].filter((n) => n.startsWith(name));
  return matches.length === 1 ? COMMANDS.get(matches[0]) : null;
}

const def = (name, alias, flags, run) => registerCommand({ name, alias, flags, run });

// ------------------------------------------------------------------ helpers

function target(t, spec, kind, ctx) {
  const r = resolveTarget(t.server, spec, kind, ctx, t.ui.geometry());
  if (!r) throw new Error(`can't find ${kind}: ${spec}`);
  return r;
}

const truthyFmt = (v) => v !== '' && v !== '0';

const isFlag = (v) => ['on', 'yes', '1', 'true'].includes(String(v).toLowerCase());

/** Interpret what would be a shell command / start directory as something to open. */
export function toUrl(input, searchUrl = DEFAULT_OPTIONS['@ctmux-search-url']) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^javascript:/i.test(s)) return '';
  if (/^(https?|file|ftp|data|about|chrome-extension|view-source):/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (s.startsWith('/') ) return 'file://' + s;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(s)) return 'http://' + s;
  if (!/\s/.test(s) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return 'https://' + s;
  return searchUrl.replace('%s', encodeURIComponent(s));
}

const looksLikeUrl = (s) => {
  s = String(s || '').trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(s) || (!/\s/.test(s) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) || /^localhost(:\d+)?/.test(s);
};

/** New pane contents from a shell-command argument and -c start directory. */
function paneSpec(t, cmd, startDir, ctx) {
  const search = t.getOption('@ctmux-search-url');
  if (cmd) {
    return looksLikeUrl(cmd) ? { url: toUrl(cmd, search) } : { prefill: String(cmd) };
  }
  const dc = t.getOption('default-command');
  if (dc && looksLikeUrl(dc)) return { url: toUrl(dc, search) };
  if (startDir) {
    const dir = t.expandPlain(startDir, ctx);
    return { prefill: dir };
  }
  return {};
}

function sizeFraction(t, spec, totalPx, cellPx) {
  if (spec == null) return null;
  const s = String(spec);
  if (s.endsWith('%')) return Number(s.slice(0, -1)) / 100;
  const n = Number(s);
  if (!Number.isFinite(n) || totalPx <= 0) return null;
  return (n * cellPx) / totalPx;
}

function paneRects(t, window) {
  const g = t.ui.geometry();
  return { ...L.computeRects(window.layout, g.rect, g.gap), geo: g };
}

function selectPane(t, session, window, paneId) {
  t.server.switchTo(session);
  t.server.selectWindow(session, window);
  t.server.selectPane(window, paneId);
  t.ui.focusPane?.(paneId);
}

function templateReplace(template, value, idx) {
  const quoted = String(value).replace(/(["\\$;~])/g, '\\$1');
  return template
    .replace(/%%%/g, quoted)
    .replace(new RegExp(`%${idx}`, 'g'), value)
    .replace(/%%/g, value);
}

function splitList(s) {
  return s == null ? [] : String(s).split(',');
}

function asCommandString(a) {
  return a.map((x) => (typeof x === 'string' ? (a.length > 1 ? quoteArg(x) : x) : argToString(x))).join(' ');
}

// ------------------------------------------------------------- options

function setOptionCmd(t, f, a, ctx) {
  let [name, value] = a.map((x) => argToString(x));
  if (!name) throw new Error('missing option name');
  const origin = ctx.origin || 'user';

  // Deprecated tmux < 2.9 colour options: status-bg, pane-border-fg, ...
  const dep = /^(.*)-(fg|bg|attr)$/.exec(name);
  if (dep && `${dep[1]}-style` in DEFAULT_OPTIONS && !(name in DEFAULT_OPTIONS)) {
    const styleName = `${dep[1]}-style`;
    const part = dep[2] === 'attr' ? value : `${dep[2]}=${value}`;
    const cur = t.getOption(styleName);
    t.setOption(styleName, cur && cur !== 'default' ? `${cur},${part}` : part, origin);
    return;
  }
  // Array options: command-alias[N], terminal-overrides, status-format[N], ...
  const arr = /^(.+?)(?:\[(\d+)\])?$/.exec(name);
  if (arr && arr[1] in ARRAY_OPTIONS) return setArrayOption(t, f, arr[1], arr[2], value, origin);
  // message-command-fg etc. map onto *-style too.
  if (f.u || f.U) {
    if (name in DEFAULT_OPTIONS) t.setOption(name, DEFAULT_OPTIONS[name], 'default');
    else delete t.options[name];
    return;
  }
  if (!t.isKnownOption(name)) {
    if (!f.q) t.notice(`unknown option: ${name}`, { source: ctx.source, line: ctx.line });
  }
  if (f.o && name in t.options && t.optionOrigins[name] === 'user') return;
  if (value === undefined) {
    if (FLAG_OPTIONS.has(name)) value = t.getOption(name) === 'on' ? 'off' : 'on';
    else if (name[0] !== '@') throw new Error(`${name}: missing value`);
    else value = '';
  }
  if (FLAG_OPTIONS.has(name)) value = isFlag(value) ? 'on' : value === 'toggle' ? (t.getOption(name) === 'on' ? 'off' : 'on') : 'off';
  if (f.F) value = t.expandPlain(value, ctx);
  if (f.a) value = t.getOption(name) + value;
  t.setOption(name, value, origin);
  if (name === '@plugin' || name === '@tpm_plugins') t.plugins?.declare(value, ctx, name === '@tpm_plugins');
  t.ui.optionChanged?.(name);
}

function setArrayOption(t, f, base, index, value, origin) {
  const keys = () => t.arrayOption(base).map(([i]) => `${base}[${i}]`);
  if (f.u || f.U) {
    if (index != null) { delete t.options[`${base}[${index}]`]; return; }
    keys().forEach((k) => delete t.options[k]);
    for (const [k, v] of Object.entries(DEFAULT_OPTIONS)) if (k.startsWith(base + '[')) t.setOption(k, v, 'default');
    return;
  }
  if (value === undefined) throw new Error(`${base}: missing value`);
  if (f.F) value = t.expandPlain(value);
  if (index != null) {
    const k = `${base}[${index}]`;
    if (f.o && k in t.options) return;
    t.setOption(k, f.a ? (t.options[k] ?? '') + value : value, origin);
  } else {
    const sep = ARRAY_OPTIONS[base];
    const items = sep == null ? [value] : value.split(sep === ' ' ? /\s+/ : sep).filter((x) => x !== '');
    if (!f.a) keys().forEach((k) => delete t.options[k]);
    let next = t.arrayOption(base).reduce((m, [i]) => Math.max(m, i + 1), 0);
    for (const item of items) t.setOption(`${base}[${next++}]`, item, origin);
  }
  t.ui.optionChanged?.(base);
}

def('set-option', 'set', 'aFgopqst:uUw', setOptionCmd);
def('set-window-option', 'setw', 'aFgoqt:uU', setOptionCmd);

def('show-options', ['show', 'show-window-options', 'showw'], 'AgHpqst:vw', (t, f, a, ctx) => {
  const want = a.length ? argToString(a[0]) : null;
  let names = Object.keys(t.options).sort();
  if (want != null) {
    names = want in ARRAY_OPTIONS && !(want in t.options)
      ? t.arrayOption(want).map(([i]) => `${want}[${i}]`)
      : [want].filter((n) => n in t.options);
    if (!names.length && !f.q) throw new Error(`invalid option: ${want}`);
  }
  const lines = names.map((n) => (f.v ? t.options[n] : `${n} ${quoteArg(t.options[n])}`));
  if (ctx.print) { lines.forEach((l) => ctx.print(l)); return; }
  if (want != null) { if (lines.length) t.ui.message(lines.join(' ')); return; }
  t.ui.showList({ title: 'show-options', lines });
});

def('set-environment', 'setenv', 'Fhgrt:u', (t, f, a) => {
  const [name, value] = a.map(argToString);
  if (!name) throw new Error('missing name');
  if (f.u || f.r) delete t.env[name];
  else t.env[name] = f.F ? t.expandPlain(value ?? '') : value ?? '';
});

def('show-environment', 'showenv', 'hgst:', (t, f, a, ctx) => {
  const want = a.length ? argToString(a[0]) : null;
  if (want != null && !(want in t.env)) throw new Error(`unknown variable: ${want}`);
  const entries = want != null ? [[want, t.env[want]]] : Object.entries(t.env);
  t.output(ctx, entries.map(([k, v]) => `${k}=${v}`), 'show-environment');
});

def('set-hook', null, 'agpRt:uw', async (t, f, a, ctx) => {
  const [rawName, ...rest] = a;
  if (rawName == null) throw new Error('missing hook name');
  const m = /^(.+?)(?:\[(\d+)\])?$/.exec(argToString(rawName));
  const name = m[1];
  const index = m[2] != null ? Number(m[2]) : null;
  if (!/^after-/.test(name) && !EVENT_HOOK_NAMES.has(name)) {
    if (!KNOWN_UNFIRED_HOOKS.has(name)) throw new Error(`invalid hook: ${name}`);
    t.notice(`set-hook ${name}: this event never happens in the browser, so the hook won't run`, { source: ctx.source, line: ctx.line, level: 'info', key: 'hook:' + name });
  }
  if (f.R) { await t.fireHook(name, ctx); return; }
  const list = (t.hooks[name] ||= []);
  if (f.u) {
    if (index != null) delete list[index];
    else delete t.hooks[name];
    return;
  }
  if (!rest.length) throw new Error('missing command');
  const commands = toCommandList(rest.length === 1 ? rest[0] : rest, t.env);
  if (index != null) list[index] = commands;
  else if (f.a) list[list.length] = commands;
  else { list.length = 0; list[0] = commands; }
});

def('show-hooks', null, 'gpt:w', (t, f, a, ctx) => {
  const want = a.length ? argToString(a[0]) : null;
  const lines = [];
  for (const name of Object.keys(t.hooks).sort()) {
    if (want && name !== want) continue;
    t.hooks[name].forEach((cmds, i) => { if (cmds) lines.push(`${name}[${i}] ${formatCommandList(cmds)}`); });
  }
  t.output(ctx, lines, 'show-hooks');
});

// ---------------------------------------------------------- key bindings

def('bind-key', 'bind', 'nrN:T:', (t, f, a, ctx) => {
  const [key, ...cmd] = a;
  if (key == null) throw new Error('missing key');
  if (!cmd.length) throw new Error('missing command');
  const table = f.n ? 'root' : f.T || 'prefix';
  const keyStr = argToString(key);
  if (/^(Mouse|Wheel|Double|Triple|SecondClick)/.test(keyStr)) {
    t.notice(`mouse binding ${keyStr} in ${table}: mouse handling is native in the browser`, { source: ctx.source, line: ctx.line, level: 'info', key: 'mouse-bind' });
  }
  const commands = toCommandList(cmd.length === 1 ? cmd[0] : cmd, t.env);
  const k = t.bind(table, keyStr, commands, { repeat: !!f.r, note: f.N || '', origin: ctx.origin || 'user' });
  if (!k) throw new Error(`unknown key: ${keyStr}`);
  t.ui.keysChanged?.();
});

def('unbind-key', 'unbind', 'anqT:', (t, f, a) => {
  const table = f.n ? 'root' : f.T || 'prefix';
  if (f.a) t.table(table).clear();
  else if (a.length) t.unbind(table, argToString(a[0]));
  t.ui.keysChanged?.();
});

def('list-keys', 'lsk', '1aNP:T:', (t, f, a, ctx) => {
  const lines = [];
  const tables = f.T ? [f.T] : [...t.tables.keys()].sort((x, y) => (x === 'prefix' ? -1 : y === 'prefix' ? 1 : x.localeCompare(y)));
  const prefix = t.getOption('prefix');
  for (const name of tables) {
    const map = t.tables.get(name);
    if (!map) continue;
    for (const b of [...map.values()].sort((x, y) => x.key.localeCompare(y.key))) {
      if (a.length && b.key !== a[0]) continue;
      if (f.N) {
        if (!b.note) continue;
        const k = name === 'prefix' ? `${prefix} ${b.key}` : name === 'root' ? b.key : `${name}: ${b.key}`;
        lines.push(`${k.padEnd(16)} ${b.note}`);
      } else {
        lines.push(t.describeBinding(name, b));
      }
    }
  }
  if (ctx.print) { lines.forEach((l) => ctx.print(l)); return; }
  t.ui.showList({ title: f.N ? 'Key bindings' : 'list-keys', lines, filterable: true });
});

def('switch-client', 'switchc', 'cEFlnpt:rT:Z', (t, f, a, ctx) => {
  if (f.T) { t.keyTable = f.T; t.ui.setKeyTable?.(f.T); return; }
  const srv = t.server;
  const list = srv.sessions.slice().sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
  let s;
  if (f.l) s = srv.sessionById(srv.lastSessionId);
  else if (f.n || f.p) {
    const i = list.indexOf(srv.session);
    s = list[(i + (f.n ? 1 : -1) + list.length) % list.length];
  } else if (f.t) {
    const r = target(t, f.t, 'session', ctx);
    s = r.session;
    if (r.window) srv.selectWindow(s, r.window);
    if (r.window && r.pane != null) srv.selectPane(r.window, r.pane);
  }
  if (!s) { if (f.l) t.ui.message('no last session'); return; }
  srv.switchTo(s);
  t.ui.focusPane?.();
});

// ---------------------------------------------------------- config / shell

def('source-file', 'source', 'Fnqv', async (t, f, a, ctx) => {
  for (const raw of a) {
    let path = argToString(raw);
    if (f.F) path = t.expandPlain(path, ctx);
    let text;
    try {
      text = await t.loadFile(path);
    } catch (err) {
      if (!f.q) throw new Error(`${path}: ${err.message || err}`);
      continue;
    }
    if (f.n) continue; // parse only
    await t.runConfig(text, { source: path, origin: 'user', depth: (ctx.depth || 0) + 1 });
    if (!ctx.fromConfig) t.ui.configReloaded?.(path);
  }
});

def('run-shell', 'run', 'bCd:t:Es:c:', async (t, f, a, ctx) => {
  let cmd = argToString(a[0] ?? '');
  if (f.C) return t.runString(cmd, ctx);
  if (f.d != null) { const ms = Number(f.d) * 1000; if (ms > 0 && !ctx.fromConfig) await new Promise((r) => setTimeout(r, Math.min(ms, 10000))); }
  if (!cmd) return;
  if (await t.plugins?.handleRun(cmd, ctx)) return;
  cmd = t.expandPlain(cmd, ctx);
  const r = await t.shell(cmd, ctx);
  if (!r) {
    t.notice(`run-shell "${short(cmd)}": shell commands can't run in the browser`, { source: ctx.source, line: ctx.line, level: 'info' });
    return;
  }
  const out = r.out.replace(/\n$/, '');
  if (out) {
    if (ctx.print) out.split('\n').forEach((l) => ctx.print(l));
    else if (ctx.fromConfig) t.log(`run-shell: ${out}`);
    else if (!f.b) t.ui.showList({ title: 'run-shell', lines: out.split('\n') });
  }
  if (r.code !== 0 && !ctx.fromConfig && !f.b) t.ui.message(`'${short(cmd)}' returned ${r.code}`);
});

const short = (c) => (c.length > 50 ? c.slice(0, 47) + '...' : c);

def('if-shell', 'if', 'bFt:', async (t, f, a, ctx) => {
  const [cond, then, otherwise] = a;
  let ok;
  if (f.F) {
    const v = t.expandPlain(argToString(cond), ctx);
    ok = v !== '' && v !== '0';
  } else {
    const c = t.expandPlain(argToString(cond), ctx);
    const r = await t.shell(c, ctx);
    if (r) ok = r.code === 0;
    else {
      ok = false;
      t.notice(`if-shell "${short(c)}": shell condition treated as false`, {
        source: ctx.source, line: ctx.line, level: 'info', key: 'if-shell:' + c,
      });
    }
  }
  const branch = ok ? then : otherwise;
  if (branch == null) return;
  await t.runList(toCommandList(branch, t.env), ctx);
});

// -------------------------------------------------------------- windows

def('new-window', 'neww', 'abc:de:F:kn:Pt:S', (t, f, a, ctx) => {
  const srv = t.server;
  let session = srv.session;
  let index;
  if (f.t) {
    const spec = String(f.t);
    const m = /^(?:([^:]*):)?=?(\d+)$/.exec(spec);
    if (m) {
      session = m[1] ? target(t, m[1], 'session', ctx).session : session;
      index = Number(m[2]);
      const existing = session.windows.find((w) => w.index === index);
      if (existing && f.k) srv.killWindow(session, existing);
      else if (existing && !f.a && !f.b) throw new Error(`index ${index} in use`);
    } else {
      session = target(t, spec, 'session', ctx).session;
    }
  }
  if (!session) session = srv.newSession({});
  const spec = paneSpec(t, a.length ? asCommandString(a) : '', f.c, ctx);
  const w = srv.newWindow(session, { ...spec, name: f.n, index, after: !!f.a, select: !f.d });
  if (!f.d) srv.switchTo(session);
  if (f.P) t.ui.message(t.expandPlain(f.F || '#{session_name}:#{window_index}.#{pane_index}', { session, window: w }));
  if (!f.d) t.ui.focusPane?.(w.active);
});

def('select-window', 'selectw', 'lnpTt:', (t, f, a, ctx) => {
  const srv = t.server;
  if (f.l) return COMMANDS.get('last-window').run(t, {}, [], ctx);
  if (f.n) return COMMANDS.get('next-window').run(t, {}, [], ctx);
  if (f.p) return COMMANDS.get('previous-window').run(t, {}, [], ctx);
  const r = target(t, f.t, 'window', ctx);
  if (f.T && r.window.id === r.session.active) return COMMANDS.get('last-window').run(t, {}, [], ctx);
  srv.switchTo(r.session);
  srv.selectWindow(r.session, r.window);
  t.ui.focusPane?.();
});

function cycleWindow(t, delta) {
  const srv = t.server;
  const s = srv.session;
  if (!s) return;
  const sorted = srv.sortedWindows(s);
  if (sorted.length < 2) return;
  const i = sorted.findIndex((w) => w.id === s.active);
  srv.selectWindow(s, sorted[(i + delta + sorted.length) % sorted.length]);
  t.ui.focusPane?.();
}

def('next-window', 'next', 'at:', (t, f) => { if (f.a) { t.ui.message('No next window with alert'); return; } cycleWindow(t, 1); });
def('previous-window', 'prev', 'at:', (t, f) => { if (f.a) { t.ui.message('No previous window with alert'); return; } cycleWindow(t, -1); });

def('last-window', 'last', 't:', (t) => {
  const s = t.server.session;
  const w = s && s.windows.find((x) => x.id === s.last);
  if (!w) { t.ui.message('No last window'); return; }
  t.server.selectWindow(s, w);
  t.ui.focusPane?.();
});

def('rename-window', 'renamew', 't:', (t, f, a, ctx) => {
  const r = target(t, f.t, 'window', ctx);
  r.window.name = argToString(a[0] ?? '');
  r.window.manualName = true;
});

def('kill-window', 'killw', 'at:', (t, f, a, ctx) => {
  const r = target(t, f.t, 'window', ctx);
  if (f.a) {
    for (const w of r.session.windows.slice()) if (w !== r.window) t.server.killWindow(r.session, w);
  } else {
    t.server.killWindow(r.session, r.window);
  }
  t.ui.serverEmpty?.();
  t.ui.focusPane?.();
});

def('swap-window', 'swapw', 'ds:t:', (t, f, a, ctx) => {
  const src = target(t, f.s ?? (t.server.markedPane() != null ? '{marked}' : undefined), 'window', ctx);
  const dst = target(t, f.t, 'window', ctx);
  if (src.window === dst.window) return;
  if (src.session !== dst.session) throw new Error('windows must be in the same session');
  t.server.swapWindows(src.session, src.window, dst.window);
  if (!f.d) t.server.selectWindow(dst.session, src.window);
});

def('move-window', ['movew', 'link-window', 'linkw'], 'abdkrs:t:', (t, f, a, ctx) => {
  const srv = t.server;
  if (f.r) { srv.renumber(target(t, f.t, 'session', ctx).session); return; }
  const src = target(t, f.s, 'window', ctx);
  const spec = String(f.t ?? '');
  const m = /^(?:([^:]*):)?=?(\d*)$/.exec(spec);
  if (!m) throw new Error(`bad target: ${spec}`);
  const dstSession = m[1] ? target(t, m[1], 'session', ctx).session : src.session;
  let index = m[2] === '' ? srv.freeIndex(dstSession) : Number(m[2]);
  if (f.a) index = src.window.index + 1;
  const existing = dstSession.windows.find((w) => w.index === index && w !== src.window);
  if (existing && f.k) srv.killWindow(dstSession, existing);
  else if (existing && !f.a && !f.b) throw new Error(`index ${index} in use`);
  srv.moveWindow(src.session, src.window, index, dstSession);
  if (!f.d) { srv.switchTo(dstSession); srv.selectWindow(dstSession, src.window); }
});

def('rotate-window', 'rotatew', 'DUt:Z', (t, f, a, ctx) => {
  const r = target(t, f.t, 'window', ctx);
  r.window.layout = L.rotate(r.window.layout, !!f.U);
});

const layoutMain = (t, window) => {
  const g = t.ui.geometry();
  const frac = (opt, total, cell) => {
    const v = String(t.getOption(opt));
    if (v.endsWith('%')) return Number(v.slice(0, -1)) / 100;
    const px = Number(v) * cell;
    return Math.min(0.8, Math.max(0.2, px / total || 0.6));
  };
  return { h: frac('main-pane-height', g.rect.h, g.cell.h), v: frac('main-pane-width', g.rect.w, g.cell.w) };
};

function applyLayout(t, window, name) {
  const ids = L.panesInOrder(window.layout);
  const main = layoutMain(t, window);
  const tree = L.presetLayout(name, ids, name.startsWith('main-horizontal') ? main.h : main.v);
  if (!tree) throw new Error(`unknown layout: ${name}`);
  window.prevLayout = window.layout;
  window.layout = tree;
  window.layoutName = name;
  window.zoomed = false;
}

def('select-layout', 'selectl', 'Enopt:', (t, f, a, ctx) => {
  const r = target(t, f.t, 'window', ctx);
  const w = r.window;
  if (f.o) { if (w.prevLayout) [w.layout, w.prevLayout] = [w.prevLayout, w.layout]; return; }
  if (f.E) { w.prevLayout = w.layout; w.layout = L.spread(w.layout); return; }
  if (f.n || f.p) {
    const i = L.LAYOUTS.indexOf(w.layoutName);
    const n = L.LAYOUTS.length;
    return applyLayout(t, w, L.LAYOUTS[(i + (f.n ? 1 : n - 1) + (i === -1 && f.p ? 1 : 0)) % n]);
  }
  const name = argToString(a[0] ?? w.layoutName ?? '');
  if (!name) return;
  const full = L.LAYOUTS.find((l) => l === name) || L.LAYOUTS.find((l) => l.startsWith(name)) ||
    (/^main-(horizontal|vertical)-mirrored$/.test(name) ? name : null);
  if (!full) throw new Error(`unknown layout or too many panes: ${name}`);
  applyLayout(t, w, full);
});

def('next-layout', 'nextl', 't:', (t, f, a, ctx) => {
  const w = target(t, f.t, 'window', ctx).window;
  const i = L.LAYOUTS.indexOf(w.layoutName);
  applyLayout(t, w, L.LAYOUTS[(i + 1) % L.LAYOUTS.length]);
});

def('previous-layout', 'prevl', 't:', (t, f, a, ctx) => {
  const w = target(t, f.t, 'window', ctx).window;
  const i = L.LAYOUTS.indexOf(w.layoutName);
  applyLayout(t, w, L.LAYOUTS[(i - 1 + L.LAYOUTS.length * 2) % L.LAYOUTS.length]);
});

def('find-window', 'findw', 'CiNrTt:Z', (t, f, a) => {
  const needle = argToString(a[0] ?? '');
  const test = (s) => (f.i ? String(s).toLowerCase().includes(needle.toLowerCase()) : String(s).includes(needle));
  const srv = t.server;
  const hits = [];
  for (const s of srv.sessions) {
    for (const w of s.windows) {
      for (const id of L.panesInOrder(w.layout)) {
        const p = srv.panes[id];
        const byName = !f.T && !f.C ? test(srv.windowName(w)) : f.N && test(srv.windowName(w));
        const byTitle = (!f.N && !f.C) || f.T ? test(p.title) || test(p.url) : false;
        const byContent = f.C ? test(p.url) : false;
        if (byName || byTitle || byContent) hits.push({ s, w, id });
      }
    }
  }
  if (!hits.length) { t.ui.message(`No windows matching: ${needle}`); return; }
  if (hits.length === 1) { selectPane(t, hits[0].s, hits[0].w, hits[0].id); return; }
  t.ui.chooseTree({ mode: 'tree', filter: needle, zoom: !!f.Z });
});

// ---------------------------------------------------------------- panes

def('split-window', 'splitw', 'bc:de:fF:hIl:p:Pt:vZ', (t, f, a, ctx) => {
  const r = target(t, f.t, 'pane', ctx);
  const dir = f.h ? 'h' : 'v';
  const { panes, geo } = paneRects(t, r.window);
  const pr = f.f ? geo.rect : panes[r.pane] || geo.rect;
  const total = dir === 'h' ? pr.w : pr.h;
  const cell = dir === 'h' ? geo.cell.w : geo.cell.h;
  const size = f.p != null ? Number(f.p) / 100 : sizeFraction(t, f.l, total, cell);
  const spec = paneSpec(t, a.length ? asCommandString(a) : '', f.c, { ...ctx, pane: r.pane, window: r.window, session: r.session });
  const p = t.server.splitPane(r.window, r.pane, dir, { ...spec, before: !!f.b, full: !!f.f, size: size ?? undefined, select: !f.d });
  if (f.P) t.ui.message(t.expandPlain(f.F || '#{session_name}:#{window_index}.#{pane_index}', { session: r.session, window: r.window, pane: p.id }));
  if (!f.d) t.ui.focusPane?.(p.id);
});

def('select-pane', 'selectp', 'DdegLlMmP:RT:t:UZ', (t, f, a, ctx) => {
  const srv = t.server;
  if (f.l) return COMMANDS.get('last-pane').run(t, f, a, ctx);
  const r = target(t, f.t, 'pane', ctx);
  if (f.T != null) {
    const p = srv.panes[r.pane];
    p.title = f.T;
    p.manualTitle = true;
    return;
  }
  if (f.M) { srv.marked = null; t.ui.render?.(); return; }
  if (f.m) {
    srv.marked = srv.markedPane() === r.pane ? null : r.pane;
    t.ui.render?.();
    return;
  }
  if (f.e || f.d || f.P || f.g) return; // input / style: not applicable
  const dir = f.L ? 'L' : f.R ? 'R' : f.U ? 'U' : f.D ? 'D' : null;
  if (dir) {
    const w = r.window;
    if (w.zoomed && !f.Z) w.zoomed = false;
    const { panes } = paneRects(t, w);
    const n = L.neighbour(panes, r.pane, dir, true);
    if (n == null) return;
    const keepZoom = f.Z && w.zoomed;
    selectPane(t, r.session, w, n);
    if (keepZoom) w.zoomed = true;
    return;
  }
  selectPane(t, r.session, r.window, r.pane);
});

def('last-pane', 'lastp', 'det:Z', (t, f, a, ctx) => {
  const r = target(t, f.t, 'window', ctx);
  const w = r.window;
  if (w.last == null || !L.findPath(w.layout, w.last)) { t.ui.message('No last pane'); return; }
  selectPane(t, r.session, w, w.last);
});

def('kill-pane', 'killp', 'at:', (t, f, a, ctx) => {
  const r = target(t, f.t, 'pane', ctx);
  if (f.a) {
    for (const id of L.panesInOrder(r.window.layout)) if (id !== r.pane) t.server.killPane(id);
  } else {
    t.server.killPane(r.pane);
  }
  t.ui.serverEmpty?.();
  t.ui.focusPane?.();
});

def('resize-pane', 'resizep', 'DLMRTt:Ux:y:Z', (t, f, a, ctx) => {
  const r = target(t, f.t, 'pane', ctx);
  const w = r.window;
  if (f.Z) {
    if (L.panesInOrder(w.layout).length > 1) {
      w.zoomed = !(w.zoomed && w.active === r.pane);
      if (w.zoomed) w.active = r.pane;
    }
    return;
  }
  const g = t.ui.geometry();
  if (f.x != null || f.y != null) {
    for (const axis of ['x', 'y']) {
      if (f[axis] == null) continue;
      const v = String(f[axis]);
      const total = axis === 'x' ? g.rect.w : g.rect.h;
      const px = v.endsWith('%') ? (Number(v.slice(0, -1)) / 100) * total : Number(v) * (axis === 'x' ? g.cell.w : g.cell.h);
      w.layout = L.resizePaneTo(w.layout, r.pane, axis, px, g.rect, g.gap);
    }
    return;
  }
  const dir = f.L ? 'L' : f.R ? 'R' : f.U ? 'U' : f.D ? 'D' : null;
  if (!dir) return;
  const n = Number(argToString(a[0] ?? 1)) || 1;
  const px = n * (dir === 'L' || dir === 'R' ? g.cell.w : g.cell.h);
  w.zoomed = false;
  w.layout = L.resizePane(w.layout, r.pane, dir, px, g.rect, g.gap);
});

def('swap-pane', 'swapp', 'dDs:t:UZ', (t, f, a, ctx) => {
  const dst = target(t, f.t, 'pane', ctx);
  const w = dst.window;
  let src;
  if (f.U || f.D) {
    const ids = L.panesInOrder(w.layout);
    const i = ids.indexOf(dst.pane);
    const other = ids[(i + (f.U ? -1 : 1) + ids.length) % ids.length];
    src = { window: w, pane: other };
  } else {
    src = target(t, f.s ?? (t.server.markedPane() != null ? '{marked}' : '{last}'), 'pane', ctx);
  }
  if (src.pane == null || src.pane === dst.pane) return;
  if (src.window === w) {
    w.layout = L.swapPanes(w.layout, src.pane, dst.pane);
  } else {
    src.window.layout = L.replacePane(src.window.layout, src.pane, -1);
    w.layout = L.replacePane(w.layout, dst.pane, src.pane);
    src.window.layout = L.replacePane(src.window.layout, -1, dst.pane);
    if (src.window.active === src.pane) src.window.active = dst.pane;
    if (w.active === dst.pane) w.active = src.pane;
  }
  if (!f.d && (f.U || f.D)) t.ui.focusPane?.(w.active);
});

def('break-pane', 'breakp', 'abdPF:n:s:t:', (t, f, a, ctx) => {
  const r = target(t, f.s, 'pane', ctx);
  let index;
  if (f.t != null) {
    const m = /(\d+)$/.exec(String(f.t));
    if (m) index = Number(m[1]);
  }
  const w = t.server.breakPane(r.pane, { name: f.n, select: !f.d, index, after: !!f.a });
  if (w && !f.d) t.ui.focusPane?.(r.pane);
});

def('join-pane', ['joinp', 'move-pane', 'movep'], 'bdfhvl:p:s:t:', (t, f, a, ctx) => {
  if (f.s == null && t.server.markedPane() == null) throw new Error('no marked pane (mark one with select-pane -m, or use -s)');
  const src = target(t, f.s ?? '{marked}', 'pane', ctx);
  const dst = target(t, f.t, 'pane', ctx);
  if (src.window === dst.window) throw new Error('source and target are in the same window');
  const size = f.p != null ? Number(f.p) / 100 : (f.l && String(f.l).endsWith('%') ? Number(String(f.l).slice(0, -1)) / 100 : undefined);
  t.server.joinPane(src.pane, dst.window, dst.pane, f.h ? 'h' : 'v', { before: !!f.b, full: !!f.f, size, select: !f.d });
  if (!f.d) { t.server.switchTo(dst.session); t.server.selectWindow(dst.session, dst.window); t.ui.focusPane?.(src.pane); }
});

def('display-panes', 'displayp', 'bd:Nt:', async (t, f, a, ctx) => {
  const time = f.d != null ? Number(f.d) : Number(t.getOption('display-panes-time'));
  const chosen = await t.ui.displayPanes({ time });
  if (chosen == null) return;
  const template = a.length ? argToString(a[0]) : 'select-pane -t "%%"';
  await t.runString(templateReplace(template, `%${chosen}`, 1), ctx);
});

def('respawn-pane', 'respawnp', 'c:e:kt:', (t, f, a, ctx) => {
  const r = target(t, f.t, 'pane', ctx);
  const p = t.server.panes[r.pane];
  if (a.length) return navigate(t, r.pane, asCommandString(a));
  if (p.kind === 'web') t.ui.paneCommand?.(r.pane, { type: 'nav', action: 'reload' });
  else t.ui.renderPane?.(r.pane);
});

def('respawn-window', 'respawnw', 'c:e:kt:', (t, f, a, ctx) => {
  const r = target(t, f.t, 'window', ctx);
  for (const id of L.panesInOrder(r.window.layout)) {
    if (t.server.panes[id].kind === 'web') t.ui.paneCommand?.(id, { type: 'nav', action: 'reload' });
  }
});

def('clear-history', 'clearhist', 'Ht:', () => {});

// -------------------------------------------------------------- sessions

def('new-session', 'new', 'Ac:dDEF:f:n:Ps:t:x:Xy:', (t, f, a, ctx) => {
  const srv = t.server;
  if (f.s && srv.sessionByName(f.s)) {
    if (f.A) { srv.switchTo(srv.sessionByName(f.s)); t.ui.focusPane?.(); return; }
    throw new Error(`duplicate session: ${f.s}`);
  }
  const spec = paneSpec(t, a.length ? asCommandString(a) : '', f.c, ctx);
  const prev = srv.session;
  const s = srv.newSession({ name: f.s, windowName: f.n, ...spec });
  if (f.d && prev) srv.switchTo(prev);
  if (f.P) t.ui.message(t.expandPlain(f.F || '#{session_name}:', { session: s }));
  t.ui.focusPane?.();
});

def('rename-session', 'rename', 't:', (t, f, a, ctx) => {
  const r = target(t, f.t, 'session', ctx);
  const name = argToString(a[0] ?? '');
  if (!name) throw new Error('empty session name');
  if (t.server.sessionByName(name) && t.server.sessionByName(name) !== r.session) throw new Error(`duplicate session: ${name}`);
  r.session.name = name;
});

def('kill-session', null, 'aCt:', (t, f, a, ctx) => {
  const r = target(t, f.t, 'session', ctx);
  if (f.C) return;
  if (f.a) { for (const s of t.server.sessions.slice()) if (s !== r.session) t.server.killSession(s); }
  else t.server.killSession(r.session);
  t.ui.serverEmpty?.();
  t.ui.focusPane?.();
});

def('kill-server', null, '', (t) => {
  for (const s of t.server.sessions.slice()) t.server.killSession(s);
  t.ui.serverEmpty?.();
});

def('has-session', 'has', 't:', (t, f, a, ctx) => { target(t, f.t, 'session', ctx); });

def('list-sessions', 'ls', 'F:f:', (t, f, a, ctx) => {
  const fmt = f.F || '#{session_name}: #{session_windows} windows (created #{t:session_created})#{?session_attached, (attached),}';
  const keep = (c) => !f.f || truthyFmt(t.expandPlain(f.f, c));
  t.output(ctx, t.server.sessions.filter((s) => keep({ session: s })).map((s) => t.expandPlain(fmt, { session: s })), 'list-sessions');
});

def('list-windows', 'lsw', 'aF:f:t:', (t, f, a, ctx) => {
  const sessions = f.a ? t.server.sessions : [target(t, f.t, 'session', ctx).session];
  const fmt = f.F || (f.a ? '#{session_name}:' : '') + '#{window_index}: #{window_name}#{window_flags} (#{window_panes} panes)';
  const lines = [];
  for (const s of sessions) {
    for (const w of t.server.sortedWindows(s)) {
      if (f.f && !truthyFmt(t.expandPlain(f.f, { session: s, window: w }))) continue;
      lines.push(t.expandPlain(fmt, { session: s, window: w }));
    }
  }
  t.output(ctx, lines, 'list-windows');
});

def('list-panes', 'lsp', 'asF:f:t:', (t, f, a, ctx) => {
  const r = target(t, f.t, 'window', ctx);
  const fmt = f.F || '#{pane_index}: #{pane_title} #{pane_current_path}#{?pane_active, (active),}';
  const wins = f.a ? t.server.sessions.flatMap((s) => t.server.sortedWindows(s).map((w) => [s, w]))
    : f.s ? t.server.sortedWindows(r.session).map((w) => [r.session, w]) : [[r.session, r.window]];
  const lines = [];
  for (const [session, window] of wins) {
    for (const id of L.panesInOrder(window.layout)) {
      const c = { session, window, pane: id };
      if (f.f && !truthyFmt(t.expandPlain(f.f, c))) continue;
      lines.push(t.expandPlain(fmt, c));
    }
  }
  t.output(ctx, lines, 'list-panes');
});

def('choose-tree', ['choose-window', 'choose-session'], 'F:f:GK:NO:rst:wyZ', (t, f, a, ctx) => {
  const mode = f.s || ctx.invokedAs === 'choose-session' ? 'session'
    : f.w || ctx.invokedAs === 'choose-window' ? 'window' : 'tree';
  t.ui.chooseTree({ mode, filter: f.f || '', zoom: !!f.Z, template: a[0] != null ? argToString(a[0]) : null });
});

def('choose-client', null, 'F:f:K:NO:rt:yZ', (t) => t.ui.message('Only one client (this tab) is attached'));

def('detach-client', 'detach', 'aE:Ps:t:', (t) => t.ui.detach?.());
def('suspend-client', 'suspendc', 't:', () => {});
def('lock-server', ['lock', 'lock-client', 'lockc', 'lock-session', 'locks'], 't:', (t) => t.ui.detach?.());
def('refresh-client', 'refresh', 'A:B:cC:Df:F:l:LRSt:U', (t) => t.ui.refresh?.());

// ------------------------------------------------------- messages / modes

def('display-message', 'display', 'aCc:d:INpt:F:lv', (t, f, a, ctx) => {
  const r = resolveTarget(t.server, f.t, 'pane', ctx, t.ui.geometry()) || {};
  const fctx = { session: r.session, window: r.window, pane: r.pane };
  if (f.a) {
    const names = ['session_name', 'session_id', 'window_index', 'window_name', 'window_flags', 'window_panes',
      'pane_index', 'pane_id', 'pane_title', 'pane_current_path', 'pane_current_command', 'client_prefix', 'host', 'version'];
    const lookup = t.lookup(fctx);
    t.output(ctx, names.map((n) => `${n}=${lookup(n) ?? ''}`), 'display-message -a');
    return;
  }
  const fmt = a.length ? argToString(a[0])
    : f.F || '[#{session_name}] #{window_index}:#{window_name}, current pane #{pane_index} - (%H:%M %d-%b-%y)';
  const text = f.l ? fmt : t.expandPlain(fmt, fctx, { time: true });
  if (ctx.print && (f.p || ctx.fromShell)) { ctx.print(text); return; }
  t.ui.message(text, { duration: f.d != null ? Number(f.d) : undefined });
});

def('command-prompt', null, '1beFiklNI:p:t:T:W', async (t, f, a, ctx) => {
  let template = a.length ? (a.length === 1 ? argToString(a[0]).replace(/^\{ (.*) \}$/s, '$1') : asCommandString(a)) : null;
  if (template && f.F) template = t.expandPlain(template, ctx);
  const cmdName = template ? template.trim().split(/\s+/)[0] : null;
  const prompts = f.p != null ? splitList(t.expandPlain(f.p, ctx)).map((p) => p + ' ')
    : [template ? `(${cmdName}) ` : ':'];
  const inputs = f.I != null ? splitList(f.I).map((s) => t.expandPlain(s, ctx)) : [];
  const answers = await t.ui.prompt({
    prompts, inputs, single: !!f[1], numeric: !!f.N, type: f.T || 'command', command: !template,
  });
  if (!answers) return;
  if (!template) {
    if (answers[0].trim()) await t.runString(answers[0], ctx);
    return;
  }
  let cmd = template;
  answers.forEach((ans, i) => { cmd = templateReplace(cmd, ans, i + 1); });
  await t.runString(cmd, ctx);
});

def('confirm-before', 'confirm', 'bc:p:t:y', async (t, f, a, ctx) => {
  const cmd = a.length === 1 ? argToString(a[0]).replace(/^\{ (.*) \}$/s, '$1') : asCommandString(a);
  const prompt = f.p != null ? t.expandPlain(f.p, ctx) : `Confirm '${cmd}'? (y/n)`;
  const ok = await t.ui.confirm(prompt, { defaultYes: !!f.y, confirmKey: f.c || 'y' });
  if (ok) await t.runString(cmd, ctx);
});

def('show-messages', 'showmsgs', 'JTt:', (t) => t.ui.showMessages?.());

def('list-commands', 'lscm', 'F:', (t) => {
  const lines = [...COMMANDS.values()].map((c) => {
    const aliases = [...ALIASES.entries()].filter(([, n]) => n === c.name).map(([a]) => a);
    return `${c.name}${aliases.length ? ` (${aliases.join(', ')})` : ''}${c.flags ? ` [-${c.flags.replace(/[A-Za-z0-9]:/g, '').replace(/:/g, '')}]` : ''}`;
  }).sort();
  t.ui.showList({ title: 'list-commands', lines, filterable: true });
});

def('clock-mode', null, 't:', (t, f, a, ctx) => {
  const r = target(t, f.t, 'pane', ctx);
  t.ui.clock?.(r.pane);
});

def('copy-mode', null, 'deHMqs:t:u', (t, f, a, ctx) => {
  const r = target(t, f.t, 'pane', ctx);
  if (f.q) { t.ui.paneCommand?.(r.pane, { type: 'copy-cmd', args: ['cancel'] }); return; }
  t.ui.copyMode?.(r.pane, { scrollUp: !!f.u, exitAtBottom: !!f.e });
});

def('send-keys', 'send', 'c:FHKlMN:Rt:X', async (t, f, a, ctx) => {
  const r = target(t, f.t, 'pane', ctx);
  const args = a.map(argToString);
  if (f.X) {
    const p = t.server.panes[r.pane];
    if (!p?.mode) return;
    const repeat = Number(f.N) || 1;
    for (let i = 0; i < repeat; i++) await t.ui.paneCommand?.(r.pane, { type: 'copy-cmd', args });
    return;
  }
  if (f.R || f.M) return;
  await t.ui.paneCommand?.(r.pane, { type: 'send-keys', keys: args, literal: !!f.l });
});

def('send-prefix', null, '2t:', (t) => {
  t.log('send-prefix: synthetic key events cannot reach pages; ignored');
});

// --------------------------------------------------------------- buffers

def('set-buffer', 'setb', 'aAb:n:t:w', (t, f, a) => {
  const data = argToString(a[0] ?? '');
  const existing = f.b ? t.buffers.find((x) => x.name === f.b) : t.buffers[0];
  if (f.n) { if (!existing) throw new Error('no buffer'); existing.name = f.n; return; }
  if (f.a && existing) existing.data += data;
  else pushBuffer(t, data, f.b);
  if (f.w) t.ui.writeClipboard?.(data);
});

def('delete-buffer', 'deleteb', 'b:', (t, f) => {
  if (f.b) t.buffers = t.buffers.filter((b) => b.name !== f.b);
  else t.buffers.shift();
});

def('list-buffers', 'lsb', 'F:f:', (t, f, a, ctx) => {
  t.output(ctx, t.buffers.map((b) => `${b.name}: ${b.data.length} bytes: "${b.data.slice(0, 50).replace(/\n/g, '\\n')}"`), 'list-buffers');
});

def('show-buffer', 'showb', 'b:', (t, f, a, ctx) => {
  const b = f.b ? t.buffers.find((x) => x.name === f.b) : t.buffers[0];
  if (!b) throw new Error('no buffers');
  t.output(ctx, b.data.split('\n'), b.name);
});

def('paste-buffer', 'pasteb', 'b:dprs:t:', async (t, f, a, ctx) => {
  const r = target(t, f.t, 'pane', ctx);
  const b = f.b ? t.buffers.find((x) => x.name === f.b) : t.buffers[0];
  if (!b) return;
  await t.ui.paneCommand?.(r.pane, { type: 'paste', text: b.data });
  if (f.d) t.buffers = t.buffers.filter((x) => x !== b);
});

def('choose-buffer', null, 'F:f:K:NO:rt:yZ', async (t, f, a, ctx) => {
  if (!t.buffers.length) { t.ui.message('no buffers'); return; }
  const choice = await t.ui.pick({
    title: 'choose-buffer',
    items: t.buffers.map((b, i) => ({ label: `${b.name}: "${b.data.slice(0, 80).replace(/\n/g, '\\n')}"`, value: i })),
  });
  if (choice == null) return;
  const b = t.buffers[choice];
  const r = target(t, f.t, 'pane', ctx);
  await t.ui.paneCommand?.(r.pane, { type: 'paste', text: b.data });
});


// ------------------------------------------------------- menus / popups

/** Turn a menu item command (string or { block }) into a command string with formats expanded. */
function menuCommand(t, cmd, fctx) {
  let str = cmd == null ? '' : (typeof cmd === 'string' ? cmd : cmd.text ?? argToString(cmd));
  // Bindings store `{ ... }` blocks as text; unwrap them like command-prompt does.
  str = str.replace(/^\{\s*(.*?)\s*\}$/s, '$1');
  return t.expandPlain(str, fctx);
}

def('display-menu', 'menu', 'b:c:C:H:MOs:S:t:T:x:y:', async (t, f, a, ctx) => {
  const r = resolveTarget(t.server, f.t, 'pane', ctx, t.ui.geometry()) || {};
  const fctx = { session: r.session, window: r.window, pane: r.pane };
  const items = [];
  for (let i = 0; i < a.length;) {
    const name = argToString(a[i]);
    if (name === '') { items.push({ separator: true }); i++; continue; }
    const key = argToString(a[i + 1] ?? '');
    const cmd = a[i + 2];
    i += 3;
    let label = t.expandPlain(name, fctx);
    const disabled = label.startsWith('-');
    if (disabled) label = label.slice(1);
    items.push({ label, key, disabled, command: menuCommand(t, cmd, fctx) });
  }
  const selectable = items.filter((x) => !x.separator && !x.disabled);
  if (!selectable.length) return;
  const title = f.T != null ? t.expandPlain(f.T, fctx) : '';
  let chosen;
  if (t.ui.menu) {
    chosen = await t.ui.menu({ title, items, start: f.C != null ? Number(f.C) : 0, x: f.x, y: f.y });
  } else {
    const v = await t.ui.pick({ title: title || 'menu', fuzzy: false, items: selectable.map((x) => ({ label: x.key ? `(${x.key}) ${x.label}` : x.label, value: items.indexOf(x) })) });
    chosen = v == null ? null : items[v];
  }
  if (!chosen || chosen.disabled || chosen.separator || !chosen.command) return;
  await t.runString(chosen.command, { ...ctx, ...fctx, fromKey: true });
});

def('display-popup', 'popup', 'BCEkNb:c:d:e:h:s:S:t:T:w:x:y:', async (t, f, a, ctx) => {
  if (f.C) { t.ui.closePopup?.(); return; }
  const r = resolveTarget(t.server, f.t, 'pane', ctx, t.ui.geometry()) || {};
  const fctx = { session: r.session, window: r.window, pane: r.pane };
  let cmd = a.length ? asCommandString(a) : '';
  if (!cmd) cmd = t.getOption('default-command');
  if (!cmd && f.d) cmd = t.expandPlain(f.d, fctx);
  const geometry = { width: f.w, height: f.h, x: f.x, y: f.y, title: f.T != null ? t.expandPlain(f.T, fctx) : '', border: f.B ? 'none' : f.b };
  if (cmd && looksLikeUrl(cmd)) {
    if (!t.ui.popup) { t.ui.openTab?.(toUrl(cmd, t.getOption('@ctmux-search-url'))); return; }
    t.ui.popup({ ...geometry, url: toUrl(cmd, t.getOption('@ctmux-search-url')) });
    return;
  }
  if (!cmd) { t.ui.popup?.({ ...geometry, url: '' }); return; }
  const res = await t.shell(t.expandPlain(cmd, fctx), { ...ctx, ...fctx });
  if (!res) {
    t.notice(`display-popup "${short(cmd)}": shell commands can't run in the browser (a URL opens in the popup)`, { source: ctx.source, line: ctx.line, level: 'info', key: 'popup:' + cmd });
    if (!ctx.fromConfig) t.ui.message(`display-popup: can't run '${short(cmd)}' in the browser`);
    return;
  }
  const out = res.out.replace(/\n$/, '');
  if (out && !f.E) {
    if (t.ui.popup) t.ui.popup({ ...geometry, text: out });
    else t.ui.showList({ title: geometry.title || 'popup', lines: out.split('\n') });
  }
});

// --------------------------------------------------------- synchronisation

function channel(t, name) {
  if (!t.waitChannels.has(name)) t.waitChannels.set(name, { waiters: [], woken: false, locked: false, lockers: [] });
  return t.waitChannels.get(name);
}

def('wait-for', 'wait', 'LSU', async (t, f, a, ctx) => {
  const name = argToString(a[0] ?? '');
  if (!name) throw new Error('missing channel');
  const ch = channel(t, name);
  if (f.S) {
    if (!ch.waiters.length) ch.woken = true;
    ch.waiters.splice(0).forEach((w) => w());
    return;
  }
  if (f.U) {
    if (!ch.locked) throw new Error(`channel ${name} not locked`);
    const next = ch.lockers.shift();
    if (next) next(); else ch.locked = false;
    return;
  }
  if (f.L) {
    if (!ch.locked) { ch.locked = true; return; }
    if (ctx.fromConfig) throw new Error(`channel ${name} is locked (not waiting while the config loads)`);
    await new Promise((res) => ch.lockers.push(res));
    return;
  }
  if (ch.woken) { ch.woken = false; return; }
  if (ctx.fromConfig) {
    t.notice(`wait-for ${name}: not waiting while the config loads`, { source: ctx.source, line: ctx.line, level: 'info' });
    return;
  }
  await new Promise((res) => ch.waiters.push(res));
});

// ------------------------------------------------------------ capture etc.

def('capture-pane', 'capturep', 'ab:CeE:JNpPqS:t:T', async (t, f, a, ctx) => {
  const r = target(t, f.t, 'pane', ctx);
  const p = t.server.panes[r.pane];
  let text = '';
  if (p.kind === 'web') {
    const res = await t.ui.paneCommand?.(r.pane, { type: 'capture', all: f.S === '-' });
    text = res?.text ?? [p.title, p.url].filter(Boolean).join('\n');
  } else {
    text = p.prefill || '';
  }
  if (f.J) text = text.replace(/\n(?=\S)/g, ' ');
  let ls = text.split('\n');
  const n = (v, def) => (v == null || v === '-' ? def : Number(v));
  if (f.S != null || f.E != null) {
    const start = n(f.S, 0), end = n(f.E, ls.length - 1);
    ls = ls.slice(Math.max(0, start < 0 ? ls.length + start : start), (end < 0 ? ls.length + end : end) + 1);
  }
  text = ls.join('\n');
  if (f.p) { t.output(ctx, ls, 'capture-pane'); return; }
  pushBuffer(t, text, f.b);
});

function pushBuffer(t, data, name) {
  if (name) {
    const b = t.buffers.find((x) => x.name === name);
    if (b) { b.data = data; b.time = Date.now(); return b; }
  }
  const b = { name: name || `buffer${String(t.buffers.length).padStart(4, '0')}`, data, time: Date.now() };
  t.buffers.unshift(b);
  const limit = Number(t.getOption('buffer-limit')) || 50;
  if (t.buffers.length > limit) t.buffers.length = limit;
  return b;
}

def('save-buffer', 'saveb', 'ab:', (t, f, a, ctx) => {
  const b = f.b ? t.buffers.find((x) => x.name === f.b) : t.buffers[0];
  if (!b) throw new Error('no buffers');
  const path = argToString(a[0] ?? '-');
  if (path === '-' && ctx.print) { b.data.split('\n').forEach((l) => ctx.print(l)); return; }
  // No file system: the closest useful thing is the system clipboard.
  t.ui.writeClipboard?.(b.data);
  if (path !== '-') t.notice(`save-buffer ${path}: no file system in the browser; copied to the clipboard instead`, { level: 'info', key: 'save-buffer' });
});

def('load-buffer', 'loadb', 'b:t:w', async (t, f, a) => {
  const path = argToString(a[0] ?? '-');
  let data;
  if (path === '-') data = (await t.ui.readClipboard?.()) ?? '';
  else {
    try { data = await t.loadFile(path); } catch (err) { throw new Error(`${path}: ${err.message || err}`); }
  }
  pushBuffer(t, String(data), f.b);
  if (f.w) t.ui.writeClipboard?.(String(data));
});

def('pipe-pane', 'pipep', 'IOot:', (t, f, a, ctx) => {
  if (a.length) t.notice('pipe-pane: panes have no output stream in the browser', { source: ctx.source, line: ctx.line, level: 'info', key: 'pipe-pane' });
});

// ------------------------------------------------------- clients / server

def('list-clients', 'lsc', 'F:f:t:', (t, f, a, ctx) => {
  const fmt = f.F || '#{client_name}: #{session_name} [#{client_width}x#{client_height} #{client_termname}] (utf8)';
  t.output(ctx, [t.expandPlain(fmt)], 'list-clients');
});

def('attach-session', ['attach', 'a', 'at'], 'c:dEf:rt:x', (t, f, a, ctx) => {
  if (!t.server.sessions.length) throw new Error('no sessions');
  if (f.t) {
    const r = target(t, f.t, 'session', ctx);
    t.server.switchTo(r.session);
    if (r.window) t.server.selectWindow(r.session, r.window);
  }
  t.ui.focusPane?.();
});

def('start-server', 'start', '', () => {});
def('server-access', null, 'adlrw', (t, f, a, ctx) => { if (f.l) t.output(ctx, [], 'server-access'); });
def('resize-window', 'resizew', 'aADLRt:Ux:y:', () => {}); // the window is the browser tab
def('unlink-window', 'unlinkw', 'kt:', (t, f, a, ctx) => {
  const r = target(t, f.t, 'window', ctx);
  if (!f.k && r.session.windows.length <= 1 && t.server.sessions.length <= 1) throw new Error('window only linked to one session');
  t.server.killWindow(r.session, r.window);
  t.ui.serverEmpty?.();
  t.ui.focusPane?.();
});
def('customize-mode', null, 'F:f:Nt:yZ', (t, f, a, ctx) => COMMANDS.get('show-options').run(t, {}, [], ctx));
def('show-prompt-history', 'showphist', 'T:', (t, f, a, ctx) => t.output(ctx, t.ui.promptHistory?.() || [], 'prompt history'));
def('clear-prompt-history', 'clearphist', 'T:', (t) => t.ui.clearPromptHistory?.());

// ---------------------------------------------------- chrome-tmux specific

function navigate(t, paneId, input) {
  const p = t.server.panes[paneId];
  const url = toUrl(input, t.getOption('@ctmux-search-url'));
  if (!url) {
    p.kind = 'launcher';
    p.url = '';
    p.title = '';
  } else {
    p.kind = 'web';
    p.url = url;
    if (!p.manualTitle) p.title = '';
  }
  t.ui.renderPane?.(paneId, { navigate: true });
  t.ui.focusPane?.(paneId);
}

def('goto', ['open', 'open-url'], 't:', (t, f, a, ctx) => {
  const r = target(t, f.t, 'pane', ctx);
  navigate(t, r.pane, a.map(argToString).join(' '));
});

for (const action of ['back', 'forward', 'reload']) {
  def(action, null, 't:', (t, f, a, ctx) => {
    const r = target(t, f.t, 'pane', ctx);
    t.ui.paneCommand?.(r.pane, { type: 'nav', action });
  });
}

def('open-in-tab', null, 't:', (t, f, a, ctx) => {
  const r = target(t, f.t, 'pane', ctx);
  const p = t.server.panes[r.pane];
  if (p.kind === 'web' && p.url) t.ui.openTab?.(p.url);
  else t.ui.message('pane has no page');
});

def('ctmux-debug', null, '', (t) => t.ui.showMessages?.());

export { navigate, paneShortName, formatCommandList };
