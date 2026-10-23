// Workspace page controller: boots the tmux engine, renders it, and connects
// keyboard input from this page and from pane agents (content scripts).

import { Tmux } from '../core/tmux.js';
import { Tpm } from '../tpm/tpm.js';
import { navigate } from '../core/commands.js';
import { colourToCss } from '../core/format.js';
import { loadMainConfig, loadConfigFile, CONF_KEY } from '../shared/config-source.js';
import { renderStatus } from './status.js';
import { PaneView, GAP } from './panes.js';
import { Overlays } from './overlays.js';

const { createRouter } = globalThis.CtmuxKeys;
const RUNTIME_KEY = 'ctmux:runtime';
const HISTORY_KEY = 'ctmux:history';

const chromeStorage = {
  async get(k) { return (await chrome.storage.local.get(k))[k]; },
  async set(k, v) { await chrome.storage.local.set({ [k]: v }); },
  async remove(k) { await chrome.storage.local.remove(k); },
};

class Workspace {
  constructor() {
    this.tabId = null;
    this.statusEl = document.getElementById('status');
    this.cell = { w: 8, h: 20 };
    this.history = [];
    this.configMeta = { label: '', error: null, lines: 0 };
    this.detachedState = false;
    this.renderQueued = false;
  }

  // ------------------------------------------------------------------ boot

  async boot() {
    const tab = await chrome.tabs.getCurrent();
    this.tabId = tab?.id ?? null;
    // Header-stripping rules must be in place before any pane iframe loads.
    try {
      await chrome.runtime.sendMessage({ ctmux: 'register-workspace' });
    } catch (err) {
      console.warn('chrome-tmux: service worker registration failed', err);
    }

    const t = new Tmux({ ui: this.uiAdapter(), loadFile: loadConfigFile });
    this.t = t;
    this.tpm = new Tpm(t, { storage: chromeStorage });
    this.router = createRouter(() => this.runtime);
    this.overlays = new Overlays(this);
    this.view = new PaneView(t, {
      panesEl: document.getElementById('panes'),
      decorEl: document.getElementById('decor'),
      shieldEl: document.getElementById('shield'),
      onLauncherSubmit: (id, value) => this.launcherSubmit(id, value),
      history: () => this.history,
    });

    this.history = (await chromeStorage.get(HISTORY_KEY)) || [];
    this.renderHistoryList();
    await t.loadDefaults();
    await this.loadConfig();
    this.applyTheme();

    const saved = this.tabId != null ? (await chrome.storage.session.get(this.stateKey()))[this.stateKey()] : null;
    const hadLiveState = t.server.load(saved);
    if (!hadLiveState) t.server.newSession({});
    await this.tpm.runStartup({ hadLiveState });
    await this.tpm.loadMetaCache();

    t.server.addEventListener('change', (e) => this.onChange(e.detail));
    this.installListeners();
    this.publishRuntime();
    this.render();
    this.startStatusTimer();
    document.getElementById('boot').classList.add('done');
    this.focusPane();
    const errors = t.notices.filter((n) => n.level === 'error' && n.source !== '(defaults)').length;
    if (this.configMeta.error) this.overlays.message(this.configMeta.error, { duration: 6000 });
    else if (errors) this.overlays.message(`${errors} error(s) in configuration — prefix ~ for details`, { duration: 5000 });
  }

  stateKey() { return `ctmux:server:${this.tabId}`; }

  async loadConfig() {
    const { text, label, error } = await loadMainConfig();
    this.configMeta = { label, error, lines: text ? text.split('\n').length : 0 };
    if (error) this.t.notice(error, { level: 'warn', source: label });
    // Notices point at "<path>:<line>"; uploaded or pasted text stands in for ~/.tmux.conf.
    const source = label.startsWith('/') ? label.split(' ')[0] : '~/.tmux.conf';
    if (text) await this.t.runConfig(text, { source });
    this.tpm.finish();
  }

  configInfo() { return this.configMeta; }

