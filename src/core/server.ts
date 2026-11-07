// @ts-nocheck
// The "tmux server": sessions, windows and panes plus the operations that
// mutate them. Pure state; rendering lives in src/workspace.

import * as L from './layout.js';

export class Server extends EventTarget {
  constructor(getOption) {
    super();
    this.getOption = getOption;
    this.sessions = [];
    this.currentId = null;
    this.lastSessionId = null;
    this.panes = {};
    this.seq = { session: 0, window: 0, pane: 0 };
    this.created = Date.now();
    this.marked = null; // the marked pane (select-pane -m), server-wide like tmux
  }

  /** The marked pane id, or null if none (or it no longer exists). */
  markedPane() {
    if (this.marked == null) return null;
    if (!this.panes[this.marked] || !this.locate(this.marked)) { this.marked = null; return null; }
    return this.marked;
  }

  // ------------------------------------------------------------ persistence

  toJSON() {
    const panes = {};
    for (const [id, p] of Object.entries(this.panes)) {
      panes[id] = { id: p.id, kind: p.kind, url: p.url, title: p.title, prefill: p.prefill };
    }
    return {
      version: 1,
      sessions: this.sessions,
      currentId: this.currentId,
      lastSessionId: this.lastSessionId,
      panes,
      seq: this.seq,
      created: this.created,
    };
  }

  load(json) {
    if (!json || json.version !== 1 || !Array.isArray(json.sessions) || !json.sessions.length) return false;
    this.sessions = json.sessions;
    this.currentId = json.currentId ?? json.sessions[0].id;
    this.lastSessionId = json.lastSessionId ?? null;
    this.panes = {};
    for (const [id, p] of Object.entries(json.panes || {})) this.panes[id] = { ...p, id: Number(id) };
    this.seq = json.seq || this.seq;
    this.created = json.created || Date.now();
    // Drop panes that are referenced nowhere / windows whose panes vanished.
    for (const s of this.sessions) {
      s.windows = s.windows.filter((w) => {
        const ids = L.panesInOrder(w.layout);
        ids.forEach((id) => { if (!this.panes[id]) this.panes[id] = { id, kind: 'launcher', url: '', title: '' }; });
        return ids.length > 0;
      });
    }
    this.sessions = this.sessions.filter((s) => s.windows.length);
    if (!this.sessions.length) return false;
    if (!this.sessions.find((s) => s.id === this.currentId)) this.currentId = this.sessions[0].id;
    return true;
  }

  /** Layout/URL snapshot used by tmux-resurrect emulation. */
  snapshot() {
    return {
      version: 1,
      savedAt: Date.now(),
      current: this.session?.name ?? null,
      sessions: this.sessions.map((s) => ({
        name: s.name,
        active: this.activeWindow(s)?.index ?? null,
        windows: this.sortedWindows(s).map((w) => ({
          index: w.index,
          name: w.name,
          manualName: !!w.manualName,
          zoomed: !!w.zoomed,
          layoutName: w.layoutName || null,
          layout: w.layout,
          active: w.active,
          panes: Object.fromEntries(L.panesInOrder(w.layout).map((id) => {
            const p = this.panes[id];
            return [id, { kind: p.kind, url: p.url, title: p.title, prefill: p.prefill || '' }];
          })),
        })),
      })),
    };
  }

  /** True when the server holds only the untouched initial session. */
  isPristine() {
    if (this.sessions.length !== 1) return false;
    const [s] = this.sessions;
    if (s.windows.length !== 1) return false;
    const ids = L.panesInOrder(s.windows[0].layout);
    return ids.length === 1 && this.panes[ids[0]]?.kind === 'launcher';
  }

  /**
   * Restore a snapshot. Sessions whose names already exist are skipped (like
   * tmux-resurrect) unless the server is pristine, in which case it is replaced.
   * Returns the number of sessions restored.
   */
  restore(snap) {
    if (!snap || !Array.isArray(snap.sessions)) return 0;
    const replace = this.isPristine();
    if (replace) {
      this.sessions = [];
      this.panes = {};
      this.currentId = null;
      this.lastSessionId = null;
    }
    let restored = 0;
    for (const ss of snap.sessions) {
      if (this.sessionByName(ss.name)) continue;
      const session = { id: ++this.seq.session, name: ss.name, windows: [], active: null, last: null, created: Date.now() };
      for (const sw of ss.windows) {
        const map = {};
        for (const [oldId, sp] of Object.entries(sw.panes || {})) {
          const id = ++this.seq.pane;
          map[oldId] = id;
          this.panes[id] = { id, kind: sp.kind === 'web' && sp.url ? 'web' : 'launcher', url: sp.url || '', title: sp.title || '', prefill: sp.prefill || '' };
        }
        const remap = (n) => (n.type === 'pane'
          ? { type: 'pane', id: map[n.id] }
          : { ...n, children: n.children.map(remap) });
        const layout = remap(sw.layout);
        if (L.panesInOrder(layout).some((id) => id == null)) continue;
        const w = {
          id: ++this.seq.window, index: sw.index, name: sw.name, manualName: !!sw.manualName,
          layout, active: map[sw.active] ?? L.panesInOrder(layout)[0], last: null,
          zoomed: !!sw.zoomed, layoutName: sw.layoutName || null,
        };
        session.windows.push(w);
        if (sw.index === ss.active) session.active = w.id;
      }
      if (!session.windows.length) continue;
      if (session.active == null) session.active = session.windows[0].id;
      this.sessions.push(session);
      restored++;
    }
    if (!this.sessions.length) return 0;
    const cur = (snap.current != null && this.sessionByName(snap.current)) || this.sessions[0];
    if (replace || !this.currentId) this.currentId = cur.id;
    return restored;
  }

