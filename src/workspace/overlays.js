// Modal UI: status-line prompts/messages, list views, choose-tree, the fuzzy
// picker, display-panes, clock-mode, the detached screen and the debug panel.

import { COMMANDS } from '../core/commands.js';
import { colourToCss } from '../core/format.js';
import * as L from '../core/layout.js';
import { quoteArg } from '../core/parser.js';
import { toUrl } from '../core/commands.js';

const toPopupUrl = (v, t) => toUrl(v, t.getOption('@ctmux-search-url'));

const { eventToKey } = globalThis.CtmuxKeys;

const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
};

/** Fuzzy match (fzf-ish): returns score or -1, plus matched indexes. */
export function fuzzy(needle, hay) {
  if (!needle) return { score: 0, idx: [] };
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  const sub = h.indexOf(n);
  if (sub !== -1) return { score: 1000 - sub - h.length / 100, idx: [...n].map((_, i) => sub + i) };
  let j = 0, score = 0, last = -2;
  const idx = [];
  for (let i = 0; i < h.length && j < n.length; i++) {
    if (h[i] === n[j]) {
      score += last === i - 1 ? 5 : 1;
      if (i === 0 || /[\W_]/.test(h[i - 1])) score += 3;
      idx.push(i);
      last = i;
      j++;
    }
  }
  return j === n.length ? { score, idx } : { score: -1, idx: [] };
}

function highlight(text, idx) {
  if (!idx.length) return [text];
  const set = new Set(idx);
  const out = [];
  let buf = '';
  let inMark = false;
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== inMark) { if (buf) out.push(inMark ? el('mark', {}, buf) : buf); buf = ''; inMark = m; }
    buf += text[i];
  }
  if (buf) out.push(inMark ? el('mark', {}, buf) : buf);
  return out;
}

export class Overlays {
  constructor(app) {
    this.app = app; // workspace controller
    this.root = document.getElementById('overlay');
    this.stack = [];
    this.statusOverlay = null;
    this.messageTimer = null;
    this.promptHistory = [];
  }

  get t() { return this.app.t; }

  get active() { return this.stack[this.stack.length - 1] || null; }

  /** Route a keydown to the top overlay. Returns true if consumed. */
  onKey(e) {
    const top = this.active;
    if (!top) return false;
    return top.onKey ? top.onKey(e) !== false : true;
  }

  push(entry) {
    this.stack.push(entry);
    this.app.keySink();
    return entry;
  }

  close(entry, { refocus = true } = {}) {
    const i = this.stack.indexOf(entry);
    if (i === -1) return;
    this.stack.splice(i, 1);
    entry.dom?.remove();
    entry.cleanup?.();
    if (refocus && !this.stack.length) this.app.focusPane();
    else if (this.stack.length) this.stack[this.stack.length - 1].refocus?.();
  }

  closeAll() {
    for (const e of this.stack.slice().reverse()) this.close(e, { refocus: false });
  }

  /** Pane-area rectangle for overlays (tmux draws modes inside the pane). */
  paneBox(zoom = true) {
    const area = this.app.view.areaRect;
    if (zoom) return area;
    const w = this.t.server.window;
    return (w && this.app.view.rects[w.active]) || area;
  }

