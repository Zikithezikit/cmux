// @ts-nocheck
// A tiny POSIX-shell subset for `if-shell`, `run-shell` and `display-popup`.
//
// Real tmux hands these strings to /bin/sh. A browser has no shell, but the
// commands that appear in real configs and TPM plugins are a small, familiar
// set: version checks (`tmux -V | cut -c 6-`, `bc`), `[ ... ]` tests,
// `uname`, `command -v`, and plain `tmux set ...` / `tmux bind ...` calls.
// This module parses and runs exactly that subset. Anything outside it throws
// `Unsupported`, and the caller falls back to tmux-in-a-browser behaviour
// (condition false, notice in the debug panel).
//
// The host supplies: env (variables), tmux(argv) for `tmux ...` invocations,
// platform (for `uname`) and version (for `tmux -V`).

export class Unsupported extends Error {}

const unsupported = (what) => { throw new Unsupported(what); };

// ----------------------------------------------------------------- lexer

const OPS = ['&&', '||', ';', '|', '&', '\n'];

/** Find the index just past the `)` closing a `$(` that starts at `i` (pointing after `$(`). */
function matchParen(src, i) {
  let depth = 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); if (j === -1) unsupported('unterminated quote'); i = j; continue; }
    if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return unsupported('unterminated $(');
}