  changed(reason = 'change') {
    this.dispatchEvent(new CustomEvent('change', { detail: reason }));
  }

  // ---------------------------------------------------------------- lookups

  get session() { return this.sessions.find((s) => s.id === this.currentId) || null; }
  get window() { const s = this.session; return s ? this.activeWindow(s) : null; }
  get pane() { const w = this.window; return w ? this.panes[w.active] : null; }

  activeWindow(session) {
    return session.windows.find((w) => w.id === session.active) || session.windows[0] || null;
  }

  sessionById(id) { return this.sessions.find((s) => s.id === id) || null; }
  sessionByName(name) { return this.sessions.find((s) => s.name === name) || null; }

  locate(paneId) {
    for (const s of this.sessions) {
      for (const w of s.windows) {
        if (L.findPath(w.layout, paneId)) return { session: s, window: w };
      }
    }
    return null;
  }

  windowById(id) {
    for (const s of this.sessions) {
      const w = s.windows.find((x) => x.id === id);
      if (w) return { session: s, window: w };
    }
    return null;
  }

  paneIndex(window, paneId) {
    return L.panesInOrder(window.layout).indexOf(paneId) + Number(this.getOption('pane-base-index') || 0);
  }

  panesOf(window) { return L.panesInOrder(window.layout); }

  windowName(window) {
    if (window.manualName || this.getOption('automatic-rename') !== 'on') return window.name;
    const p = this.panes[window.active];
    return p ? paneShortName(p) : window.name;
  }

  sortedWindows(session) { return session.windows.slice().sort((a, b) => a.index - b.index); }

  // -------------------------------------------------------------- creation

  makePane({ url = '', prefill = '' } = {}) {
    const id = ++this.seq.pane;
    const pane = url
      ? { id, kind: 'web', url, title: '', prefill: '' }
      : { id, kind: 'launcher', url: '', title: '', prefill };
    this.panes[id] = pane;
    return pane;
  }

  freeIndex(session, from) {
    const used = new Set(session.windows.map((w) => w.index));
    let i = from ?? Number(this.getOption('base-index') || 0);
    while (used.has(i)) i++;
    return i;
  }

  newSession({ name, url, prefill, windowName } = {}) {
    const id = ++this.seq.session;
    if (!name) {
      let n = 0;
      while (this.sessionByName(String(n))) n++;
      name = String(n);
    }
    const session = { id, name, windows: [], active: null, last: null, created: Date.now() };
    this.sessions.push(session);
    this.newWindow(session, { url, prefill, name: windowName });
    this.switchTo(session);
    return session;
  }

  newWindow(session, { url, prefill, name, index, after = false, select = true, pane } = {}) {
    const p = pane || this.makePane({ url, prefill });
    let idx;
    if (index != null) {
      idx = index;
      if (session.windows.some((w) => w.index === idx)) this.shiftFrom(session, idx);
    } else if (after) {
      const cur = this.activeWindow(session);
      idx = cur ? cur.index + 1 : this.freeIndex(session);
      if (session.windows.some((w) => w.index === idx)) this.shiftFrom(session, idx);
    } else {
      idx = this.freeIndex(session);
    }
    const window = {
      id: ++this.seq.window,
      index: idx,
      name: name || paneShortName(p),
      manualName: !!name,
      layout: L.leaf(p.id),
      active: p.id,
      last: null,
      zoomed: false,
      layoutName: null,
    };
    session.windows.push(window);
    if (select || !session.active) this.selectWindow(session, window);
    return window;
  }

  shiftFrom(session, idx) {
    for (const w of session.windows) if (w.index >= idx) w.index++;
  }

  splitPane(window, targetId, dir, opts = {}) {
    const p = this.makePane(opts);
    window.zoomed = false;
    window.layout = L.splitPane(window.layout, targetId, p.id, dir, opts);
    if (opts.select !== false) this.selectPane(window, p.id);
    return p;
  }

  // -------------------------------------------------------------- selection