  applyTheme() {
    const t = this.t;
    const root = document.documentElement.style;
    const size = Number(t.getOption('@ctmux-font-size')) || 13;
    root.setProperty('--font', t.getOption('@ctmux-font-family'));
    root.setProperty('--font-size', `${size}px`);
    const lineH = Math.round(size * 1.5);
    root.setProperty('--line-h', `${lineH}px`);
    root.setProperty('--term-bg', colourToCss(t.getOption('@ctmux-background')) || '#121212');
    root.setProperty('--term-fg', colourToCss(t.getOption('@ctmux-foreground')) || '#d0d0d0');
    const mode = parseModeStyle(t.getOption('mode-style'));
    if (mode.bg) root.setProperty('--mode-bg', mode.bg);
    if (mode.fg) root.setProperty('--mode-fg', mode.fg);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${size}px ${t.getOption('@ctmux-font-family')}`;
    this.cell = { w: Math.max(4, ctx.measureText('M').width), h: lineH };
  }

  // ---------------------------------------------------------- UI adapter

  uiAdapter() {
    const self = this;
    return {
      geometry: () => ({ rect: self.view?.areaRect?.w ? self.view.areaRect : self.view?.area() || { x: 0, y: 0, w: 1200, h: 800 }, gap: GAP, cell: self.cell }),
      message: (text, opts) => self.overlays?.message(text, opts),
      prompt: (opts) => self.overlays.prompt(opts),
      confirm: (text, opts) => self.overlays.confirm(text, opts),
      showList: (opts) => self.overlays.showList(opts),
      showMessages: (tab) => self.overlays.debugPanel(tab || 'config'),
      chooseTree: (opts) => self.overlays.chooseTree(opts),
      pick: (opts) => self.overlays.pick(opts),
      displayPanes: (opts) => { self.render(); return self.overlays.displayPanes(opts); },
      clock: (paneId) => { self.render(); self.overlays.clock(paneId); },
      copyMode: (paneId, opts) => self.enterCopyMode(paneId, opts),
      paneCommand: (paneId, msg) => self.paneCommand(paneId, msg),
      focusPane: (paneId) => self.focusPane(paneId),
      renderPane: (paneId, opts) => self.renderPane(paneId, opts),
      detach: () => self.detach(),
      refresh: () => { self.applyTheme(); self.render(); },
      writeClipboard: (text) => self.writeClipboard(text),
      openTab: (url) => chrome.tabs.create({ url, index: undefined, active: true }),
      serverEmpty: () => self.serverEmpty(),
      setKeyTable: (name) => self.setKeyTable(name),
      keysChanged: () => self.publishRuntime(),
      optionChanged: (name) => {
        self.publishRuntime();
        if (/^@ctmux-|^mode-style$/.test(name)) self.applyTheme();
        if (name === 'status-interval' && self.statusTimer) self.startStatusTimer();
      },
      configReloaded: () => { self.applyTheme(); self.publishRuntime(); self.startStatusTimer(); self.render(); },
    };
  }

  // ------------------------------------------------------------- rendering

  onChange(reason) {
    this.scheduleRender();
    this.scheduleSave();
    if (reason !== 'prefix') this.updateTitle();
  }

  scheduleRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => { this.renderQueued = false; this.render(); });
  }

  render() {
    if (!this.t) return;
    this.renderStatus();
    this.view.render();
    this.updateTitle();
  }

  renderStatus() {
    renderStatus(this.t, this.statusEl, this.overlays?.statusOverlay || null);
  }

  flashStatusHint(text) {
    this.overlays.message(text, { duration: 2000 });
  }

  updateTitle() {
    const t = this.t;
    if (t.getOption('set-titles') === 'on') {
      document.title = t.expandPlain(t.getOption('set-titles-string'), {}, { time: true }).trim() || 'chrome-tmux';
    } else {
      document.title = t.expandPlain('[#S] #I:#W — chrome-tmux');
    }
  }

  startStatusTimer() {
    clearInterval(this.statusTimer);
    const secs = Number(this.t.getOption('status-interval'));
    if (secs > 0) this.statusTimer = setInterval(() => this.renderStatus(), secs * 1000);
  }

  renderPane(paneId, { navigate: nav } = {}) {
    const p = this.t.server.panes[paneId];
    if (!p) return;
    if (nav) this.view.navigate(p);
    else this.view.remount(p);
    this.scheduleRender();
    this.scheduleSave();
  }

  // ----------------------------------------------------------- persistence

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (this.tabId == null) return;
      chrome.storage.session.set({ [this.stateKey()]: this.t.server.toJSON() }).catch(() => {});
    }, 250);
  }

  publishRuntime() {
    this.runtime = this.t.runtimeConfig();
    clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => {
      chrome.storage.local.set({ [RUNTIME_KEY]: this.runtime }).catch(() => {});
    }, 50);
  }

  async remember(url, title) {
    if (!url || !/^https?:|^file:/.test(url)) return;
    this.history = [{ url, title }, ...this.history.filter((h) => h.url !== url)].slice(0, 200);
    clearTimeout(this.historyTimer);
    this.historyTimer = setTimeout(() => { chromeStorage.set(HISTORY_KEY, this.history); this.renderHistoryList(); }, 1000);
  }

  renderHistoryList() {
    let dl = document.getElementById('ctmux-history');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'ctmux-history'; document.body.appendChild(dl); }
    dl.textContent = '';
    for (const h of this.history.slice(0, 100)) {
      const o = document.createElement('option');
      o.value = h.url;
      if (h.title) o.label = h.title;
      dl.appendChild(o);
    }
  }

  // ----------------------------------------------------------------- focus

  /** Move keyboard focus into the active pane (unless an overlay owns it). */
  focusPane(paneId) {
    if (this.overlays?.active) return;
    // Synchronous on purpose: a keystroke arriving before a deferred focus
    // would otherwise re-select the previously focused pane.
    this.render();
    const id = this.t.server.window?.active ?? paneId;
    if (id != null) this.view.focus(id);
  }

  /** Take focus away from pane iframes so the workspace sees keystrokes. */
  keySink() {
    document.getElementById('keysink').focus();
  }

  /** Make the pane that has (or just got) focus the active pane. */
  syncActiveFromFocus(paneId) {
    const srv = this.t.server;
    if (paneId == null || !srv.panes[paneId]) return;
    const loc = srv.locate(paneId);
    if (!loc || loc.session !== srv.session || loc.window !== srv.window) return;
    if (loc.window.active === paneId) return;
    srv.selectPane(loc.window, paneId);
    srv.changed('focus');
  }

  // ----------------------------------------------------------------- input

  installListeners() {
    window.addEventListener('keydown', (e) => this.onKeyDown(e), true);
    window.addEventListener('resize', () => this.scheduleRender());
    window.addEventListener('blur', () => {
      setTimeout(() => {
        const a = document.activeElement;
        if (a?.tagName === 'IFRAME' && !this.overlays.active) this.syncActiveFromFocus(Number(a.dataset.pane));
      }, 0);
    });
    document.getElementById('panes').addEventListener('focusin', (e) => {
      const id = this.view.paneAt(e.target);
      if (id != null && !this.overlays.active) this.syncActiveFromFocus(id);
    });
    this.statusEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('input')) return;
      e.preventDefault();
      if (this.overlays.statusOverlay?.message != null) { this.overlays.dismissMessage?.(); return; }
      const win = e.target.closest('.win');
      if (win) {
        const s = this.t.server.session;
        const w = s.windows.find((x) => x.id === Number(win.dataset.window));
        if (w) { this.t.server.selectWindow(s, w); this.t.server.changed('click'); this.focusPane(); }
      } else {
        // Escape hatch for pages without a pane agent: keys now reach the workspace.
        this.keySink();
      }
    });
    this.statusEl.addEventListener('wheel', (e) => {
      if (this.t.getOption('mouse') !== 'on') return;
      e.preventDefault();
      this.t.runString(e.deltaY > 0 ? 'next-window' : 'previous-window');
    }, { passive: false });
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => this.onAgentMessage(msg, sender, sendResponse));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[CONF_KEY] && !this.t.sourcing) {
        this.overlays.message('Configuration changed — run source-file ~/.tmux.conf (or your reload key) to apply');
      }
    });
    window.addEventListener('pagehide', () => {
      if (this.tabId != null) chrome.storage.session.set({ [this.stateKey()]: this.t.server.toJSON() });
    });
  }

  onKeyDown(e) {
    if (this.overlays.active) {
      this.overlays.onKey(e);
      return;
    }
    if (this.overlays.statusOverlay?.message != null) this.overlays.dismissMessage?.();
    const r = this.router.feed(e);
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    const pane = this.view.paneAt(document.activeElement);
    if (pane != null) this.syncActiveFromFocus(pane);
    this.dispatchKey(r);
  }

  async dispatchKey(r) {
    try {
      await this.t.handleKey(r, {});
    } catch (err) {
      this.overlays.message(String(err.message || err));
    }
    if (this.router.table === 'root' && this.t.keyTable !== 'root') this.setKeyTable('root');
  }

  setKeyTable(name) {
    this.t.keyTable = name;
    this.router.setTable(name);
    const p = this.t.server.pane;
    if (p) this.paneCommand(p.id, { type: 'set-table', table: name });
  }

  /** Map a message sender to a pane id. */
  senderPane(msg, sender) {
    const panes = this.t.server.panes;
    if (msg.pane != null && panes[msg.pane]) {
      if (msg.root && sender.frameId != null) panes[msg.pane].frameId = sender.frameId;
      return Number(msg.pane);
    }
    for (const p of Object.values(panes)) if (p.frameId != null && p.frameId === sender.frameId) return p.id;
    const a = document.activeElement;
    return a?.tagName === 'IFRAME' ? Number(a.dataset.pane) : null;
  }

  onAgentMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.ctmux !== 'string' || msg.ctmux === 'register-workspace') return false;
    if (!sender.tab || sender.tab.id !== this.tabId) return false;
    const t = this.t;
    const paneId = this.senderPane(msg, sender);
    const pane = paneId != null ? t.server.panes[paneId] : null;

    switch (msg.ctmux) {
      case 'key': {
        if (this.overlays.active) {
          // A frame still had focus while an overlay opened; pull focus back.
          this.keySink();
          return false;
        }
        if (paneId != null) this.syncActiveFromFocus(paneId);
        this.dispatchKey({ table: msg.table, key: msg.key, prefix: msg.prefix });
        return false;
      }
      case 'hello':
      case 'report': {
        if (!pane || !msg.root) return false;
        const changed = pane.url !== msg.url || pane.title !== msg.title;
        if (msg.url && msg.url !== 'about:blank') pane.url = msg.url;
        if (!pane.manualTitle) pane.title = msg.title || '';
        if (msg.ctmux === 'hello' && pane.mode) pane.mode = null;
        if (changed) {
          this.remember(pane.url, pane.title);
          t.server.changed('report');
        }
        return false;
      }
      case 'focus':
        if (paneId != null && !this.overlays.active) this.syncActiveFromFocus(paneId);
        return false;
      case 'mode':
        if (pane) { pane.mode = msg.mode || null; t.server.changed('mode'); }
        if (!msg.mode) this.focusPane();
        return false;
      case 'yank':
        t.buffers.unshift({ name: `buffer${String(t.buffers.length).padStart(4, '0')}`, data: msg.text, time: Date.now() });
        if (t.buffers.length > 50) t.buffers.pop();
        if (msg.copied === false) this.writeClipboard(msg.text);
        return false;
      case 'paste-request':
        sendResponse({ text: t.buffers[0]?.data ?? '' });
        return false;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------- pane agents

  async paneCommand(paneId, msg) {
    const p = this.t.server.panes[paneId];
    if (!p || p.kind !== 'web') {
      if (msg.type === 'paste' && p) {
        const v = this.view.els.get(paneId);
        if (v?.input) { v.input.setRangeText(msg.text, v.input.selectionStart, v.input.selectionEnd, 'end'); v.input.focus(); }
      }
      return null;
    }
    if (p.frameId == null || this.tabId == null) return null;
    try {
      return await chrome.tabs.sendMessage(this.tabId, { ctmux: true, ...msg }, { frameId: p.frameId });
    } catch {
      return null;
    }
  }

  async enterCopyMode(paneId, opts = {}) {
    const p = this.t.server.panes[paneId];
    if (!p || p.kind !== 'web') { this.overlays.message('copy-mode: pane has no page'); return; }
    const table = this.t.getOption('mode-keys') === 'vi' ? 'copy-mode-vi' : 'copy-mode';
    const ok = await this.paneCommand(paneId, { type: 'copy-mode', table, scrollUp: !!opts.scrollUp });
    if (!ok) { this.overlays.message('copy-mode unavailable for this page (pane agent not running)'); return; }
    p.mode = 'copy-mode';
    this.t.server.changed('mode');
    this.view.focus(paneId);
  }

  async writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch { /* fall back below */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    this.focusPane();
  }

  // ------------------------------------------------------------- lifecycle

  launcherSubmit(paneId, value) {
    const v = value.trim();
    if (!v) return;
    if (v.startsWith(':')) {
      this.t.runString(v.slice(1));
      return;
    }
    if (/^tmux\s+/.test(v)) {
      this.t.runString(v.replace(/^tmux\s+/, ''));
      return;
    }
    navigate(this.t, paneId, v);
    this.t.server.changed('navigate');
  }

  detach() {
    const s = this.t.server.session;
    this.overlays.closeAll();
    this.keySink();
    this.overlays.detached(s?.name ?? '', () => { this.render(); this.focusPane(); });
  }

  serverEmpty() {
    if (this.t.server.sessions.length) return;
    this.overlays.message('[exited] — started a new session');
    this.t.server.newSession({});
  }
}

function parseModeStyle(s) {
  const out = {};
  for (const tok of String(s).split(/[,\s]+/)) {
    const m = /^(fg|bg)=(.+)$/.exec(tok);
    if (m) out[m[1]] = colourToCss(m[2]);
  }
  return out;
}

const ws = new Workspace();
window.ctmux = ws; // handy for debugging from DevTools
ws.boot().catch((err) => {
  console.error(err);
  const boot = document.getElementById('boot');
  boot.textContent = `chrome-tmux failed to start: ${err.message || err}`;
});

