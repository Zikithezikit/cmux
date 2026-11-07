// tmux FORMATS / STYLES implementation used by the status line, pane borders,
// display-message, set-titles and %if.

const SHORT_ALIASES = {
  S: 'session_name', I: 'window_index', W: 'window_name', P: 'pane_index',
  T: 'pane_title', D: 'pane_id', F: 'window_flags', H: 'host', h: 'host_short',
};

/** Find the index of the `close` matching an opener that ends just before `start`. */
function findClose(s, start, open, close) {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '#' && (s[i + 1] === open || s[i + 1] === '{' || s[i + 1] === '[')) {
      if (s[i + 1] === open) depth++;
      else {
        // nested other-type block: skip over it
        const other = s[i + 1] === '{' ? '}' : ']';
        const end = findClose(s, i + 2, s[i + 1], other);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      i++;
      continue;
    }
    if (c === '#' && (s[i + 1] === close || s[i + 1] === ',' || s[i + 1] === '#')) { i++; continue; }
    if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on top-level commas (not inside #{ } / #[ ] and not escaped as #,). */
function splitTop(s) {
  const parts = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '#' && (s[i + 1] === '{' || s[i + 1] === '[')) {
      const end = findClose(s, i + 2, s[i + 1], s[i + 1] === '{' ? '}' : ']');
      if (end === -1) { cur += s.slice(i); i = s.length; break; }
      cur += s.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === '#' && s[i + 1] === ',') { cur += '#,'; i++; continue; }
    if (c === ',') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

const truthy = (v) => v !== '' && v !== '0' && v != null;

/**
 * Expand a tmux format string.
 * `lookup(name)` returns a string (or undefined) for a format variable.
 * Style blocks (#[...]) are preserved (with their contents expanded) so the
 * caller can turn the result into styled runs.
 */
export function expandFormat(fmt, lookup, depth = 0) {
  if (fmt == null) return '';
  fmt = String(fmt);
  if (depth > 10) return fmt;
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== '#') { out += c; continue; }
    const nx = fmt[i + 1];
    if (nx === undefined) { out += '#'; break; }
    if (nx === '#') { out += '##'; i++; continue; } // kept escaped; unescaped in toRuns
    if (nx === ',' || nx === '}') { out += nx; i++; continue; }
    if (nx === '{') {
      const end = findClose(fmt, i + 2, '{', '}');
      if (end === -1) { out += fmt.slice(i); break; }
      out += evalExpr(fmt.slice(i + 2, end), lookup, depth);
      i = end;
      continue;
    }
    if (nx === '[') {
      const end = findClose(fmt, i + 2, '[', ']');
      if (end === -1) { out += fmt.slice(i); break; }
      out += '#[' + expandFormat(fmt.slice(i + 2, end), lookup, depth + 1) + ']';
      i = end;
      continue;
    }
    if (nx === '(') {
      // #(shell command): cannot run shell commands in a browser.
      let d = 1, j = i + 2;
      for (; j < fmt.length && d; j++) { if (fmt[j] === '(') d++; else if (fmt[j] === ')') d--; }
      const cmd = fmt.slice(i + 2, j - 1);
      const v = lookup('#(' + cmd + ')');
      out += v == null ? '' : String(v);
      i = j - 1;
      continue;
    }
    if (SHORT_ALIASES[nx]) {
      const v = lookup(SHORT_ALIASES[nx]);
      out += v == null ? '' : String(v);
      i++;
      continue;
    }
    out += '#';
  }
  return out;
}

function value(name, lookup, depth) {
  if (name.includes('#')) return expandFormat(name, lookup, depth + 1);
  const v = lookup(name);
  return v == null ? '' : String(v);
}