/** Parse `$...` at src[i] (src[i] === '$'). Returns [part, nextIndex]. */
function dollar(src, i, quoted) {
  const nx = src[i + 1];
  if (nx === '(') {
    if (src[i + 2] === '(') unsupported('$(( arithmetic ))');
    const end = matchParen(src, i + 2);
    return [{ t: 'cmd', src: src.slice(i + 2, end - 1), quoted }, end];
  }
  if (nx === '{') {
    const end = src.indexOf('}', i + 2);
    if (end === -1) unsupported('unterminated ${');
    const body = src.slice(i + 2, end);
    let m;
    if ((m = /^#([A-Za-z_]\w*)$/.exec(body))) return [{ t: 'var', name: m[1], len: true, quoted }, end + 1];
    if ((m = /^([A-Za-z_]\w*|[0-9@*#?$!])(?:(:?[-=+])(.*))?$/s.exec(body))) {
      return [{ t: 'var', name: m[1], op: m[2], word: m[3], quoted }, end + 1];
    }
    return unsupported('${' + body + '}');
  }
  const m = /^([A-Za-z_]\w*|[0-9@*#?$!])/.exec(src.slice(i + 1));
  if (!m) return [{ t: 'lit', v: '$', quoted }, i + 1];
  return [{ t: 'var', name: m[1], quoted }, i + 1 + m[1].length];
}

/**
 * Tokenise into words (arrays of parts) and operator strings.
 * Redirections become { redir: '>', fd, target } tokens.
 */
function lex(src) {
  const toks = [];
  let word = null;
  const part = (p) => { (word ||= []).push(p); };
  const flush = () => { if (word) { toks.push({ word }); word = null; } };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { flush(); i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '#' && !word) { while (i < src.length && src[i] !== '\n') i++; continue; }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) { flush(); toks.push({ op: op === '\n' ? ';' : op }); i += op.length; continue; }
    // Redirections: [n]> [n]>> [n]< &> n>&m
    const r = /^(\d?)(>>|>&|>|<|&>)/.exec(src.slice(i));
    if (r && (!word || (r[1] && word.length === 0))) {
      flush();
      i += r[0].length;
      while (src[i] === ' ') i++;
      let j = i;
      while (j < src.length && !/[\s;&|<>()]/.test(src[j])) j++;
      toks.push({ redir: r[2], fd: r[1] === '' ? (r[2] === '<' ? 0 : 1) : Number(r[1]), target: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '(' || c === ')' || c === '{' && !word && /[\s]/.test(src[i + 1] || ' ')) unsupported('command groups');
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j === -1) unsupported('unterminated quote');
      part({ t: 'lit', v: src.slice(i + 1, j), quoted: true });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      part({ t: 'lit', v: '', quoted: true }); // "" is an (empty) word
      i++;
      let buf = '';
      const lit = () => { if (buf) { part({ t: 'lit', v: buf, quoted: true }); buf = ''; } };
      while (i < src.length && src[i] !== '"') {
        const d = src[i];
        if (d === '\\' && '$`"\\\n'.includes(src[i + 1])) { if (src[i + 1] !== '\n') buf += src[i + 1]; i += 2; continue; }
        if (d === '$') { lit(); const [p, n] = dollar(src, i, true); part(p); i = n; continue; }
        if (d === '`') {
          lit();
          const j = src.indexOf('`', i + 1);
          if (j === -1) unsupported('unterminated `');
          part({ t: 'cmd', src: src.slice(i + 1, j), quoted: true });
          i = j + 1;
          continue;
        }
        buf += d;
        i++;
      }
      if (src[i] !== '"') unsupported('unterminated quote');
      lit();
      i++;
      continue;
    }
    if (c === '\\') { part({ t: 'lit', v: src[i + 1] ?? '', quoted: true }); i += 2; continue; }
    if (c === '$') { const [p, n] = dollar(src, i, false); part(p); i = n; continue; }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j === -1) unsupported('unterminated `');
      part({ t: 'cmd', src: src.slice(i + 1, j), quoted: false });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && !/[\s'"\\$`;&|<>()]/.test(src[j])) j++;
    if (j === i) j++;
    part({ t: 'lit', v: src.slice(i, j), quoted: false });
    i = j;
  }
  flush();
  return toks;
}

// ---------------------------------------------------------------- parser

/** -> [{ neg, cmds: [{ words, redirs }], op }] where op joins to the next item. */
function parse(src) {
  const toks = lex(src);
  const list = [];
  let pipeline = { neg: false, cmds: [] };
  let cmd = { words: [], redirs: [] };
  const endCmd = () => {
    if (cmd.words.length || cmd.redirs.length) pipeline.cmds.push(cmd);
    cmd = { words: [], redirs: [] };
  };
  const endPipeline = (op) => {
    endCmd();
    if (pipeline.cmds.length) list.push({ ...pipeline, op });
    else if (op === '&&' || op === '||' || pipeline.neg) unsupported('syntax error');
    pipeline = { neg: false, cmds: [] };
  };
  for (const tk of toks) {
    if (tk.op === '|') { endCmd(); continue; }
    if (tk.op) { endPipeline(tk.op === '&' ? ';' : tk.op); continue; }
    if (tk.redir) { cmd.redirs.push(tk); continue; }
    const w = tk.word;
    if (!cmd.words.length && !pipeline.cmds.length && w.length === 1 && w[0].t === 'lit' && !w[0].quoted) {
      if (w[0].v === '!') { pipeline.neg = !pipeline.neg; continue; }
      if (['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function'].includes(w[0].v)) {
        unsupported(`shell keyword "${w[0].v}"`);
      }
    }
    cmd.words.push(w);
  }
  endPipeline(';');
  return list;
}

// ------------------------------------------------------------- utilities

function breToJs(pat, extended) {
  if (extended) return pat;
  // Basic regular expressions: \( \) \{ \} \| \+ \? are special, bare ones literal.
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\' && i + 1 < pat.length) {
      const n = pat[++i];
      out += '(){}|+?'.includes(n) ? n : '\\' + n;
    } else if ('(){}|+?'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return out;
}

const lines = (s) => { const l = s.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };
const out = (s, code = 0) => ({ code, out: s });

function parseCutList(spec) {
  return String(spec).split(',').map((r) => {
    const m = /^(\d*)(-?)(\d*)$/.exec(r);
    if (!m) unsupported('cut list ' + spec);
    const a = m[1] ? Number(m[1]) : 1;
    const b = m[2] ? (m[3] ? Number(m[3]) : Infinity) : a;
    return [a, b];
  });
}

const inList = (ranges, n) => ranges.some(([a, b]) => n >= a && n <= b);

function trSet(s) {
  let r = '';
  s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\[:space:\]/g, ' \t\n').replace(/\[:digit:\]/g, '0-9')
    .replace(/\[:upper:\]/g, 'A-Z').replace(/\[:lower:\]/g, 'a-z').replace(/\[:alpha:\]/g, 'a-zA-Z');
  for (let i = 0; i < s.length; i++) {
    if (s[i + 1] === '-' && i + 2 < s.length) {
      for (let c = s.charCodeAt(i); c <= s.charCodeAt(i + 2); c++) r += String.fromCharCode(c);
      i += 2;
    } else r += s[i];
  }
  return r;
}

function bcEval(expr) {
  const e = expr.trim();
  if (!e) return '';
  const m = /^(-?[\d.]+)\s*(==|!=|<=|>=|<|>|\+|-|\*|\/|%)\s*(-?[\d.]+)$/.exec(e);
  if (!m) { if (/^-?[\d.]+$/.test(e)) return String(Number(e)); unsupported('bc expression ' + e); }
  const a = Number(m[1]), b = Number(m[3]);
  const r = { '==': +(a === b), '!=': +(a !== b), '<=': +(a <= b), '>=': +(a >= b), '<': +(a < b), '>': +(a > b),
    '+': a + b, '-': a - b, '*': a * b, '/': b ? Math.trunc(a / b) : 0, '%': b ? a % b : 0 }[m[2]];
  return String(r);
}

/** `test` / `[` evaluation. Returns an exit code. File tests can't be answered: they're false. */
function testExpr(args, sh) {
  const num = (s) => { if (!/^\s*-?\d+\s*$/.test(s)) throw new Error(`integer expression expected: ${s}`); return Number(s); };
  let i = 0;
  const primary = () => {
    const a = args[i];
    if (a === '!') { i++; return !primary(); }
    if (a === '(') { i++; const v = orExpr(); i++; return v; }
    const b = args[i + 1];
    const binops = ['=', '==', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '<', '>', '=~'];
    if (b !== undefined && binops.includes(b) && i + 2 < args.length + 1) {
      const c = args[i + 2] ?? '';
      i += 3;
      switch (b) {
        case '=': case '==': return sh.glob ? globMatch(c, a) : a === c;
        case '!=': return a !== c;
        case '<': return a < c;
        case '>': return a > c;
        case '=~': try { return new RegExp(c).test(a); } catch { return false; }
        case '-eq': return num(a) === num(c);
        case '-ne': return num(a) !== num(c);
        case '-lt': return num(a) < num(c);
        case '-le': return num(a) <= num(c);
        case '-gt': return num(a) > num(c);
        case '-ge': return num(a) >= num(c);
      }
    }
    if (/^-[a-zA-Z]$/.test(a) && b !== undefined) {
      i += 2;
      if (a === '-n') return b !== '';
      if (a === '-z') return b === '';
      if (a === '-t') return false;
      sh.note?.(`file test ${a} ${b}: no file system in the browser, treated as false`);
      return false;
    }
    i++;
    return a !== undefined && a !== '';
  };
  const andExpr = () => { let v = primary(); while (args[i] === '-a' || args[i] === '&&') { i++; const r = primary(); v = v && r; } return v; };
  const orExpr = () => { let v = andExpr(); while (args[i] === '-o' || args[i] === '||') { i++; const r = andExpr(); v = v || r; } return v; };
  if (!args.length) return 1;
  try { return orExpr() ? 0 : 1; } catch { return 2; }
}

function globMatch(glob, s) {
  let re = '';
  for (const ch of glob) re += ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + re + '$').test(s);
}

// ---------------------------------------------------------------- builtins

const KNOWN = new Set(['tmux', 'echo', 'printf', 'test', '[', '[[', 'true', 'false', ':', 'uname', 'cut', 'grep', 'egrep',
  'sed', 'tr', 'awk', 'bc', 'head', 'tail', 'cat', 'command', 'which', 'type', 'exit', 'sh', 'bash', 'cd', 'wc', 'sort', 'export']);

const BUILTINS = {
  true: () => out(''),
  ':': () => out(''),
  false: () => out('', 1),
  exit: (a) => ({ code: Number(a[0] ?? 0) || 0, out: '', exit: true }),
  cd: () => out(''),
  export: (a, input, sh) => {
    for (const kv of a) { const m = /^([A-Za-z_]\w*)=(.*)$/s.exec(kv); if (m) sh.env[m[1]] = m[2]; }
    return out('');
  },
  echo: (a) => {
    let nl = true, esc = false;
    while (a[0] && /^-[neE]+$/.test(a[0])) { const f = a.shift(); if (f.includes('n')) nl = false; if (f.includes('e')) esc = true; }
    let s = a.join(' ');
    if (esc) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    return out(s + (nl ? '\n' : ''));
  },
  printf: (a) => {
    const fmt = (a.shift() ?? '').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    let k = 0;
    return out(fmt.replace(/%([-0-9.]*)([sdf%])/g, (all, w, c) => {
      if (c === '%') return '%';
      const v = a[k++] ?? '';
      if (c === 'd') return String(Math.trunc(Number(v) || 0));
      if (c === 'f') return (Number(v) || 0).toFixed(/\.(\d+)/.exec(w)?.[1] ? Number(/\.(\d+)/.exec(w)[1]) : 6);
      return v;
    }));
  },
  test: (a, input, sh) => out('', testExpr(a, sh)),
  '[': (a, input, sh) => { if (a[a.length - 1] !== ']') return out('', 2); return out('', testExpr(a.slice(0, -1), sh)); },
  '[[': (a, input, sh) => { if (a[a.length - 1] !== ']]') return out('', 2); return out('', testExpr(a.slice(0, -1), { ...sh, glob: true })); },
  uname: (a, input, sh) => {
    const p = sh.platform;
    if (!a.length || a.includes('-s')) return out(p + '\n');
    if (a.includes('-m')) return out('x86_64\n');
    if (a.includes('-r')) return out('0\n');
    if (a.includes('-a')) return out(`${p} chrome 0 x86_64\n`);
    return out(p + '\n');
  },
  command: (a) => {
    if (a[0] === '-v' || a[0] === '-V') return KNOWN.has(a[1]) ? out(a[1] + '\n') : out('', 1);
    return unsupported('command ' + a.join(' '));
  },
  which: (a) => (a.every((x) => KNOWN.has(x)) ? out(a.map((x) => `/usr/bin/${x}\n`).join('')) : out('', 1)),
  type: (a) => (a.every((x) => KNOWN.has(x.replace(/^-.*/, 'echo'))) ? out('') : out('', 1)),
  cat: (a, input) => { if (a.length && a[0] !== '-') unsupported('cat file'); return out(input); },
  head: (a, input) => {
    const n = Number(a[0] === '-n' ? a[1] : /^-(\d+)$/.exec(a[0] || '')?.[1] ?? 10);
    if (a.some((x, i) => !/^-/.test(x) && !(a[i - 1] === '-n'))) unsupported('head file');
    return out(lines(input).slice(0, n).map((l) => l + '\n').join(''));
  },
  tail: (a, input) => {
    const n = Number(a[0] === '-n' ? a[1] : /^-(\d+)$/.exec(a[0] || '')?.[1] ?? 10);
    if (a.some((x, i) => !/^-/.test(x) && !(a[i - 1] === '-n'))) unsupported('tail file');
    return out(lines(input).slice(-n).map((l) => l + '\n').join(''));
  },
  wc: (a, input) => {
    if (a.includes('-l')) return out(lines(input).length + '\n');
    if (a.includes('-c') || a.includes('-m')) return out(input.length + '\n');
    if (a.includes('-w')) return out(input.split(/\s+/).filter(Boolean).length + '\n');
    return unsupported('wc');
  },
  sort: (a, input) => {
    let l = lines(input);
    l = a.includes('-n') ? l.sort((x, y) => parseFloat(x) - parseFloat(y)) : l.sort();
    if (a.includes('-r')) l.reverse();
    if (a.includes('-u')) l = [...new Set(l)];
    return out(l.map((x) => x + '\n').join(''));
  },
  cut: (a, input) => {
    let delim = '\t', fields = null, chars = null;
    for (let i = 0; i < a.length; i++) {
      let m;
      if (a[i] === '-d') delim = a[++i];
      else if ((m = /^-d(.+)$/s.exec(a[i]))) delim = m[1];
      else if (a[i] === '-f') fields = parseCutList(a[++i]);
      else if ((m = /^-f(.+)$/.exec(a[i]))) fields = parseCutList(m[1]);
      else if (a[i] === '-c' || a[i] === '-b') chars = parseCutList(a[++i]);
      else if ((m = /^-[cb](.+)$/.exec(a[i]))) chars = parseCutList(m[1]);
      else unsupported('cut ' + a[i]);
    }
    return out(lines(input).map((l) => {
      if (chars) return [...l].filter((_, k) => inList(chars, k + 1)).join('');
      if (!fields) unsupported('cut without -f/-c');
      if (!l.includes(delim)) return l;
      return l.split(delim).filter((_, k) => inList(fields, k + 1)).join(delim);
    }).map((l) => l + '\n').join(''));
  },
  grep: (a, input) => {
    let quiet = false, ci = false, ext = false, inv = false, only = false, fixed = false, count = false;
    const pats = [];
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '-e') { pats.push(a[++i]); continue; }
      if (x === '--') { pats.push(...a.slice(i + 1)); break; }
      if (/^-[a-zA-Z]+$/.test(x)) {
        for (const f of x.slice(1)) {
          if (f === 'q' || f === 's') quiet ||= f === 'q';
          else if (f === 'i') ci = true;
          else if (f === 'E') ext = true;
          else if (f === 'v') inv = true;
          else if (f === 'o') only = true;
          else if (f === 'F') fixed = true;
          else if (f === 'c') count = true;
          else if (f === 'w' || f === 'x' || f === 'P') ext = true; // approximations
          else unsupported('grep -' + f);
        }
        continue;
      }
      pats.push(x);
    }
    if (!pats.length) return out('', 2);
    if (pats.length > 1 && !a.includes('-e')) unsupported('grep file');
    const res = pats.map((p) => new RegExp(fixed ? p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : breToJs(p, ext), ci ? 'i' : ''));
    const hits = [];
    for (const l of lines(input)) {
      const m = res.map((r) => r.exec(l)).find(Boolean);
      if (!!m !== inv) hits.push(only && m ? m[0] : l);
    }
    if (count) return out(hits.length + '\n', hits.length ? 0 : 1);
    return out(quiet ? '' : hits.map((l) => l + '\n').join(''), hits.length ? 0 : 1);
  },
  sed: (a, input) => {
    let ext = false, quiet = false;
    const exprs = [];
    for (let i = 0; i < a.length; i++) {
      if (/^-[Ernu]+$/.test(a[i])) { if (/[Er]/.test(a[i])) ext = true; if (a[i].includes('n')) quiet = true; }
      else if (a[i] === '-e') exprs.push(a[++i]);
      else if (/^-/.test(a[i])) unsupported('sed ' + a[i]);
      else if (!exprs.length) exprs.push(a[i]);
      else unsupported('sed file');
    }
    const subs = exprs.flatMap((e) => e.split(/;\s*(?=s.)/)).map((e) => {
      const d = e[1];
      if (e[0] !== 's' || !d) unsupported('sed ' + e);
      const parts = [];
      let cur = '';
      for (let i = 2; i < e.length; i++) {
        if (e[i] === '\\' && e[i + 1] === d) { cur += d; i++; continue; }
        if (e[i] === d) { parts.push(cur); cur = ''; continue; }
        cur += e[i];
      }
      parts.push(cur);
      const [pat, rep, flags = ''] = parts;
      if (rep === undefined) unsupported('sed ' + e);
      return {
        re: new RegExp(breToJs(pat, ext), (flags.includes('g') ? 'g' : '') + (flags.includes('I') || flags.includes('i') ? 'i' : '')),
        rep: rep.replace(/\$/g, '$$$$').replace(/\\(\d)/g, '$$$1').replace(/&/g, '$$&'),
        print: flags.includes('p'),
      };
    });
    const res = [];
    for (let l of lines(input)) {
      let printed = false;
      for (const s of subs) {
        if (s.re.test(l)) { s.re.lastIndex = 0; l = l.replace(s.re, s.rep); if (s.print) printed = true; }
        s.re.lastIndex = 0;
      }
      if (!quiet || printed) res.push(l + '\n');
    }
    return out(res.join(''));
  },
  tr: (a, input) => {
    if (a[0] === '-d') { const set = trSet(a[1] ?? ''); return out([...input].filter((c) => !set.includes(c)).join('')); }
    if (a.length !== 2) unsupported('tr ' + a.join(' '));
    const from = trSet(a[0]), to = trSet(a[1]);
    return out([...input].map((c) => { const k = from.indexOf(c); return k === -1 ? c : to[Math.min(k, to.length - 1)]; }).join(''));
  },
  awk: (a, input) => {
    let sep = null;
    const rest = [];
    for (let i = 0; i < a.length; i++) {
      let m;
      if (a[i] === '-F') sep = a[++i];
      else if ((m = /^-F(.+)$/.exec(a[i]))) sep = m[1];
      else rest.push(a[i]);
    }
    const m = /^\s*\{\s*print\s+((?:\$(?:\d+|NF)\s*,?\s*)+)\}\s*$/.exec(rest[0] || '');
    if (!m || rest.length > 1) unsupported('awk ' + (rest[0] || ''));
    const cols = m[1].match(/\$(\d+|NF)/g).map((c) => c.slice(1));
    return out(lines(input).map((l) => {
      const f = sep == null ? l.trim().split(/\s+/) : l.split(sep);
      return cols.map((c) => (c === 'NF' ? f[f.length - 1] : c === '0' ? l : f[Number(c) - 1] ?? '')).join(' ') + '\n';
    }).join(''));
  },
  bc: (a, input) => out(lines(input).map((l) => bcEval(l) + '\n').join('')),
};
BUILTINS.egrep = (a, input, sh) => BUILTINS.grep(['-E', ...a], input, sh);

// --------------------------------------------------------------- execution

export class Shell {
  /**
   * host: { env: object, tmux: async (argv) => { code, out }, platform, version, note }
   */
  constructor(host) {
    this.host = host;
    this.env = { ...host.env };
    this.platform = host.platform || 'Linux';
    this.note = host.note;
    this.depth = 0;
  }

  async expandWord(word) {
    // -> array of fields
    const fields = [];
    let cur = null;
    const add = (s) => { cur = (cur ?? '') + s; };
    for (const p of word) {
      let v;
      if (p.t === 'lit') {
        if (p.quoted) { add(p.v); continue; }
        add(p.v);
        continue;
      }
      if (p.t === 'var') v = this.varValue(p);
      else v = (await this.run(p.src)).out.replace(/\n+$/, '');
      if (p.quoted) { add(v); continue; }
      const parts = v.split(/[ \t\n]+/);
      parts.forEach((s, k) => {
        if (k > 0) { if (cur !== null) fields.push(cur); cur = null; }
        if (s !== '') add(s);
      });
    }
    if (cur !== null) fields.push(cur);
    return fields;
  }

  varValue(p) {
    const has = Object.prototype.hasOwnProperty.call(this.env, p.name);
    const val = has ? String(this.env[p.name]) : p.name === '?' ? String(this.lastCode ?? 0) : '';
    if (p.len) return String(val.length);
    if (!p.op) return val;
    const unsetOrNull = p.op.startsWith(':') ? val === '' : !has;
    const op = p.op.replace(':', '');
    if (op === '-') return unsetOrNull ? p.word : val;
    if (op === '=') { if (unsetOrNull) this.env[p.name] = p.word; return unsetOrNull ? p.word : val; }
    if (op === '+') return unsetOrNull ? '' : p.word;
    return val;
  }

  /** Run a script. Returns { code, out }. Throws Unsupported. */
  async run(src) {
    if (++this.depth > 8) unsupported('nesting too deep');
    try {
      const list = parse(String(src));
      let code = 0;
      let output = '';
      let prev = ';'; // connector between the previous item and this one
      for (const item of list) {
        const skip = (prev === '&&' && code !== 0) || (prev === '||' && code === 0);
        prev = item.op;
        if (skip) continue;
        const r = await this.pipeline(item);
        code = r.code;
        output += r.out;
        this.lastCode = code;
        if (r.exit) break;
      }
      return { code, out: output };
    } finally {
      this.depth--;
    }
  }

  async pipeline({ neg, cmds }) {
    let input = '';
    let r = { code: 0, out: '' };
    for (const c of cmds) {
      r = await this.simple(c, input);
      input = r.out;
      if (r.exit) break;
    }
    return { code: neg ? (r.code === 0 ? 1 : 0) : r.code, out: r.out, exit: r.exit };
  }

  async simple({ words, redirs }, input) {
    const argv = [];
    for (const w of words) argv.push(...(await this.expandWord(w)));
    // Leading NAME=value assignments.
    const assigns = [];
    while (argv.length && /^[A-Za-z_]\w*=/.test(argv[0])) assigns.push(argv.shift());
    if (!argv.length) {
      for (const a of assigns) { const k = a.indexOf('='); this.env[a.slice(0, k)] = a.slice(k + 1); }
      return out('');
    }
    let dropOut = false;
    for (const r of redirs) {
      const t = r.target;
      if (r.redir === '<') unsupported('input redirection');
      if (r.fd === 2 && (t === '/dev/null' || t === '1' || t === '&1')) continue;
      if (r.redir === '>&' && t === '2') { dropOut = true; continue; }
      if (r.redir === '>&' && t === '1') continue;
      if (t === '/dev/null') { dropOut = true; continue; }
      if (r.fd === 2) continue;
      unsupported('redirection to ' + t);
    }
    const [name, ...args] = argv;
    let res;
    if (name === 'tmux') res = await this.tmux(args);
    else if (name === 'sh' || name === 'bash') {
      if (args[0] !== '-c') unsupported(`${name} script`);
      res = await this.run(args[1] ?? '');
    } else if (BUILTINS[name]) res = BUILTINS[name](args, input, this);
    else unsupported(`command "${name}"`);
    return dropOut ? { ...res, out: '' } : res;
  }

  async tmux(args) {
    // Global flags: -2 -u -v -C -l -N, -L name, -S path, -f file, -T features.
    const a = args.slice();
    while (a.length && /^-[2uvClN]+$|^-[LSfT]/.test(a[0])) {
      const f = a.shift();
      if (/^-[LSfT]$/.test(f)) a.shift();
    }
    if (a[0] === '-V') return out(`tmux ${this.host.version || '3.4'}\n`);
    if (!a.length) return out('');
    return this.host.tmux(a);
  }
}

/** Convenience wrapper: run `src` with `host`. Returns { code, out } or throws Unsupported. */
export async function runShell(src, host) {
  return new Shell(host).run(src);
}
