// The "tmux server": sessions, windows and panes plus the operations that
// mutate them. Pure state; rendering lives in src/workspace.

import * as L from './layout.js';
import type { LayoutNode, Pane, PaneKind, Session, SplitDir, Window } from './types.js';

export type GetOption = (name: string) => unknown;

export interface IdSequence {
  session: number;
  window: number;
  pane: number;
}

/** The persisted server state (toJSON / load). */
export interface ServerState {
  version: 1;
  sessions: Session[];
  currentId: number | null;
  lastSessionId: number | null;
  panes: Record<string, Pane>;
  seq: IdSequence;
  created: number;
}

export interface SnapshotPane {
  kind: PaneKind;
  url: string;
  title: string;
  prefill: string;
}

export interface SnapshotWindow {
  index: number;
  name: string;
  manualName: boolean;
  zoomed: boolean;
  layoutName: string | null;
  layout: LayoutNode;
  active: number;
  panes: Record<string, SnapshotPane>;
}

export interface SnapshotSession {
  name: string;
  /** Index of the active window. */
  active: number | null;
  windows: SnapshotWindow[];
}

/** Layout/URL snapshot used by tmux-resurrect emulation. */
export interface Snapshot {
  version: 1;
  savedAt: number;
  current: string | null;
  sessions: SnapshotSession[];
}

export interface PaneLocation {
  session: Session;
  window: Window;
}

export interface MakePaneOptions {
  url?: string;
  prefill?: string;
}

export interface NewSessionOptions {
  name?: string;
  url?: string;
  prefill?: string;
  windowName?: string;
}

export interface NewWindowOptions {
  url?: string;
  prefill?: string;
  name?: string;
  index?: number | null;
  after?: boolean;
  select?: boolean;
  pane?: Pane;
}

export interface ServerSplitOptions extends L.SplitOptions, MakePaneOptions {
  select?: boolean;
}

export interface JoinPaneOptions extends L.SplitOptions {
  select?: boolean;
}

export interface BreakPaneOptions {
  name?: string;
  select?: boolean;
  index?: number | null;
  after?: boolean;
}

export class Server extends EventTarget {
  declare getOption: GetOption;
  declare sessions: Session[];
  declare currentId: number | null;
  declare lastSessionId: number | null;
  declare panes: Record<number, Pane>;
  declare seq: IdSequence;
  declare created: number;
  declare marked: number | null;