  switchTo(session) {
    if (!session || session.id === this.currentId) return;
    this.lastSessionId = this.currentId;
    this.currentId = session.id;
  }

  selectWindow(session, window) {
    if (!window || session.active === window.id) return;
    session.last = session.active;
    session.active = window.id;
  }

  selectPane(window, paneId) {
    if (!this.panes[paneId] || window.active === paneId) return;
    if (window.zoomed) window.zoomed = false;
    window.last = window.active;
    window.active = paneId;
  }

  // ---------------------------------------------------------------- removal

  killPane(paneId) {
    const loc = this.locate(paneId);
    if (!loc) return;
    const { session, window } = loc;
    window.layout = L.removePane(window.layout, paneId);
    delete this.panes[paneId];
    if (!window.layout) { this.killWindow(session, window); return; }
    window.zoomed = false;
    const ids = L.panesInOrder(window.layout);
    if (window.last === paneId || !ids.includes(window.last)) window.last = null;
    if (window.active === paneId) window.active = window.last && ids.includes(window.last) ? window.last : ids[0];
  }

  killWindow(session, window) {
    for (const id of L.panesInOrder(window.layout)) delete this.panes[id];
    const sorted = this.sortedWindows(session);
    const pos = sorted.indexOf(window);
    session.windows = session.windows.filter((w) => w !== window);
    if (!session.windows.length) { this.killSession(session); return; }
    if (session.active === window.id) {
      const last = session.windows.find((w) => w.id === session.last);
      const next = last || this.sortedWindows(session)[Math.min(pos, session.windows.length - 1)];
      session.active = next.id;
      session.last = null;
    }
    if (session.last === window.id) session.last = null;
    if (this.getOption('renumber-windows') === 'on') this.renumber(session);
  }

  killSession(session) {
    for (const w of session.windows) for (const id of L.panesInOrder(w.layout)) delete this.panes[id];
    this.sessions = this.sessions.filter((s) => s !== session);
    if (this.currentId === session.id) {
      const last = this.sessionById(this.lastSessionId);
      this.currentId = (last || this.sessions[0] || {}).id ?? null;
      this.lastSessionId = null;
    }
    if (this.lastSessionId === session.id) this.lastSessionId = null;
  }

  renumber(session) {
    const base = Number(this.getOption('base-index') || 0);
    this.sortedWindows(session).forEach((w, i) => { w.index = base + i; });
  }

  // ------------------------------------------------------------- reshaping

  breakPane(paneId, { name, select = true, index, after } = {}) {
    const loc = this.locate(paneId);
    if (!loc) return null;
    const { session, window } = loc;
    if (L.panesInOrder(window.layout).length < 2) return window;
    window.layout = L.removePane(window.layout, paneId);
    window.zoomed = false;
    if (window.active === paneId) {
      const ids = L.panesInOrder(window.layout);
      window.active = ids.includes(window.last) ? window.last : ids[0];
      window.last = null;
    }
    return this.newWindow(session, { pane: this.panes[paneId], name, select, index, after });
  }

  joinPane(paneId, targetWindow, targetPaneId, dir, opts = {}) {
    const loc = this.locate(paneId);
    if (!loc || loc.window === targetWindow) return;
    const { session, window } = loc;
    window.layout = L.removePane(window.layout, paneId);
    if (!window.layout) {
      session.windows = session.windows.filter((w) => w !== window);
      if (session.active === window.id) session.active = (session.windows[0] || {}).id;
      if (!session.windows.length) this.killSession(session);
    } else if (window.active === paneId) {
      window.active = L.panesInOrder(window.layout)[0];
    }
    targetWindow.layout = L.splitPane(targetWindow.layout, targetPaneId, paneId, dir, opts);
    targetWindow.zoomed = false;
    if (opts.select !== false) this.selectPane(targetWindow, paneId);
  }

  swapWindows(session, a, b) {
    [a.index, b.index] = [b.index, a.index];
  }

  moveWindow(session, window, index, targetSession = session) {
    if (targetSession !== session) {
      session.windows = session.windows.filter((w) => w !== window);
      if (session.active === window.id) session.active = (session.windows[0] || {}).id;
      if (!session.windows.length) this.killSession(session);
      targetSession.windows.push(window);
    }
    const clash = targetSession.windows.find((w) => w !== window && w.index === index);
    if (clash) this.shiftFrom(targetSession, index);
    window.index = index;
  }
}

/** Short name for a pane: hostname for web panes (like tmux's command name). */
export function paneShortName(p) {
  if (!p) return '';
  if (p.kind !== 'web' || !p.url) return 'new';
  try {
    const u = new URL(p.url);
    if (u.protocol === 'file:') return u.pathname.split('/').pop() || 'file';
    return u.hostname.replace(/^www\./, '') || u.protocol.replace(':', '');
  } catch {
    return p.url.slice(0, 20);
  }
}
