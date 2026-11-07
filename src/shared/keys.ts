/*
 * Key handling shared by the workspace page (ES module side-effect import) and
 * the pane content script (classic script). Exposes globalThis.CtmuxKeys.
 *
 * Keys use tmux notation: "C-s", "M-x", "S-Up", "%", "Space", "PPage", ...
 */
(function (root: typeof globalThis) {
  'use strict';

  const NAMED: Record<string, string> = {
    Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'BSpace',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PPage', PageDown: 'NPage',
    Insert: 'IC', Delete: 'DC',
  };
  for (let i = 1; i <= 12; i++) NAMED['F' + i] = 'F' + i;

  const ALIASES: Readonly<Record<string, string>> = {
    enter: 'Enter', escape: 'Escape', esc: 'Escape', space: 'Space', tab: 'Tab',
    btab: 'BTab', bspace: 'BSpace', backspace: 'BSpace', up: 'Up', down: 'Down',
    left: 'Left', right: 'Right', home: 'Home', end: 'End', ic: 'IC', insert: 'IC',
    dc: 'DC', delete: 'DC', ppage: 'PPage', pageup: 'PPage', pgup: 'PPage',
    npage: 'NPage', pagedown: 'NPage', pgdn: 'NPage', none: 'None',
  };

  const MODIFIER_ONLY: ReadonlySet<string> = new Set([
    'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock',
    'ScrollLock', 'Dead', 'Unidentified', 'OS', 'Hyper', 'Super', 'Fn', 'Process',
  ]);

  /** Canonicalise a tmux key string. Returns null for empty / "None". */
  function normalizeKey(str: string | null | undefined): string | null {
    let s = String(str ?? '').trim();
    if (!s) return null;
    let ctrl = false, meta = false, shift = false;
    for (;;) {
      if (s.length > 2 && /^[CMS]-/i.test(s)) {
        const m = s[0].toUpperCase();
        if (m === 'C') ctrl = true; else if (m === 'M') meta = true; else shift = true;
        s = s.slice(2);
        continue;
      }
      if (s.length === 2 && s.startsWith('^')) { ctrl = true; s = s.slice(1); continue; }
      break;
    }
    let base: string;
    if (s.length === 1) {
      base = s;
      if (/[a-z]/i.test(base)) {
        if (ctrl) base = base.toLowerCase();
        else if (shift) base = base.toUpperCase();
      }
      shift = false;
    } else {
      const lower = s.toLowerCase();
      if (ALIASES[lower]) base = ALIASES[lower];
      else if (/^f\d{1,2}$/.test(lower)) base = 'F' + lower.slice(1);
      else base = s;
      if (base === 'None' && !ctrl && !meta && !shift) return null;
      if (base === 'Tab' && shift) { base = 'BTab'; shift = false; }
    }
    return (ctrl ? 'C-' : '') + (meta ? 'M-' : '') + (shift ? 'S-' : '') + base;
  }

  /** Convert a KeyboardEvent into a canonical tmux key, or null. */
  function eventToKey(e: CtmuxKeyEvent): string | null {
    const k = e.key;
    if (!k || MODIFIER_ONLY.has(k) || e.isComposing) return null;
    let base: string, shift = e.shiftKey;
    if (k.length === 1) {
      base = k;
      if (e.altKey && /^Key[A-Z]$/.test(e.code || '')) {
        base = shift ? e.code[3] : e.code[3].toLowerCase();
      } else if (e.altKey && /^Digit\d$/.test(e.code || '') && !shift) {
        base = e.code[5];
      }
      if (base === ' ') base = 'Space';
      shift = false;
    } else if (NAMED[k]) {
      base = NAMED[k];
      if (base === 'Tab' && shift) { base = 'BTab'; shift = false; }
    } else {
      return null;
    }
    return normalizeKey((e.ctrlKey ? 'C-' : '') + (e.altKey ? 'M-' : '') + (shift ? 'S-' : '') + base);
  }

  /**
   * Key table state machine (root → prefix → root, repeat mode, custom tables).
   * getConfig() returns { prefix, prefix2, tables: {name: [keys]}, repeat: {name: [keys]}, repeatTime }.
   * feed() returns null when the key should pass through to the page, otherwise
   * { table, key, prefix? } describing what the workspace should execute.
   */
  function createRouter(getConfig: () => CtmuxRouterConfig | null | undefined, now?: () => number): CtmuxKeyRouter {
    const clock = now || Date.now;
    let table = 'root';
    let repeatUntil = 0;

    function feed(input: string | CtmuxKeyEvent): CtmuxRoute | null {
      const key = typeof input === 'string' ? normalizeKey(input) : eventToKey(input);
      if (!key) return null;
      const cfg: CtmuxRouterConfig = getConfig() || {};
      const tables = cfg.tables || {};
      const repeat = cfg.repeat || {};

      if (table === 'root') {
        if (key === cfg.prefix || (cfg.prefix2 && key === cfg.prefix2)) {
          table = 'prefix';
          repeatUntil = 0;
          return { table: 'root', key, prefix: true };
        }
        if (tables.root?.includes(key)) return { table: 'root', key };
        return null;
      }

      const t = table;
      const repeatTime = cfg.repeatTime || 0;
      if (repeatUntil) {
        if (clock() <= repeatUntil && repeat[t]?.includes(key)) {
          repeatUntil = clock() + repeatTime;
          return { table: t, key };
        }
        table = 'root';
        repeatUntil = 0;
        return feed(key);
      }
      if (repeat[t]?.includes(key) && repeatTime > 0) {
        repeatUntil = clock() + repeatTime;
      } else {
        table = 'root';
      }
      return { table: t, key };
    }

    return {
      feed,
      get table() { return table; },
      setTable(name?: string | null) { table = name || 'root'; repeatUntil = 0; },
      reset() { table = 'root'; repeatUntil = 0; },
    };
  }

  root.CtmuxKeys = { normalizeKey, eventToKey, createRouter };
})(typeof globalThis !== 'undefined' ? globalThis : self);

/** Tables the key router consults (a subset of the workspace runtime config). */
interface CtmuxRouterConfig {
  readonly prefix?: string | null;
  readonly prefix2?: string | null;
  /** Bound keys per table name. */
  readonly tables?: Readonly<Record<string, readonly string[]>>;
  /** Repeatable keys per table name. */
  readonly repeat?: Readonly<Record<string, readonly string[]>>;
  readonly repeatTime?: number;
}

/** What the workspace should execute for a routed key. */
interface CtmuxRoute {
  table: string;
  key: string;
  prefix?: boolean;
}

/** The parts of a KeyboardEvent that eventToKey() reads. */
type CtmuxKeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'isComposing'>;

interface CtmuxKeyRouter {
  feed(input: string | CtmuxKeyEvent): CtmuxRoute | null;
  readonly table: string;
  setTable(name?: string | null): void;
  reset(): void;
}

interface CtmuxKeysApi {
  normalizeKey(str: string | null | undefined): string | null;
  eventToKey(e: CtmuxKeyEvent): string | null;
  createRouter(getConfig: () => CtmuxRouterConfig | null | undefined, now?: () => number): CtmuxKeyRouter;
}

// Only a global `var` adds a property to globalThis in a classic script; it is read as globalThis.CtmuxKeys.
// eslint-disable-next-line no-var, @typescript-eslint/no-unused-vars
declare var CtmuxKeys: CtmuxKeysApi;