  place(dom, r) {
    Object.assign(dom.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }

  // ----------------------------------------------------------- status line

  message(text, { duration } = {}) {
    if (this.statusOverlay?.prompt) return; // don't clobber an active prompt
    clearTimeout(this.messageTimer);
    this.statusOverlay = { message: String(text) };
    this.app.renderStatus();
    const ms = duration ?? Number(this.t.getOption('display-time'));
    const clear = () => {
      if (this.statusOverlay?.message != null) { this.statusOverlay = null; this.app.renderStatus(); }
    };
    if (ms > 0) this.messageTimer = setTimeout(clear, ms);
    this.dismissMessage = clear;
  }

  /**
   * Prompt in the status line. Resolves to an array of answers or null.
   * opts: { prompts, inputs, single, numeric, command }
   */
  prompt(opts) {
    return new Promise((resolve) => {
      const answers = [];
      let step = 0;
      let histPos = -1;
      const label = el('span');
      const input = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off' });
      const box = el('div', { class: 'prompt' }, label, input);
      const entry = { kind: 'prompt' };

      const show = () => {
        label.textContent = opts.prompts[step] ?? opts.prompts[opts.prompts.length - 1] ?? ':';
        input.value = opts.inputs?.[step] ?? '';
        clearTimeout(this.messageTimer);
        this.statusOverlay = { prompt: box, command: opts.command };
        this.app.renderStatus();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      };
      const finish = (val) => {
        this.statusOverlay = null;
        this.close(entry);
        this.app.renderStatus();
        resolve(val);
      };
      const accept = () => {
        const v = input.value;
        if (opts.command && v.trim()) {
          this.promptHistory = [v, ...this.promptHistory.filter((h) => h !== v)].slice(0, 100);
        }
        answers.push(v);
        step++;
        if (step < opts.prompts.length) show();
        else finish(answers);
      };

      entry.refocus = () => input.focus();
      entry.onKey = (e) => {
        if (e.target !== input) { input.focus(); }
        const key = eventToKey(e);
        if (!key) return true;
        if (opts.single && key.length === 1) { e.preventDefault(); input.value = key; accept(); return true; }
        if (opts.single && key === 'Space') { e.preventDefault(); input.value = ' '; accept(); return true; }
        switch (key) {
          case 'Enter': e.preventDefault(); accept(); return true;
          case 'Escape': case 'C-c': case 'C-g': e.preventDefault(); finish(null); return true;
          case 'C-u': e.preventDefault(); input.value = ''; return true;
          case 'Up': case 'C-p':
            if (!opts.command) return true;
            e.preventDefault();
            histPos = Math.min(this.promptHistory.length - 1, histPos + 1);
            if (histPos >= 0) input.value = this.promptHistory[histPos];
            return true;
          case 'Down': case 'C-n':
            if (!opts.command) return true;
            e.preventDefault();
            histPos = Math.max(-1, histPos - 1);
            input.value = histPos >= 0 ? this.promptHistory[histPos] : '';
            return true;
          case 'Tab': {
            e.preventDefault();
            if (!opts.command) return true;
            const words = input.value.split(/\s+/);
            if (words.length === 1) {
              const names = [...COMMANDS.keys()].filter((n) => n.startsWith(words[0])).sort();
              if (names.length === 1) input.value = names[0] + ' ';
              else if (names.length > 1) this.app.flashStatusHint(names.join(' '));
            }
            return true;
          }
        }
        if (opts.numeric && key.length === 1 && !/\d/.test(key)) { e.preventDefault(); return true; }
        // Let the input handle editing keys natively.
        e.stopPropagation();
        return true;
      };
      input.addEventListener('blur', () => {
        setTimeout(() => { if (this.active === entry && document.activeElement !== input) input.focus(); }, 0);
      });
      this.push(entry);
      show();
    });
  }

  confirm(text, { defaultYes = false, confirmKey = 'y' } = {}) {
    return new Promise((resolve) => {
      const entry = { kind: 'confirm' };
      const box = el('div', { class: 'prompt' }, el('span', {}, text + ' '));
      this.statusOverlay = { prompt: box };
      this.app.renderStatus();
      const finish = (v) => {
        this.statusOverlay = null;
        this.close(entry);
        this.app.renderStatus();
        resolve(v);
      };
      entry.onKey = (e) => {
        const key = eventToKey(e);
        if (!key) return true;
        e.preventDefault();
        if (key === confirmKey || (defaultYes && key === 'Enter')) finish(true);
        else finish(false);
        return true;
      };
      this.push(entry);
    });
  }

  // ------------------------------------------------------------ list views

  /** Generic scrolling list, optionally filterable and selectable. */
  list({ title, rows, filterable = false, select = false, hint = '', onSelect, onKey, zoom = true, initial = 0, filter = '' }) {
    const entry = { kind: 'list' };
    const body = el('div', { class: 'ov-body' });
    const filterInput = el('input', { type: 'text', spellcheck: 'false', placeholder: 'filter' });
    filterInput.value = filter;
    const head = el('div', { class: 'ov-head' }, title);
    const dom = el('div', { class: 'ov-box' }, head);
    if (filterable) dom.append(el('div', { class: 'ov-filter' }, el('span', {}, '/ '), filterInput));
    dom.append(body);
    if (hint) dom.append(el('div', { class: 'ov-foot' }, hint));
    this.place(dom, this.paneBox(zoom));
    this.root.appendChild(dom);
    entry.dom = dom;

    let shown = [];
    let sel = initial;
    const render = () => {
      const q = filterInput.value;
      shown = [];
      for (const r of rows()) {
        const text = typeof r === 'string' ? r : r.text;
        const m = fuzzy(q, text);
        if (m.score < 0) continue;
        shown.push({ r, text, m });
      }
      if (q && filterable) shown.sort((a, b) => b.m.score - a.m.score);
      sel = Math.max(0, Math.min(sel, shown.length - 1));
      body.textContent = '';
      shown.forEach((s, i) => {
        const row = el('div', { class: 'row' + (select && i === sel ? ' sel' : '') }, ...highlight(s.text, q ? s.m.idx : []));
        if (s.r.dim) row.append(el('span', { class: 'dim' }, s.r.dim));
        row.addEventListener('mousedown', (e) => { e.preventDefault(); sel = i; render(); if (select) choose(); });
        body.appendChild(row);
      });
      const cur = body.children[sel];
      if (select && cur) cur.scrollIntoView({ block: 'nearest' });
    };
    const choose = (key) => {
      const s = shown[sel];
      if (!s) return;
      onSelect?.(s.r, key, entry);
    };
    entry.render = render;
    entry.refocus = () => (filterable && filterInput.value ? filterInput.focus() : this.app.keySink());
    entry.selected = () => shown[sel]?.r;
    entry.onKey = (e) => {
      const key = eventToKey(e);
      if (!key) return true;
      const inFilter = filterable && document.activeElement === filterInput;
      if (onKey && onKey(key, entry, e) === true) { e.preventDefault(); return true; }
      const page = Math.max(1, Math.floor(body.clientHeight / parseFloat(getComputedStyle(body).lineHeight || '20')) - 1);
      const move = (d) => { e.preventDefault(); if (select) { sel = Math.max(0, Math.min(shown.length - 1, sel + d)); render(); } else body.scrollTop += d * 20; };
      switch (key) {
        case 'Escape': case 'C-c': case 'C-g': e.preventDefault(); this.close(entry); return true;
        case 'q': if (!inFilter) { e.preventDefault(); this.close(entry); return true; } break;
        case 'Down': case 'C-n': case 'C-j': move(1); return true;
        case 'Up': case 'C-p': case 'C-k': move(-1); return true;
        case 'j': if (!inFilter) { move(1); return true; } break;
        case 'k': if (!inFilter) { move(-1); return true; } break;
        case 'NPage': case 'C-f': case 'C-d': move(page); return true;
        case 'PPage': case 'C-b': case 'C-u': if (!inFilter || key !== 'C-u') { move(-page); return true; } break;
        case 'g': case 'Home': if (!inFilter) { e.preventDefault(); sel = 0; body.scrollTop = 0; render(); return true; } break;
        case 'G': case 'End': if (!inFilter) { e.preventDefault(); sel = shown.length - 1; body.scrollTop = body.scrollHeight; render(); return true; } break;
        case '/': if (filterable && !inFilter) { e.preventDefault(); filterInput.focus(); return true; } break;
        case 'Enter': e.preventDefault(); if (select) choose(key); else if (inFilter) this.app.keySink(); return true;
      }
      if (inFilter) { e.stopPropagation(); setTimeout(render, 0); return true; }
      if (filterable && key.length === 1 && !select) { filterInput.focus(); return false; }
      e.preventDefault();
      return true;
    };
    filterInput.addEventListener('input', () => { sel = 0; render(); });
    this.push(entry);
    render();
    if (filterable && filter) filterInput.focus();
    return entry;
  }

  showList({ title, lines, filterable = false }) {
    this.list({ title: `${title}  (${lines.length})`, rows: () => lines, filterable: filterable || lines.length > 20, hint: 'q: close · /: filter · j/k: scroll' });
  }

  pick({ title, items, fuzzy: fz = true, hint = '' }) {
    return new Promise((resolve) => {
      let done = false;
      const entry = this.list({
        title, rows: () => items.map((i) => ({ ...i, text: i.label })), filterable: true, select: true,
        hint: hint || 'Enter: select · Esc: cancel',
        onSelect: (r, key) => { done = true; this.close(entry); resolve(key && key !== 'Enter' ? { value: r.value, key } : r.value); },
        onKey: (key) => {
          if (['C-v', 'C-s', 'C-t'].includes(key) && hint) {
            const r = entry.selected();
            if (r) { done = true; this.close(entry); resolve({ value: r.value, key }); }
            return true;
          }
          return false;
        },
      });
      entry.cleanup = () => { if (!done) resolve(null); };
      if (fz) entry.dom.querySelector('.ov-filter input')?.focus();
    });
  }

  // --------------------------------------------------- display-menu / popup

  /** display-menu: resolves to the chosen item or null. Shortcut keys select directly. */
  menu({ title = '', items, start = 0 }) {
    return new Promise((resolve) => {
      const entry = { kind: 'menu' };
      const box = el('div', { class: 'ov-box ov-menu' });
      if (title) box.append(el('div', { class: 'ov-head' }, title));
      const body = el('div', { class: 'ov-body' });
      box.append(body);
      const selectable = items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0);
      let sel = selectable[Math.max(0, Math.min(start, selectable.length - 1))] ?? -1;
      let done = false;
      const finish = (v) => { done = true; this.close(entry); resolve(v); };
      const render = () => {
        body.textContent = '';
        items.forEach((it, i) => {
          if (it.separator) { body.append(el('div', { class: 'sep' })); return; }
          const row = el('div', { class: 'row' + (i === sel ? ' sel' : '') + (it.disabled ? ' disabled' : '') },
            el('span', { class: 'label' }, it.label), it.key ? el('span', { class: 'key' }, `(${it.key})`) : null);
          if (!it.disabled) {
            row.addEventListener('mousedown', (e) => { e.preventDefault(); finish(it); });
            row.addEventListener('mouseenter', () => { if (sel !== i) { sel = i; render(); } });
          }
          body.append(row);
        });
      };
      const move = (d) => {
        if (!selectable.length) return;
        const k = selectable.indexOf(sel);
        sel = selectable[(k + d + selectable.length) % selectable.length];
        render();
      };
      entry.onKey = (e) => {
        const key = eventToKey(e);
        if (!key) return true;
        e.preventDefault();
        const hit = items.find((it) => !it.separator && !it.disabled && it.key === key);
        if (hit) { finish(hit); return true; }
        switch (key) {
          case 'Escape': case 'C-c': case 'C-g': case 'q': finish(null); break;
          case 'Up': case 'k': case 'C-p': case 'BTab': move(-1); break;
          case 'Down': case 'j': case 'C-n': case 'Tab': move(1); break;
          case 'Enter': if (sel >= 0) finish(items[sel]); break;
        }
        return true;
      };
      entry.cleanup = () => { if (!done) resolve(null); };
      const area = this.paneBox(false);
      Object.assign(box.style, { left: `${area.x + area.w / 2}px`, top: `${area.y + area.h / 2}px` });
      this.root.appendChild(box);
      entry.dom = box;
      this.push(entry);
      render();
    });
  }

