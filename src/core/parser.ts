// @ts-nocheck
// tmux configuration / command-line parser.
//
// Implements the parts of tmux's cmd-parse.y grammar that real-world configs
// rely on: quoting rules, backslash line continuation, `;` / `\;` command
// separators, `{ ... }` command blocks, comments, NAME=value assignments with
// $NAME / ${NAME} expansion and %if/%elif/%else/%endif/%hidden directives.

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const DQ_ESCAPES = { n: '\n', t: '\t', r: '\r', e: '\x1b', '"': '"', '\\': '\\', $: '$' };

function expandVar(text, i, env) {
  // text[i] === '$'. Returns [value, nextIndex] or null when not a variable.
  if (text[i + 1] === '{') {
    const end = text.indexOf('}', i + 2);
    if (end === -1) return null;
    const name = text.slice(i + 2, end);
    if (!VAR_RE.test(name)) return null;
    return [lookup(name, env, text.slice(i, end + 1)), end + 1];
  }
  const m = VAR_RE.exec(text.slice(i + 1));
  if (!m) return null;
  return [lookup(m[0], env, '$' + m[0]), i + 1 + m[0].length];
}

function lookup(name, env, literal) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  // Unknown variables (e.g. $HOME, shell-isms) are kept literally: nothing in
  // the browser can resolve them and keeping them makes debugging easier.
  return literal;
}

/**
 * Tokenise tmux configuration text into commands.
 * Returns { commands: [{ args, line }], errors: [{ line, message }], env }.
 * Assignments are applied to `env` as they are encountered.
 */
export function tokenize(text, env = {}) {
  const commands = [];
  const errors = [];
  let args = [];
  let word = null;
  let line = 1;
  let cmdLine = 1;
  let i = 0;
  const n = text.length;

  const pushWord = () => {
    if (word !== null) {
      if (!args.length) cmdLine = wordLine;
      args.push(word);
      word = null;
    }
  };
  let wordLine = 1;
  const startWord = () => { if (word === null) { word = ''; wordLine = line; } };

  const endCommand = () => {
    pushWord();
    if (!args.length) return;
    const first = args[0];
    if (args.length === 1 && typeof first === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      const eq = first.indexOf('=');
      env[first.slice(0, eq)] = first.slice(eq + 1);
      commands.push({ args: [], assign: first.slice(0, eq), line: cmdLine });
    } else if (first === '%hidden' && args.length === 2 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[1])) {
      const eq = args[1].indexOf('=');
      env[args[1].slice(0, eq)] = args[1].slice(eq + 1);
      commands.push({ args: [], assign: args[1].slice(0, eq), line: cmdLine });
    } else {
      commands.push({ args, line: cmdLine });
    }
    args = [];
  };

  while (i < n) {
    const c = text[i];

    if (c === '\n') { line++; i++; endCommand(); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { pushWord(); i++; continue; }
    if (c === '#' && word === null && text[i + 1] !== '{') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') { i += 2; line++; pushWord(); continue; }
      if (nx === '\r' && text[i + 2] === '\n') { i += 3; line++; pushWord(); continue; }
      if (nx === undefined) { i++; continue; }
      startWord();
      word += nx;
      i += 2;
      continue;
    }
    if (c === ';') {
      pushWord();
      // A separator splits the line into independent commands.
      endCommand();
      i++;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) {
        errors.push({ line, message: 'unterminated single quote' });
        i = n;
        break;
      }
      const chunk = text.slice(i + 1, end);
      startWord();
      word += chunk;
      line += (chunk.match(/\n/g) || []).length;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      startWord();
      i++;
      let closed = false;
      while (i < n) {
        const ch = text[i];
        if (ch === '"') { closed = true; i++; break; }
        if (ch === '\\' && i + 1 < n) {
          const nx = text[i + 1];
          if (nx === '\n') { line++; i += 2; continue; }
          word += Object.prototype.hasOwnProperty.call(DQ_ESCAPES, nx) ? DQ_ESCAPES[nx] : '\\' + nx;
          i += 2;
          continue;
        }
        if (ch === '$') {
          const r = expandVar(text, i, env);
          if (r) { word += r[0]; i = r[1]; continue; }
        }
        if (ch === '\n') line++;
        word += ch;
        i++;
      }
      if (!closed) errors.push({ line, message: 'unterminated double quote' });
      continue;
    }
    if (c === '{' && word === null && (i + 1 >= n || /\s/.test(text[i + 1]))) {
      // Command block: capture raw text up to the matching brace.
      let depth = 1;
      let j = i + 1;
      let q = null;
      const startLine = line;
      while (j < n && depth > 0) {
        const ch = text[j];
        if (q) {
          if (ch === '\\' && q === '"') j++;
          else if (ch === q) q = null;
        } else if (ch === "'" || ch === '"') q = ch;
        else if (ch === '#' && /\s/.test(text[j - 1] || ' ')) {
          while (j < n && text[j] !== '\n') j++;
          continue;
        } else if (ch === '{') depth++;
        else if (ch === '}') depth--;
        if (ch === '\n') line++;
        j++;
      }
      if (depth) errors.push({ line: startLine, message: 'unterminated { block' });
      if (!args.length) cmdLine = startLine;
      args.push(new BlockArg(text.slice(i + 1, depth ? j : j - 1).trim()));
      i = j;
      continue;
    }
    if (c === '$') {
      const r = expandVar(text, i, env);
      if (r) { startWord(); word += r[0]; i = r[1]; continue; }
    }
    startWord();
    word += c;
    i++;
  }
  endCommand();
  return { commands, errors, env };
}

