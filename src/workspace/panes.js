// Pane DOM management. Every pane of every window lives in one flat
// container and is only ever repositioned/hidden — never re-parented —
// so iframes keep their state when windows or layouts change.

import * as L from '../core/layout.js';
import { toRuns, parseStyle, styleToCss, colourToCss } from '../core/format.js';
import { renderRuns } from './status.js';

const SANDBOX = [
  'allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups',
  'allow-popups-to-escape-sandbox', 'allow-modals', 'allow-downloads',
  'allow-presentation', 'allow-pointer-lock', 'allow-storage-access-by-user-activation',
].join(' ');
const ALLOW = 'clipboard-read; clipboard-write; fullscreen; autoplay; encrypted-media; picture-in-picture; geolocation; microphone; camera; display-capture';

export const GAP = 1;

export class PaneView {
  constructor(t, { panesEl, decorEl, shieldEl, onLauncherSubmit, history }) {
    this.t = t;
    this.panesEl = panesEl;
    this.decorEl = decorEl;
    this.shieldEl = shieldEl;
    this.onLauncherSubmit = onLauncherSubmit;
    this.history = history;
    this.els = new Map(); // pane id -> { root, body, title, kind, url, iframe, input }
    this.rects = {};
    this.areaRect = { x: 0, y: 0, w: 0, h: 0 };
  }

  area() {
    const r = this.panesEl.getBoundingClientRect();
    return { x: 0, y: 0, w: Math.round(r.width), h: Math.round(r.height) };
  }

  ensure(pane) {
    let v = this.els.get(pane.id);
    if (!v) {
      const root = document.createElement('div');
      root.className = 'pane hidden';
      root.dataset.pane = pane.id;
      const body = document.createElement('div');
      body.className = 'body';
      const title = document.createElement('div');
      title.className = 'pane-title';
      root.append(title, body);
      this.panesEl.appendChild(root);
      v = { root, body, title, kind: null, url: null };
      this.els.set(pane.id, v);
    }
    if (v.kind !== pane.kind) {
      v.body.textContent = '';
      v.iframe = null;
      v.input = null;
      if (pane.kind === 'web') this.mountFrame(pane, v);
      else this.mountLauncher(pane, v);
      v.kind = pane.kind;
    }
    return v;
  }

  mountFrame(pane, v) {
    const f = document.createElement('iframe');
    f.className = 'frame';
    f.name = `ctmux-pane-${pane.id}`;
    f.dataset.pane = pane.id;
    f.setAttribute('sandbox', SANDBOX);
    f.setAttribute('allow', ALLOW);
    f.src = pane.url;
    v.url = pane.url;
    v.iframe = f;
    v.body.appendChild(f);
  }