  /** display-popup: a floating frame (url) or text box. */
  popup({ url = null, text = null, width, height, x, y, title = '' } = {}) {
    this.closePopup();
    const area = this.paneBox(true);
    const cell = this.app.cell || { w: 8, h: 17 };
    const dim = (v, total, c) => {
      if (v == null || v === '') return total / 2;
      const s = String(v);
      const n = s.endsWith('%') ? (total * Number(s.slice(0, -1))) / 100 : Number(s) * c;
      return Number.isFinite(n) && n > 0 ? Math.min(total, n) : total / 2;
    };
    const w = dim(width, area.w, cell.w);
    const h = dim(height, area.h, cell.h);
    const pos = (v, total, size, c) => {
      const n = Number(v);
      if (v != null && v !== 'C' && Number.isFinite(n)) return Math.max(0, Math.min(total - size, n * c));
      return (total - size) / 2;
    };
    const entry = { kind: 'popup' };
    const close = el('span', { class: 'ov-close', title: 'Close (Esc)' }, '×');
    const head = el('div', { class: 'ov-head' }, title || url || 'popup', close);
    const box = el('div', { class: 'ov-box ov-popup' }, head);
    if (url != null && url !== '') {
      box.append(el('iframe', { class: 'ov-frame', src: url, allow: 'clipboard-read; clipboard-write; fullscreen' }));
    } else if (text != null) {
      box.append(el('div', { class: 'ov-body' }, text));
    } else {
      const input = el('input', { type: 'text', spellcheck: 'false', placeholder: 'URL or search, Enter to open' });
      const holder = el('div', { class: 'ov-filter' }, el('span', {}, 'url: '), input);
      box.append(holder);
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !input.value.trim()) return;
        e.preventDefault();
        e.stopPropagation();
        holder.replaceWith(el('iframe', { class: 'ov-frame', src: toPopupUrl(input.value, this.t) }));
        this.app.keySink();
      });
      entry.refocus = () => input.focus();
      setTimeout(() => input.focus(), 0);
    }
    this.place(box, { x: area.x + pos(x, area.w, w, cell.w), y: area.y + pos(y, area.h, h, cell.h), w, h });
    this.root.appendChild(box);
    entry.dom = box;
    entry.onKey = (e) => {
      const key = eventToKey(e);
      if (key === 'Escape' || key === 'C-c') { e.preventDefault(); this.close(entry); return true; }
      return document.activeElement?.tagName === 'INPUT' ? false : true;
    };
    close.addEventListener('mousedown', (e) => { e.preventDefault(); this.close(entry); });
    this.popupEntry = entry;
    entry.cleanup = () => { if (this.popupEntry === entry) this.popupEntry = null; };
    this.push(entry);
    if (entry.refocus) entry.refocus();
  }

  closePopup() {
    if (this.popupEntry) this.close(this.popupEntry);
  }

  // ------------------------------------------------------------ choose-tree

  chooseTree({ mode = 'tree', filter = '', zoom = true, template = null } = {}) {
    const t = this.t;
    const srv = t.server;
    const collapsed = new Set();
    if (mode === 'session') srv.sessions.forEach((s) => collapsed.add(`s${s.id}`));
    // Like tmux: the first rows get 0-9, then M-a..M-z as shortcut keys.
    const shortcut = (i) => (i < 10 ? String(i) : i < 36 ? `M-${String.fromCharCode(87 + i)}` : null);
    const rows = () => {
      const out = [];
      for (const s of srv.sessions.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
        const cur = s.id === srv.currentId;
        const sk = `s${s.id}`;
        const folded = collapsed.has(sk);
        const summary = srv.sortedWindows(s).map((w) => `${w.index}:${srv.windowName(w)}${w.id === s.active ? '*' : ''}`).join(' ');
        out.push({
          text: `${folded ? '+' : '-'} ${s.name}: ${s.windows.length} window${s.windows.length === 1 ? '' : 's'}${cur ? ' (attached)' : ''}`,
          dim: folded ? `  ${summary}` : '',
          kind: 'session', session: s, key: sk,
        });
        if (folded) continue;
        for (const w of srv.sortedWindows(s)) {
          const ids = L.panesInOrder(w.layout);
          const wk = `w${w.id}`;
          const flags = t.expandPlain('#{window_flags}', { session: s, window: w });
          const p = srv.panes[w.active];
          out.push({
            text: `  ${mode === 'window' || ids.length < 2 ? ' ' : collapsed.has(wk) ? '+' : '-'} ${w.index}: ${srv.windowName(w)}${flags} (${ids.length} panes) "${p?.title || p?.url || ''}"`,
            kind: 'window', session: s, window: w, key: wk,
          });
          if (mode !== 'tree' || ids.length < 2 || collapsed.has(wk)) continue;
          for (const id of ids) {
            const pp = srv.panes[id];
            out.push({
              text: `      ${srv.paneIndex(w, id)}: ${pp.title || pp.url || 'new'}${id === w.active ? ' *' : ''}`,
              dim: pp.url ? `  ${pp.url}` : '',
              kind: 'pane', session: s, window: w, pane: id, key: `p${id}`,
            });
          }
        }
      }
      out.forEach((r, i) => {
        r.shortcut = shortcut(i);
        r.text = `${r.shortcut ? `(${r.shortcut})` : ''}`.padEnd(6) + r.text;
      });
      return out;
    };
    const cur = rows().findIndex((r) => (mode === 'session' ? r.kind === 'session' && r.session.id === srv.currentId : r.kind === 'window' && r.window.id === srv.window?.id));
    const go = async (r) => {
      this.close(entry);
      const targetSpec = r.kind === 'pane' ? `%${r.pane}` : r.kind === 'window' ? `@${r.window.id}` : `$${r.session.id}`;
      if (template) {
        await t.runString(template.replace(/%%/g, targetSpec));
      } else {
        srv.switchTo(r.session);
        if (r.window) srv.selectWindow(r.session, r.window);
        if (r.pane != null) srv.selectPane(r.window, r.pane);
        srv.changed('choose');
      }
      this.app.focusPane();
    };
    // Ask for a name in the status line, then run a command built from it.
    const ask = async (label, initial, build, { closeAfter = false } = {}) => {
      const answer = await this.prompt({ prompts: [label], inputs: [initial] });
      if (answer == null) return;
      try {
        await t.runString(build(answer[0].trim()));
      } catch (err) {
        this.message(String(err.message || err));
      }
      if (closeAfter && this.stack.includes(entry)) { this.close(entry); this.app.focusPane(); }
      else entry.render();
    };
    const entry = this.list({
      title: `choose-tree (${mode})`, rows, select: true, filterable: true, zoom, initial: Math.max(0, cur), filter,
      hint: 'Enter switch · n new session · c new window · $ rename session · , rename window · x kill · h/l fold · / filter · q quit',
      onSelect: (r) => go(r),
      onKey: (key) => {
        if (document.activeElement?.tagName === 'INPUT') return false;
        if (key === 'n') {
          ask('(new-session) name: ', '', (name) => `new-session${name ? ` -s ${quoteArg(name)}` : ''}`, { closeAfter: true });
          return true;
        }
        const r = entry.selected();
        if (!r) return false;
        const sid = `'$${r.session.id}'`;
        if (key === 'c') {
          (async () => {
            this.close(entry);
            await t.runString(`new-window -t ${sid}:`);
            this.app.focusPane();
          })();
          return true;
        }
        if (key === '$') {
          ask(`(rename-session) ${r.session.name}: `, r.session.name, (name) => `rename-session -t ${sid} -- ${quoteArg(name)}`);
          return true;
        }
        if (key === ',' && r.window) {
          ask(`(rename-window) ${srv.windowName(r.window)}: `, srv.windowName(r.window), (name) => `rename-window -t @${r.window.id} -- ${quoteArg(name)}`);
          return true;
        }
        if (key === 'x' || key === 'X') {
          const what = r.kind === 'session' ? `kill-session -t ${sid}` : r.kind === 'window' ? `kill-window -t @${r.window.id}` : `kill-pane -t %${r.pane}`;
          this.confirm(`${what.split(' ')[0]} ${r.kind === 'session' ? r.session.name : r.kind === 'window' ? r.window.index : r.pane}? (y/n)`).then(async (ok) => {
            if (ok) await t.runString(what);
            if (!srv.sessions.length) this.close(entry); else entry.render();
          });
          return true;
        }
        if (key === 'Left' || key === 'h' || key === '-') { collapsed.add(r.key); entry.render(); return true; }
        if (key === 'Right' || key === 'l' || key === '+') { collapsed.delete(r.key); entry.render(); return true; }
        const hit = rows().find((row) => row.shortcut === key);
        if (hit) { go(hit); return true; }
        return false;
      },
    });
  }

  // --------------------------------------------------------- display-panes

  displayPanes({ time }) {
    return new Promise((resolve) => {
      const t = this.t;
      const w = t.server.window;
      if (!w) return resolve(null);
      const entry = { kind: 'display-panes' };
      const dom = el('div');
      const ids = L.panesInOrder(w.layout);
      const colour = colourToCss(t.getOption('display-panes-colour')) || 'blue';
      const activeColour = colourToCss(t.getOption('display-panes-active-colour')) || 'red';
      for (const id of ids) {
        const r = this.app.view.rects[id];
        if (!r) continue;
        const n = el('div', { class: 'pane-number', style: { color: id === w.active ? activeColour : colour } },
          el('span', {}, String(t.server.paneIndex(w, id)), el('small', {}, `${Math.round(r.w / this.app.cell.w)}x${Math.round(r.h / this.app.cell.h)}`)));
        this.place(n, r);
        dom.appendChild(n);
      }
      this.root.appendChild(dom);
      entry.dom = dom;
      let digits = '';
      const finish = (v) => { clearTimeout(timer); this.close(entry); resolve(v); };
      const timer = time > 0 ? setTimeout(() => finish(null), time) : null;
      entry.onKey = (e) => {
        const key = eventToKey(e);
        if (!key) return true;
        e.preventDefault();
        if (/^\d$/.test(key)) {
          digits += key;
          const base = Number(t.getOption('pane-base-index') || 0);
          const maxIndex = ids.length - 1 + base;
          // Wait for a second digit only if one could still name a pane.
          if (digits.length >= String(maxIndex).length || Number(digits) * 10 > maxIndex) {
            finish(ids[Number(digits) - base] ?? null);
          }
          return true;
        }
        finish(null);
        return true;
      };
      this.push(entry);
    });
  }

  // ------------------------------------------------------------ clock-mode

  clock(paneId) {
    const t = this.t;
    const r = this.app.view.rects[paneId] || this.app.view.areaRect;
    const colour = colourToCss(t.getOption('clock-mode-colour')) || 'blue';
    const style24 = t.getOption('clock-mode-style') !== '12';
    const dom = el('div', { class: 'clock', style: { color: colour } });
    this.place(dom, r);
    const DIG = {
      0: ['11111', '1...1', '1...1', '1...1', '11111'], 1: ['....1', '....1', '....1', '....1', '....1'],
      2: ['11111', '....1', '11111', '1....', '11111'], 3: ['11111', '....1', '11111', '....1', '11111'],
      4: ['1...1', '1...1', '11111', '....1', '....1'], 5: ['11111', '1....', '11111', '....1', '11111'],
      6: ['11111', '1....', '11111', '1...1', '11111'], 7: ['11111', '....1', '....1', '....1', '....1'],
      8: ['11111', '1...1', '11111', '1...1', '11111'], 9: ['11111', '1...1', '11111', '....1', '11111'],
      ':': ['.....', '..1..', '.....', '..1..', '.....'],
    };
    const draw = () => {
      const d = new Date();
      let h = d.getHours();
      const ampm = h < 12 ? 'AM' : 'PM';
      if (!style24) h = h % 12 || 12;
      const text = `${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const row = el('div', { class: 'digits' });
      for (const ch of text) {
        const g = el('div', { class: 'digit' });
        for (const line of DIG[ch]) for (const c of line) g.append(el('b', { style: { background: c === '1' ? colour : 'transparent' } }));
        row.append(g);
      }
      if (!style24) row.append(el('div', { class: 'ampm' }, ampm));
      dom.textContent = '';
      dom.append(row);
    };
    draw();
    const timer = setInterval(draw, 1000);
    this.root.appendChild(dom);
    const entry = { kind: 'clock', dom, cleanup: () => clearInterval(timer) };
    entry.onKey = (e) => { if (eventToKey(e)) { e.preventDefault(); this.close(entry); } return true; };
    dom.addEventListener('mousedown', () => this.close(entry));
    this.push(entry);
  }

  // -------------------------------------------------------------- detached

  detached(sessionName, onReattach) {
    const dom = el('div', { class: 'detached' },
      `[detached (from session ${sessionName})]\n\npress any key or click to attach`);
    this.root.appendChild(dom);
    const entry = { kind: 'detached', dom };
    const go = () => { this.close(entry); onReattach(); };
    entry.onKey = (e) => { if (eventToKey(e)) { e.preventDefault(); go(); } return true; };
    dom.addEventListener('mousedown', go);
    this.push(entry);
  }

  // ----------------------------------------------------------- debug panel

  debugPanel(tab = 'config') {
    const existing = this.stack.find((e) => e.kind === 'debug');
    if (existing) { existing.show(tab); return; }
    const t = this.t;
    const body = el('div', { class: 'ov-body' });
    const tabs = el('div', { class: 'tabs' });
    const dom = el('div', { class: 'ov-box debug' }, el('div', { class: 'ov-head' }, 'chrome-tmux debug  (q to close)'), tabs, body);
    this.place(dom, this.paneBox(true));
    this.root.appendChild(dom);
    const entry = { kind: 'debug', dom };
    const names = { config: 'Config', plugins: 'Plugins', options: 'Options', messages: 'Messages' };
    let current = tab;

    const tableOf = (head, rows) => el('table', {},
      el('tr', {}, head.map((h) => el('th', {}, h))),
      rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, c)))));

    const views = {
      config: () => {
        const info = this.app.configInfo();
        const notices = t.notices.filter((n) => n.source !== '(defaults)');
        return [
          el('h3', {}, 'Configuration source'),
          el('div', {}, info.label),
          info.error ? el('div', { class: 'lvl-error' }, info.error) : null,
          el('div', {}, `${info.lines} lines · prefix ${t.getOption('prefix')} · mouse ${t.getOption('mouse')} · mode-keys ${t.getOption('mode-keys')}`),
          el('h3', {}, `Notices (${notices.length})`),
          notices.length
            ? tableOf(['level', 'where', 'message'], notices.map((n) => [
              el('span', { class: `lvl-${n.level}` }, n.level),
              n.source ? `${n.source}${n.line ? ':' + n.line : ''}` : '',
              n.message,
            ]))
            : el('div', {}, 'No problems found.'),
        ];
      },
      plugins: () => {
        const rows = t.plugins?.report() || [];
        const unclaimed = t.plugins?.unclaimedOptions() || [];
        return [
          el('h3', {}, `TPM plugins (${rows.length})`),
          el('div', {},
            el('button', { class: 'act', onclick: async () => { await t.plugins.fetchMetadata({ force: true }); render(); } }, 'Fetch GitHub metadata'),
            '  install: prefix I · update: prefix U'),
          rows.length ? tableOf(['plugin', 'status', 'GitHub', 'options'], rows.map((r) => [
            el('div', {}, el('code', {}, r.repo), r.branch ? ` #${r.branch}` : '', el('div', { class: 'lvl-info' }, r.description || ''),
              r.source ? el('div', { class: 'lvl-info' }, `${r.source}:${r.line}`) : null),
            el('span', { class: `badge ${r.status === 'emulated' ? 'emulated' : r.status === 'unknown' ? 'unknown' : ''}` }, r.status),
            r.meta ? (r.meta.error ? el('span', { class: 'lvl-warn' }, r.meta.error)
              : el('div', {}, el('a', { href: r.meta.url, target: '_blank', rel: 'noreferrer' }, r.meta.fullName), ` ★${r.meta.stars}`,
                r.meta.archived ? ' (archived)' : '', el('div', { class: 'lvl-info' }, r.meta.description || ''))) : el('span', { class: 'lvl-info' }, 'not fetched'),
            el('code', {}, r.options.map((o) => `${o} ${t.options[o]}`).join('\n')),
          ])) : el('div', {}, 'No @plugin lines in the configuration.'),
          el('h3', {}, `Options not used by any emulated plugin (${unclaimed.length})`),
          unclaimed.length ? el('code', {}, unclaimed.map((o) => `set -g ${o} '${t.options[o]}'`).join('\n')) : el('div', {}, 'None.'),
        ];
      },
      options: () => [el('code', {}, Object.keys(t.options).sort().map((k) => `${k} ${JSON.stringify(t.options[k])}${t.optionOrigins[k] && t.optionOrigins[k] !== 'user' ? `   (${t.optionOrigins[k]})` : t.optionOrigins[k] ? '' : '   (default)'}`).join('\n'))],
      messages: () => [el('code', {}, t.messages.slice().reverse().map((m) =>
        `${new Date(m.time).toLocaleTimeString()} ${m.level === 'info' ? '' : m.level.toUpperCase() + ' '}${m.message}`).join('\n') || 'No messages.')],
    };
    const render = () => {
      tabs.textContent = '';
      for (const [k, label] of Object.entries(names)) {
        tabs.append(el('button', { class: k === current ? 'on' : '', onclick: () => { current = k; render(); } }, label));
      }
      body.textContent = '';
      body.append(...views[current]().filter(Boolean));
    };
    entry.show = (k) => { current = names[k] ? k : current; render(); };
    entry.onKey = (e) => {
      const key = eventToKey(e);
      if (!key) return true;
      const order = Object.keys(names);
      if (key === 'q' || key === 'Escape') { e.preventDefault(); this.close(entry); }
      else if (key === 'Tab' || key === 'l' || key === 'Right') { e.preventDefault(); current = order[(order.indexOf(current) + 1) % order.length]; render(); }
      else if (key === 'BTab' || key === 'h' || key === 'Left') { e.preventDefault(); current = order[(order.indexOf(current) + order.length - 1) % order.length]; render(); }
      else if (key === 'j' || key === 'Down') { e.preventDefault(); body.scrollTop += 20; }
      else if (key === 'k' || key === 'Up') { e.preventDefault(); body.scrollTop -= 20; }
      else if (key === 'C-d' || key === 'NPage') { e.preventDefault(); body.scrollTop += body.clientHeight / 2; }
      else if (key === 'C-u' || key === 'PPage') { e.preventDefault(); body.scrollTop -= body.clientHeight / 2; }
      return true;
    };
    render();
    this.push(entry);
  }
}
