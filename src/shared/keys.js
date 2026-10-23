/*
 * Key handling shared by the workspace page (ES module side-effect import) and
 * the pane content script (classic script). Exposes globalThis.CtmuxKeys.
 *
 * Keys use tmux notation: "C-s", "M-x", "S-Up", "%", "Space", "PPage", ...
 */
(function (root) {
  'use strict';

  const NAMED = {
    Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'BSpace',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PPage', PageDown: 'NPage',
    Insert: 'IC', Delete: 'DC',
  };
  for (let i = 1; i <= 12; i++) NAMED['F' + i] = 'F' + i;

  const ALIASES = {
    enter: 'Enter', escape: 'Escape', esc: 'Escape', space: 'Space', tab: 'Tab',
    btab: 'BTab', bspace: 'BSpace', backspace: 'BSpace', up: 'Up', down: 'Down',
    left: 'Left', right: 'Right', home: 'Home', end: 'End', ic: 'IC', insert: 'IC',
    dc: 'DC', delete: 'DC', ppage: 'PPage', pageup: 'PPage', pgup: 'PPage',
    npage: 'NPage', pagedown: 'NPage', pgdn: 'NPage', none: 'None',
  };

  const MODIFIER_ONLY = new Set([
    'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock',
    'ScrollLock', 'Dead', 'Unidentified', 'OS', 'Hyper', 'Super', 'Fn', 'Process',
  ]);

  /** Canonicalise a tmux key string. Returns null for empty / "None". */
  function normalizeKey(str) {
    let s = String(str == null ? '' : str).trim();
    if (!s) return null;
    let ctrl = false, meta = false, shift = false;
    for (;;) {
      if (s.length > 2 && /^[CMS]-/i.test(s)) {
        const m = s[0].toUpperCase();
        if (m === 'C') ctrl = true; else if (m === 'M') meta = true; else shift = true;
        s = s.slice(2);
        continue;
      }
      if (s.length === 2 && s[0] === '^') { ctrl = true; s = s.slice(1); continue; }
      break;
    }
    let base;
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
  function eventToKey(e) {
    const k = e.key;
    if (!k || MODIFIER_ONLY.has(k) || e.isComposing) return null;
    let base, shift = e.shiftKey;
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
  function createRouter(getConfig, now) {
    now = now || Date.now;
    let table = 'root';
    let repeatUntil = 0;

    function feed(input) {
      const key = typeof input === 'string' ? normalizeKey(input) : eventToKey(input);
      if (!key) return null;
      const cfg = getConfig() || {};
      const tables = cfg.tables || {};
      const repeat = cfg.repeat || {};

      if (table === 'root') {
        if (key === cfg.prefix || (cfg.prefix2 && key === cfg.prefix2)) {
          table = 'prefix';
          repeatUntil = 0;
          return { table: 'root', key, prefix: true };
        }
        if (tables.root && tables.root.indexOf(key) !== -1) return { table: 'root', key };
        return null;
      }

      const t = table;
      if (repeatUntil) {
        if (now() <= repeatUntil && repeat[t] && repeat[t].indexOf(key) !== -1) {
          repeatUntil = now() + (cfg.repeatTime || 0);
          return { table: t, key };
        }
        table = 'root';
        repeatUntil = 0;
        return feed(key);
      }
      if (repeat[t] && repeat[t].indexOf(key) !== -1 && cfg.repeatTime > 0) {
        repeatUntil = now() + cfg.repeatTime;
      } else {
        table = 'root';
      }
      return { table: t, key };
    }

    return {
      feed,
      get table() { return table; },
      setTable(name) { table = name || 'root'; repeatUntil = 0; },
      reset() { table = 'root'; repeatUntil = 0; },
    };
  }

  root.CtmuxKeys = { normalizeKey, eventToKey, createRouter };
})(typeof globalThis !== 'undefined' ? globalThis : self);