  constructor(getOption: GetOption) {
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
  markedPane(): number | null {
    if (this.marked == null) return null;
    if (!this.panes[this.marked] || !this.locate(this.marked)) { this.marked = null; return null; }
    return this.marked;
  }

  // ------------------------------------------------------------ persistence

  toJSON(): ServerState {
    const panes: Record<string, Pane> = {};
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

  load(json: Partial<ServerState> | null | undefined): boolean {
    if (json?.version !== 1 || !Array.isArray(json.sessions) || !json.sessions.length) return false;
    this.sessions = json.sessions;
    this.currentId = json.currentId ?? json.sessions[0].id;
    this.lastSessionId = json.lastSessionId ?? null;
    this.panes = {};
    for (const [key, p] of Object.entries(json.panes || {})) {
      const id = Number(key);
      this.panes[id] = { ...p, id };
    }
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
  snapshot(): Snapshot {
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
  isPristine(): boolean {
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
  restore(snap: Snapshot | null | undefined): number {
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
      const session: Session = { id: ++this.seq.session, name: ss.name, windows: [], active: null, last: null, created: Date.now() };
      for (const sw of ss.windows) {
        const map: Record<string, number> = {};
        for (const [oldId, sp] of Object.entries(sw.panes || {})) {
          const id = ++this.seq.pane;
          map[oldId] = id;
          this.panes[id] = { id, kind: sp.kind === 'web' && sp.url ? 'web' : 'launcher', url: sp.url || '', title: sp.title || '', prefill: sp.prefill || '' };
        }
        const remap = (n: LayoutNode): LayoutNode => (n.type === 'pane'
          ? { type: 'pane', id: map[n.id] }
          : { ...n, children: n.children.map(remap) });
        const layout = remap(sw.layout);
        if (L.panesInOrder(layout).some((id) => id == null)) continue;
        const w: Window = {
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

  changed(reason = 'change'): void {
    this.dispatchEvent(new CustomEvent('change', { detail: reason }));
  }

  // ---------------------------------------------------------------- lookups

  get session(): Session | null { return this.sessions.find((s) => s.id === this.currentId) || null; }
  get window(): Window | null { const s = this.session; return s ? this.activeWindow(s) : null; }
  get pane(): Pane | null { const w = this.window; return w ? this.panes[w.active] : null; }

  activeWindow(session: Session): Window | null {
    return session.windows.find((w) => w.id === session.active) || session.windows[0] || null;
  }

  sessionById(id: number | null): Session | null { return this.sessions.find((s) => s.id === id) || null; }
  sessionByName(name: string): Session | null { return this.sessions.find((s) => s.name === name) || null; }

  locate(paneId: number): PaneLocation | null {
    for (const s of this.sessions) {
      for (const w of s.windows) {
        if (L.findPath(w.layout, paneId)) return { session: s, window: w };
      }
    }
    return null;
  }

  windowById(id: number): PaneLocation | null {
    for (const s of this.sessions) {
      const w = s.windows.find((x) => x.id === id);
      if (w) return { session: s, window: w };
    }
    return null;
  }

  paneIndex(window: Window, paneId: number): number {
    return L.panesInOrder(window.layout).indexOf(paneId) + Number(this.getOption('pane-base-index') || 0);
  }

  panesOf(window: Window): number[] { return L.panesInOrder(window.layout); }

  windowName(window: Window): string {
    if (window.manualName || this.getOption('automatic-rename') !== 'on') return window.name;
    const p = this.panes[window.active];
    return p ? paneShortName(p) : window.name;
  }

  sortedWindows(session: Session): Window[] { return session.windows.slice().sort((a, b) => a.index - b.index); }

  // -------------------------------------------------------------- creation

  makePane({ url = '', prefill = '' }: MakePaneOptions = {}): Pane {
    const id = ++this.seq.pane;
    const pane: Pane = url
      ? { id, kind: 'web', url, title: '', prefill: '' }
      : { id, kind: 'launcher', url: '', title: '', prefill };
    this.panes[id] = pane;
    return pane;
  }

  freeIndex(session: Session, from?: number | null): number {
    const used = new Set(session.windows.map((w) => w.index));
    let i = from ?? Number(this.getOption('base-index') || 0);
    while (used.has(i)) i++;
    return i;
  }

  newSession({ name, url, prefill, windowName }: NewSessionOptions = {}): Session {
    const id = ++this.seq.session;
    if (!name) {
      let n = 0;
      while (this.sessionByName(String(n))) n++;
      name = String(n);
    }
    const session: Session = { id, name, windows: [], active: null, last: null, created: Date.now() };
    this.sessions.push(session);
    this.newWindow(session, { url, prefill, name: windowName });
    this.switchTo(session);
    return session;
  }

  newWindow(session: Session, { url, prefill, name, index, after = false, select = true, pane }: NewWindowOptions = {}): Window {
    const p = pane || this.makePane({ url, prefill });
    let idx: number;
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
    const window: Window = {
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

  shiftFrom(session: Session, idx: number): void {
    for (const w of session.windows) if (w.index >= idx) w.index++;
  }

  splitPane(window: Window, targetId: number, dir: SplitDir, opts: ServerSplitOptions = {}): Pane {
    const p = this.makePane(opts);
    window.zoomed = false;
    window.layout = L.splitPane(window.layout, targetId, p.id, dir, opts);
    if (opts.select !== false) this.selectPane(window, p.id);
    return p;
  }

  // -------------------------------------------------------------- selection

  switchTo(session: Session | null | undefined): void {
    if (!session || session.id === this.currentId) return;
    this.lastSessionId = this.currentId;
    this.currentId = session.id;
  }

  selectWindow(session: Session, window: Window | null | undefined): void {
    if (!window || session.active === window.id) return;
    session.last = session.active;
    session.active = window.id;
  }

  selectPane(window: Window, paneId: number): void {
    if (!this.panes[paneId] || window.active === paneId) return;
    if (window.zoomed) window.zoomed = false;
    window.last = window.active;
    window.active = paneId;
  }

  // ---------------------------------------------------------------- removal

  killPane(paneId: number): void {
    const loc = this.locate(paneId);
    if (!loc) return;
    const { session, window } = loc;
    const layout = L.removePane(window.layout, paneId);
    delete this.panes[paneId];
    if (!layout) { this.killWindow(session, window); return; }
    window.layout = layout;
    window.zoomed = false;
    const ids = L.panesInOrder(layout);
    if (window.last == null || window.last === paneId || !ids.includes(window.last)) window.last = null;
    if (window.active === paneId) window.active = window.last && ids.includes(window.last) ? window.last : ids[0];
  }

  killWindow(session: Session, window: Window): void {
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

  killSession(session: Session): void {
    for (const w of session.windows) for (const id of L.panesInOrder(w.layout)) delete this.panes[id];
    this.sessions = this.sessions.filter((s) => s !== session);
    if (this.currentId === session.id) {
      const last = this.sessionById(this.lastSessionId);
      this.currentId = (last || this.sessions.at(0))?.id ?? null;
      this.lastSessionId = null;
    }
    if (this.lastSessionId === session.id) this.lastSessionId = null;
  }

  renumber(session: Session): void {
    const base = Number(this.getOption('base-index') || 0);
    this.sortedWindows(session).forEach((w, i) => { w.index = base + i; });
  }

  // ------------------------------------------------------------- reshaping

  breakPane(paneId: number, { name, select = true, index, after }: BreakPaneOptions = {}): Window | null {
    const loc = this.locate(paneId);
    if (!loc) return null;
    const { session, window } = loc;
    if (L.panesInOrder(window.layout).length < 2) return window;
    const layout = L.removePane(window.layout, paneId);
    if (!layout) return window; // unreachable: the window has at least two panes
    window.layout = layout;
    window.zoomed = false;
    if (window.active === paneId) {
      const ids = L.panesInOrder(layout);
      window.active = window.last != null && ids.includes(window.last) ? window.last : ids[0];
      window.last = null;
    }
    return this.newWindow(session, { pane: this.panes[paneId], name, select, index, after });
  }

  joinPane(paneId: number, targetWindow: Window, targetPaneId: number, dir: SplitDir, opts: JoinPaneOptions = {}): void {
    const loc = this.locate(paneId);
    if (!loc || loc.window === targetWindow) return;
    const { session, window } = loc;
    const layout = L.removePane(window.layout, paneId);
    if (!layout) {
      // The pane was the window's only one: the window goes away (the pane moves on).
      session.windows = session.windows.filter((w) => w !== window);
      if (session.active === window.id) session.active = session.windows.at(0)?.id ?? null;
      if (!session.windows.length) this.killSession(session);
    } else {
      window.layout = layout;
      if (window.active === paneId) window.active = L.panesInOrder(layout)[0];
    }
    targetWindow.layout = L.splitPane(targetWindow.layout, targetPaneId, paneId, dir, opts);
    targetWindow.zoomed = false;
    if (opts.select !== false) this.selectPane(targetWindow, paneId);
  }

  swapWindows(session: Session, a: Window, b: Window): void {
    [a.index, b.index] = [b.index, a.index];
  }

  moveWindow(session: Session, window: Window, index: number, targetSession: Session = session): void {
    if (targetSession !== session) {
      session.windows = session.windows.filter((w) => w !== window);
      if (session.active === window.id) session.active = session.windows.at(0)?.id ?? null;
      if (!session.windows.length) this.killSession(session);
      targetSession.windows.push(window);
    }
    const clash = targetSession.windows.find((w) => w !== window && w.index === index);
    if (clash) this.shiftFrom(targetSession, index);
    window.index = index;
  }
}

/** Short name for a pane: hostname for web panes (like tmux's command name). */
export function paneShortName(p: Pane | null | undefined): string {
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