/** A `{ ... }` argument: the raw command text inside the braces. */
export class BlockArg {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}

/**
 * Turn a binding/if-shell argument (string, BlockArg or arg array) into a
 * list of commands, each an array of string arguments.
 */
export function toCommandList(value, env = {}) {
  if (value instanceof BlockArg || typeof value === 'string') {
    const { commands } = tokenize(String(value), { ...env });
    return commands.filter((c) => c.args.length).flatMap((c) => splitOnSemicolons(c.args));
  }
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] instanceof BlockArg) return toCommandList(value[0], env);
    return splitOnSemicolons(value);
  }
  return [];
}

// Literal ";" arguments (written `\;`) separate commands in a command list.
function splitOnSemicolons(args) {
  const out = [];
  let cur = [];
  for (const a of args) {
    if (a === ';') { if (cur.length) out.push(cur); cur = []; }
    else cur.push(argToString(a));
  }
  if (cur.length) out.push(cur);
  return out;
}

export function argToString(a) {
  return a instanceof BlockArg ? `{ ${a.text} }` : String(a);
}

/**
 * getopt-style parsing. `spec` follows tmux's template: "aFgt:" where a
 * trailing ':' means the flag takes a value. Parsing stops at the first
 * non-flag argument or at "--".
 */
export function parseArgs(args, spec = '') {
  const takesValue = new Set();
  const known = new Set();
  for (let i = 0; i < spec.length; i++) {
    const ch = spec[i];
    if (ch === ':') continue;
    known.add(ch);
    if (spec[i + 1] === ':') takesValue.add(ch);
  }
  const flags = {};
  const errors = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string' || a[0] !== '-' || a.length < 2) break;
    if (a === '--') { i++; break; }
    if (/^-\d/.test(a)) break; // negative number argument
    for (let j = 1; j < a.length; j++) {
      const f = a[j];
      if (!known.has(f)) errors.push(`unknown flag -${f}`);
      if (takesValue.has(f)) {
        const rest = a.slice(j + 1);
        if (rest) flags[f] = rest;
        else if (i + 1 < args.length) flags[f] = argToString(args[++i]);
        else errors.push(`-${f} expects an argument`);
        break;
      }
      flags[f] = true;
    }
  }
  return { flags, args: args.slice(i), errors };
}

/** Quote an argument the way `tmux list-keys` prints it. */
export function quoteArg(s) {
  s = String(s);
  if (s === '') return "''";
  if (/^[\w@%:.,/=+^~!?<>[\]-]+$/.test(s) && !/^[#~]/.test(s)) return s;
  if (!s.includes("'")) return `'${s}'`;
  return `"${s.replace(/(["\\$])/g, '\\$1')}"`;
}

export function formatCommand(args) {
  return args.map(quoteArg).join(' ');
}

export function formatCommandList(list) {
  return list.map(formatCommand).join(' \\; ');
}