function evalExpr(expr, lookup, depth) {
  // Conditional: ?cond,a,b  (and ?c1,v1,c2,v2,else)
  if (expr[0] === '?') {
    const parts = splitTop(expr.slice(1));
    for (let k = 0; k + 1 < parts.length; k += 2) {
      const cond = parts[k];
      const cv = cond.includes('#') ? expandFormat(cond, lookup, depth + 1) : value(cond, lookup, depth);
      if (truthy(cv)) return expandFormat(parts[k + 1], lookup, depth + 1);
    }
    return parts.length % 2 === 1 && parts.length > 1
      ? expandFormat(parts[parts.length - 1], lookup, depth + 1)
      : '';
  }

  // Modifiers: everything before the first top-level ':'.
  const m = /^((?:[^:{}#]|#[^{[])*?):/.exec(expr);
  if (m && m[1] !== '' && /^[=!<>|&lbdmneETqsptNSWPLacwRC]/.test(m[1])) {
    return applyModifiers(m[1], expr.slice(m[0].length), lookup, depth);
  }
  return value(expr, lookup, depth);
}

function applyModifiers(mods, rest, lookup, depth) {
  const list = mods.split(';');
  // Binary operators operate on the comma-separated arguments.
  const head = list[0];
  const bin = /^(==|!=|<=|>=|<|>|\|\||&&)$/.exec(head);
  if (bin) {
    const [a = '', b = ''] = splitTop(rest).map((p) => expandFormat(p, lookup, depth + 1));
    switch (bin[1]) {
      case '==': return a === b ? '1' : '0';
      case '!=': return a !== b ? '1' : '0';
      case '<': return a < b ? '1' : '0';
      case '>': return a > b ? '1' : '0';
      case '<=': return a <= b ? '1' : '0';
      case '>=': return a >= b ? '1' : '0';
      case '||': return truthy(lookupMaybe(a, lookup)) || truthy(lookupMaybe(b, lookup)) ? '1' : '0';
      case '&&': return truthy(lookupMaybe(a, lookup)) && truthy(lookupMaybe(b, lookup)) ? '1' : '0';
    }
  }
  if (/^m(\/[ri]*)?$/.test(head)) {
    const [pat = '', str = ''] = splitTop(rest).map((p) => expandFormat(p, lookup, depth + 1));
    const target = value(str, lookup, depth) || str;
    const flags = head.includes('i') ? 'i' : '';
    if (head.includes('r')) {
      try { return new RegExp(pat, flags).test(target) ? '1' : '0'; } catch { return '0'; }
    }
    return globToRegExp(pat, flags).test(target) ? '1' : '0';
  }
  const e = /^e\|([-+*/%]|==|!=|<|>|<=|>=|m)\|(f)?\|?(\d+)?$/.exec(head);
  if (e) {
    const [a, b] = splitTop(rest).map((p) => Number(expandFormat(p, lookup, depth + 1)) || 0);
    const ops = {
      '+': a + b, '-': a - b, '*': a * b, '/': b ? a / b : 0, '%': b ? a % b : 0, m: b ? a % b : 0,
      '==': +(a === b), '!=': +(a !== b), '<': +(a < b), '>': +(a > b), '<=': +(a <= b), '>=': +(a >= b),
    };
    const r = ops[e[1]];
    return e[2] ? r.toFixed(Number(e[3] || 0)) : String(Math.trunc(r));
  }

  if (head === 'l') return rest;
  // Loops over sessions / windows / panes: #{W:fmt} or #{W:fmt,current-fmt}; flags /n (by name), /r (reverse).
  const loop = /^([SWPL])(?:\/([a-z]*))?$/.exec(head);
  if (loop) {
    const items = lookup.loop ? lookup.loop(loop[1], loop[2] || '') : [];
    const [normal = '', current] = splitTop(rest);
    return items.map((it) => expandFormat(it.current && current !== undefined ? current : normal, it.lookup, depth + 1)).join('');
  }
  // #{N:name} / #{N/w:name} / #{N/s:name}: does a window (or session) with this name exist?
  const nexist = /^N(?:\/([ws]))?$/.exec(head);
  if (nexist) {
    const nm = rest.includes('#') ? expandFormat(rest, lookup, depth + 1) : rest;
    return lookup.exists?.(nexist[1] || 'w', nm) ? '1' : '0';
  }
  if (head === '!' || head === '!!') {
    const v = rest.includes('#') ? expandFormat(rest, lookup, depth + 1) : lookupMaybe(rest, lookup);
    return truthy(v) === (head === '!!') ? '1' : '0';
  }
  if (head === 'C' || head.startsWith('C/')) return '0'; // pane content search: no terminal grid
  if (/^R$/.test(head)) {
    const [str = '', n = '0'] = splitTop(rest).map((p) => expandFormat(p, lookup, depth + 1));
    return str.repeat(Math.max(0, Math.min(1000, Number(n) || 0)));
  }
  let v = rest.includes('#') ? expandFormat(rest, lookup, depth + 1) : value(rest, lookup, depth);
  // #{a:98}, #{c:red}: a literal argument is allowed when it isn't a variable.
  if (!rest.includes('#') && lookup(rest) == null && list.every((x) => x === 'a' || x === 'c' || x === 'w')) v = rest;
  for (const mod of list) {
    let mm;
    if ((mm = /^=(\/)?(-?\d+)(?:\/(.*))?$/.exec(mod))) {
      const n = Number(mm[2]);
      const marker = mm[3] || '';
      if (Math.abs(n) < v.length) {
        v = n >= 0 ? v.slice(0, n) + marker : marker + v.slice(v.length + n);
      }
    } else if ((mm = /^p(-?\d+)$/.exec(mod))) {
      const n = Number(mm[1]);
      v = n >= 0 ? v.padEnd(n) : v.padStart(-n);
    } else if ((mm = /^s\/((?:\\\/|[^/])*)\/((?:\\\/|[^/])*)\/?(i)?$/.exec(mod))) {
      try { v = v.replace(new RegExp(mm[1], 'g' + (mm[3] || '')), mm[2].replace(/\\(\d)/g, '$$$1')); } catch { /* bad regexp */ }
    } else if (mod === 'b') {
      v = v.replace(/\/+$/, '').split('/').pop();
    } else if (mod === 'd') {
      v = v.replace(/\/[^/]*\/?$/, '') || '/';
    } else if (mod === 'n') {
      v = String(v.length);
    } else if (mod === 'E') {
      v = expandFormat(v, lookup, depth + 1);
    } else if (mod === 't' || mod.startsWith('t/')) {
      const d = new Date(Number(v) * 1000);
      const custom = /^t\/f\/(.*)$/.exec(mod);
      if (Number.isNaN(d.getTime())) { /* not a time */ }
      else if (custom) v = strftime(custom[1].replace(/%%/g, '%'), d);
      else if (mod.includes('p')) v = d.toTimeString().slice(0, 5);
      else v = d.toString().slice(0, 24);
    } else if (mod === 'a') {
      const n = Number(v);
      v = Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
    } else if (mod === 'c') {
      v = colourToCss(v) || '';
    } else if (mod === 'w') {
      v = String([...v].length);
    } else if (mod === 'T') {
      v = strftime(v, new Date());
    } else if (mod === 'q') {
      v = v.replace(/([^\w@%.,/:=+-])/g, '\\$1');
    }
  }
  return v;
}

function lookupMaybe(s, lookup) {
  const v = lookup(s);
  return v == null ? s : v;
}

function globToRegExp(glob, flags) {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', flags);
}

// ---------------------------------------------------------------- strftime

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const pad = (n, w = 2, c = '0') => String(n).padStart(w, c);

export function strftime(fmt, d = new Date()) {
  if (!fmt.includes('%')) return fmt;
  return fmt.replace(/%([-_0^#]?)([a-zA-Z%+])/g, (all, flag, ch) => {
    const h12 = d.getHours() % 12 || 12;
    const map = {
      a: DAYS[d.getDay()].slice(0, 3), A: DAYS[d.getDay()],
      b: MONTHS[d.getMonth()].slice(0, 3), h: MONTHS[d.getMonth()].slice(0, 3), B: MONTHS[d.getMonth()],
      c: d.toLocaleString(), C: pad(Math.floor(d.getFullYear() / 100)),
      d: pad(d.getDate()), e: pad(d.getDate(), 2, ' '), D: `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)}`,
      F: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      H: pad(d.getHours()), I: pad(h12), k: pad(d.getHours(), 2, ' '), l: pad(h12, 2, ' '),
      j: pad(Math.floor((d - new Date(d.getFullYear(), 0, 1)) / 864e5) + 1, 3),
      m: pad(d.getMonth() + 1), M: pad(d.getMinutes()), n: '\n', t: '\t',
      p: d.getHours() < 12 ? 'AM' : 'PM', P: d.getHours() < 12 ? 'am' : 'pm',
      r: `${pad(h12)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getHours() < 12 ? 'AM' : 'PM'}`,
      R: `${pad(d.getHours())}:${pad(d.getMinutes())}`, s: String(Math.floor(d / 1000)),
      S: pad(d.getSeconds()), T: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
      u: String(d.getDay() || 7), w: String(d.getDay()), y: pad(d.getFullYear() % 100), Y: String(d.getFullYear()),
      x: d.toLocaleDateString(), X: d.toLocaleTimeString(),
      Z: (d.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop()) || '',
      z: (() => { const o = -d.getTimezoneOffset(); return (o >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(o) / 60)) + pad(Math.abs(o) % 60); })(),
      '%': '%',
    };
    let v = map[ch];
    if (v === undefined) return all;
    if (flag === '-') v = v.replace(/^[0 ]+(?=\d)/, '');
    else if (flag === '^') v = v.toUpperCase();
    return v;
  });
}

// ------------------------------------------------------------------ colours

const BASE16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];
const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

function colour256(n) {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    n -= 16;
    const v = [0, 95, 135, 175, 215, 255];
    const r = v[Math.floor(n / 36)], g = v[Math.floor(n / 6) % 6], b = v[n % 6];
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  const g = 8 + (n - 232) * 10;
  return '#' + g.toString(16).padStart(2, '0').repeat(3);
}

/** Convert a tmux colour to CSS. Returns null for default/terminal. */
export function colourToCss(c) {
  if (!c) return null;
  c = String(c).trim().toLowerCase();
  if (c === 'default' || c === 'terminal') return null;
  if (/^#[0-9a-f]{6}$/.test(c) || /^#[0-9a-f]{3}$/.test(c)) return c;
  let m;
  if ((m = /^colou?r(\d{1,3})$/.exec(c))) return colour256(Math.min(255, Number(m[1])));
  const idx = NAMES.indexOf(c);
  if (idx !== -1) return BASE16[idx];
  if ((m = /^bright(\w+)$/.exec(c)) && NAMES.includes(m[1])) return BASE16[NAMES.indexOf(m[1]) + 8];
  if (/^\d{1,3}$/.test(c)) return colour256(Number(c));
  if (/^[a-z]+$/.test(c)) return c; // CSS named colour, e.g. "orange"
  return null;
}

// ------------------------------------------------------------------- styles

const ATTRS = ['bright', 'bold', 'dim', 'underscore', 'blink', 'reverse', 'hidden', 'italics', 'strikethrough', 'overline'];

export function emptyStyle() {
  return { fg: null, bg: null, attrs: {} };
}

/** Apply a tmux style string (e.g. "fg=red,bg=default,bold") to `style`. */
export function applyStyle(style, str, base = emptyStyle()) {
  const s = { fg: style.fg, bg: style.bg, attrs: { ...style.attrs } };
  for (let tok of String(str || '').split(/[\s,]+/)) {
    tok = tok.trim();
    if (!tok) continue;
    const lower = tok.toLowerCase();
    if (lower === 'default') {
      s.fg = base.fg; s.bg = base.bg; s.attrs = { ...base.attrs };
    } else if (lower === 'none') {
      s.attrs = {};
    } else if (lower.startsWith('fg=')) {
      s.fg = lower === 'fg=default' ? base.fg : colourToCss(tok.slice(3));
    } else if (lower.startsWith('bg=')) {
      s.bg = lower === 'bg=default' ? base.bg : colourToCss(tok.slice(3));
    } else if (lower.startsWith('us=') || lower.startsWith('fill=') || lower.startsWith('align=') ||
               lower.startsWith('list') || lower.startsWith('range') || lower.endsWith('-default') ||
               lower === 'norange' || lower === 'nolist') {
      // Layout directives of status-format; not used by this renderer.
    } else if (lower.startsWith('no') && ATTRS.includes(lower.slice(2))) {
      delete s.attrs[lower.slice(2)];
    } else if (ATTRS.includes(lower) || lower === 'underline' || lower === 'italic') {
      const a = lower === 'underline' ? 'underscore' : lower === 'italic' ? 'italics' : lower;
      s.attrs[a === 'bright' ? 'bold' : a] = true;
    } else if (/^(double|curly|dotted|dashed)-underscore$/.test(lower)) {
      s.attrs.underscore = true;
    }
  }
  return s;
}

export function parseStyle(str, base = emptyStyle()) {
  return applyStyle(base, str, base);
}

/**
 * Turn an expanded format (with #[style] blocks) into runs of { text, style }.
 */
export function toRuns(expanded, base = emptyStyle()) {
  const runs = [];
  let style = base;
  let buf = '';
  const flush = () => { if (buf) { runs.push({ text: buf, style }); buf = ''; } };
  for (let i = 0; i < expanded.length; i++) {
    const c = expanded[i];
    if (c === '#' && expanded[i + 1] === '#') { buf += '#'; i++; continue; }
    if (c === '#' && expanded[i + 1] === '[') {
      const end = expanded.indexOf(']', i + 2);
      if (end !== -1) {
        flush();
        style = applyStyle(style, expanded.slice(i + 2, end), base);
        i = end;
        continue;
      }
    }
    buf += c;
  }
  flush();
  return runs;
}

/** Visible length of runs. */
export function runsLength(runs) {
  return runs.reduce((n, r) => n + [...r.text].length, 0);
}

/** Truncate runs to `max` visible characters (keep the left part). */
export function truncateRuns(runs, max, fromLeft = false) {
  if (max == null || max < 0) return runs;
  const total = runsLength(runs);
  if (total <= max) return runs;
  const out = [];
  if (!fromLeft) {
    let left = max;
    for (const r of runs) {
      if (left <= 0) break;
      const chars = [...r.text];
      out.push({ text: chars.slice(0, left).join(''), style: r.style });
      left -= chars.length;
    }
  } else {
    let skip = total - max;
    for (const r of runs) {
      const chars = [...r.text];
      if (skip >= chars.length) { skip -= chars.length; continue; }
      out.push({ text: chars.slice(skip).join(''), style: r.style });
      skip = 0;
    }
  }
  return out;
}

/** Strip style blocks, returning plain text. */
export function plainText(expanded) {
  return toRuns(expanded).map((r) => r.text).join('');
}

/** CSS declaration object for a style. */
export function styleToCss(style) {
  let fg = style.fg, bg = style.bg;
  const a = style.attrs || {};
  if (a.reverse) [fg, bg] = [bg || 'var(--term-bg)', fg || 'var(--term-fg)'];
  const css = {};
  if (fg) css.color = fg;
  if (bg) css.backgroundColor = bg;
  if (a.bold) css.fontWeight = 'bold';
  if (a.dim) css.opacity = '0.65';
  if (a.italics) css.fontStyle = 'italic';
  const deco = [];
  if (a.underscore) deco.push('underline');
  if (a.strikethrough) deco.push('line-through');
  if (a.overline) deco.push('overline');
  if (deco.length) css.textDecoration = deco.join(' ');
  if (a.hidden) css.visibility = 'hidden';
  if (a.blink) css.animation = 'ctmux-blink 1s steps(1) infinite';
  return css;
}