  mountLauncher(pane, v) {
    const t = this.t;
    const box = document.createElement('div');
    box.className = 'launcher';
    if (t.getOption('@ctmux-launcher-motd') === 'on') {
      const pre = document.createElement('pre');
      const prefix = t.getOption('prefix');
      pre.textContent = `chrome-tmux — prefix ${prefix} · ${prefix} ? keys · ${prefix} : command · ${prefix} % / " split · ${prefix} c window\n` +
        `Type a URL or search terms, or :command for tmux commands.\n`;
      box.appendChild(pre);
    }
    const form = document.createElement('form');
    form.autocomplete = 'off';
    const ps1 = document.createElement('span');
    ps1.className = 'ps1';
    ps1.textContent = '❯ ';
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = 'url, search, or :command';
    input.setAttribute('list', 'ctmux-history');
    input.value = pane.prefill || '';
    input.dataset.pane = pane.id;
    form.append(ps1, input);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.onLauncherSubmit(pane.id, input.value);
    });
    box.appendChild(form);

    const recent = document.createElement('div');
    recent.className = 'recent';
    const items = this.history().slice(0, 9);
    items.forEach((h, i) => {
      const a = document.createElement('a');
      a.href = h.url;
      a.tabIndex = 0;
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = `${i + 1}  `;
      a.append(k, document.createTextNode(h.title ? `${h.title} — ${h.url}` : h.url));
      a.addEventListener('click', (e) => { e.preventDefault(); this.onLauncherSubmit(pane.id, h.url); });
      recent.appendChild(a);
    });
    box.appendChild(recent);
    box.addEventListener('mousedown', (e) => { if (e.target === box) { e.preventDefault(); input.focus(); } });
    v.input = input;
    v.body.appendChild(box);
  }

  navigate(pane) {
    const v = this.els.get(pane.id);
    if (!v) return;
    if (pane.kind === 'web' && v.kind === 'web' && v.iframe) {
      v.iframe.src = pane.url;
      v.url = pane.url;
    } else {
      this.ensure(pane);
    }
  }

  remount(pane) {
    const v = this.els.get(pane.id);
    if (v) v.kind = null;
    this.ensure(pane);
  }

  /** Lay out the current window; hide everything else. */
  render() {
    const t = this.t;
    const srv = t.server;
    const window = srv.window;
    const area = this.area();
    this.areaRect = area;

    for (const [id, v] of this.els) {
      if (!srv.panes[id]) { v.root.remove(); this.els.delete(id); }
    }
    for (const p of Object.values(srv.panes)) this.ensure(p);

    let rects = {};
    let dividers = [];
    if (window) {
      if (window.zoomed) rects = { [window.active]: area };
      else ({ panes: rects, dividers } = L.computeRects(window.layout, area, GAP));
    }
    this.rects = rects;
    this.dividers = dividers;

    const borderStatus = t.getOption('pane-border-status');
    const borderStyle = parseStyle(t.getOption('pane-border-style'));
    const activeStyle = parseStyle(t.getOption('pane-active-border-style'));
    const many = Object.keys(rects).length > 1;

    for (const [id, v] of this.els) {
      const r = rects[id];
      if (!r) { v.root.classList.add('hidden'); continue; }
      v.root.classList.remove('hidden');
      Object.assign(v.root.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      const showTitle = borderStatus === 'top' || borderStatus === 'bottom';
      v.root.classList.toggle('title-top', borderStatus === 'top');
      v.root.classList.toggle('title-bottom', borderStatus === 'bottom');
      v.title.textContent = '';
      if (showTitle) {
        const active = Number(id) === window.active;
        const st = active ? activeStyle : borderStyle;
        const runs = toRuns(t.expand(t.getOption('pane-border-format'), { window, pane: Number(id) }, { time: true }), st);
        renderRuns(v.title, runs);
        Object.assign(v.title.style, { color: '', backgroundColor: '' }, styleToCss(st));
      }
    }

    // Borders.
    this.decorEl.textContent = '';
    const fg = (s, fallback) => s.fg || fallback;
    document.documentElement.style.setProperty('--border', fg(borderStyle, colourToCss('colour240')));
    document.documentElement.style.setProperty('--border-active', fg(activeStyle, colourToCss('green')));
    for (const d of dividers) {
      const el = document.createElement('div');
      el.className = `divider ${d.dir}`;
      Object.assign(el.style, { left: `${d.rect.x}px`, top: `${d.rect.y}px`, width: `${d.rect.w}px`, height: `${d.rect.h}px` });
      el.addEventListener('mousedown', (e) => this.startDrag(e, d));
      this.decorEl.appendChild(el);
    }
    if (many && window) {
      const r = rects[window.active];
      if (r) {
        const edges = [];
        if (r.x > 0) edges.push({ x: r.x - GAP, y: r.y - (r.y > 0 ? GAP : 0), w: GAP, h: r.h + (r.y > 0 ? GAP : 0) + (r.y + r.h < area.h ? GAP : 0) });
        if (r.x + r.w < area.w) edges.push({ x: r.x + r.w, y: r.y - (r.y > 0 ? GAP : 0), w: GAP, h: r.h + (r.y > 0 ? GAP : 0) + (r.y + r.h < area.h ? GAP : 0) });
        if (r.y > 0) edges.push({ x: r.x, y: r.y - GAP, w: r.w, h: GAP });
        if (r.y + r.h < area.h) edges.push({ x: r.x, y: r.y + r.h, w: r.w, h: GAP });
        for (const e of edges) {
          const el = document.createElement('div');
          el.className = 'edge';
          Object.assign(el.style, { left: `${e.x}px`, top: `${e.y}px`, width: `${e.w}px`, height: `${e.h}px` });
          this.decorEl.appendChild(el);
        }
      }
    }
  }

  startDrag(e, d) {
    if (e.button !== 0) return;
    e.preventDefault();
    const t = this.t;
    const window = t.server.window;
    if (!window) return;
    this.shieldEl.classList.add('on');
    this.shieldEl.style.cursor = d.dir === 'h' ? 'col-resize' : 'row-resize';
    const origin = this.panesEl.getBoundingClientRect();
    const move = (ev) => {
      const pos = d.dir === 'h' ? ev.clientX - origin.left : ev.clientY - origin.top;
      window.layout = L.setDivider(window.layout, d.path, d.index, Math.round(pos), this.areaRect, GAP);
      this.render();
    };
    const up = () => {
      this.shieldEl.classList.remove('on');
      removeEventListener('mousemove', move, true);
      removeEventListener('mouseup', up, true);
      t.server.changed('resize');
    };
    addEventListener('mousemove', move, true);
    addEventListener('mouseup', up, true);
  }

  focus(paneId) {
    const v = this.els.get(paneId);
    if (!v) return;
    if (v.iframe) v.iframe.focus();
    else if (v.input) v.input.focus();
  }

  paneAt(el) {
    const host = el?.closest?.('[data-pane]');
    return host ? Number(host.dataset.pane) : null;
  }
}
