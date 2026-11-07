// Status line rendering: status-left, window list, status-right, plus the
// message / prompt modes that temporarily take over the line.

import { toRuns, truncateRuns, parseStyle, applyStyle, styleToCss } from '../core/format.js';
import type { Run, Style } from '../core/format.js';
import type { Tmux } from '../core/tmux.js';

/** What temporarily takes over the status line: a message or a prompt. */
export interface StatusOverlay {
  message?: string;
  prompt?: HTMLElement;
  command?: boolean;
}

// Powerline private-use glyphs → CSS shapes (no patched font needed).
const PL: Readonly<Record<string, string>> = { '': 'r', '': 'l', '': 'rr', '': 'lr', '': 'rt', '': 'lt', '': 'rt', '': 'lt' };
const PL_RE = /[-]/;

export function baseStyle(t: Tmux): Style {
  return parseStyle(t.getOption('status-style'));
}

/** Append runs to `el` as styled spans. */
export function renderRuns(el: HTMLElement, runs: readonly Run[]): void {
  for (const r of runs) {
    const css = styleToCss(r.style);
    const parts = PL_RE.test(r.text) ? r.text.split(/([-])/) : [r.text];
    for (const part of parts) {
      if (!part) continue;
      if (PL[part]) {
        const sep = document.createElement('span');
        sep.className = `pl ${PL[part]}`;
        if (css.backgroundColor) sep.style.backgroundColor = css.backgroundColor;
        if (css.color) sep.style.color = css.color;
        sep.appendChild(document.createElement('i'));
        el.appendChild(sep);
        continue;
      }
      const span = document.createElement('span');
      span.className = 'run';
      Object.assign(span.style, css);
      span.textContent = part;
      el.appendChild(span);
    }
  }
}

function segment(cls: string, runs: readonly Run[]): HTMLElement {
  const el = document.createElement('div');
  el.className = `seg ${cls}`;
  renderRuns(el, runs);
  return el;
}

/**
 * Render the status line into `el`.
 * `overlay` is null, a message, or a prompt element that takes over the line.
 */
export function renderStatus(t: Tmux, el: HTMLElement, overlay: StatusOverlay | null): void {
  const app = document.getElementById('app')!;
  const pos = t.getOption('status-position') === 'top' ? 'top' : 'bottom';
  app.classList.toggle('status-top', pos === 'top');
  app.classList.toggle('status-bottom', pos !== 'top');
  const on = t.getOption('status') !== 'off';
  el.classList.toggle('hidden', !on && !overlay);
  el.textContent = '';

  const base = baseStyle(t);
  Object.assign(el.style, { color: '', backgroundColor: '' }, styleToCss(base));

  if (overlay?.message != null) {
    const st = parseStyle(t.getOption('message-style'), base);
    const m = document.createElement('div');
    m.className = 'message';
    Object.assign(m.style, styleToCss(st));
    m.textContent = overlay.message;
    el.appendChild(m);
    return;
  }
  if (overlay?.prompt) {
    const st = parseStyle(t.getOption(overlay.command ? 'message-command-style' : 'message-style'), base);
    Object.assign(overlay.prompt.style, styleToCss(st));
    el.appendChild(overlay.prompt);
    return;
  }
  if (!on) return;

  const session = t.server.session;
  if (!session) return;

  const leftStyle = applyStyle(base, t.getOption('status-left-style'), base);
  const left = truncateRuns(toRuns(t.expand(t.getOption('status-left'), {}, { time: true }), leftStyle),
    Number(t.getOption('status-left-length')));
  const rightStyle = applyStyle(base, t.getOption('status-right-style'), base);
  const right = truncateRuns(toRuns(t.expand(t.getOption('status-right'), {}, { time: true }), rightStyle),
    Number(t.getOption('status-right-length')));

  const winEl = document.createElement('div');
  winEl.className = 'seg windows';
  const sep = t.getOption('window-status-separator');
  const windows = t.server.sortedWindows(session);
  windows.forEach((w, i) => {
    const current = w.id === session.active;
    const last = w.id === session.last;
    let st = applyStyle(base, t.getOption('window-status-style'), base);
    if (current) st = applyStyle(st, t.getOption('window-status-current-style'), base);
    else if (last) st = applyStyle(st, t.getOption('window-status-last-style'), base);
    const fmt = t.getOption(current ? 'window-status-current-format' : 'window-status-format');
    const runs = toRuns(t.expand(fmt, { session, window: w }, { time: true }), st);
    const span = document.createElement('div');
    span.className = 'win';
    span.dataset.window = String(w.id);
    renderRuns(span, runs);
    winEl.appendChild(span);
    if (sep && i < windows.length - 1) renderRuns(winEl, toRuns(sep, base));
  });

  const justify = t.getOption('status-justify');
  const spacer = () => { const s = document.createElement('div'); s.className = 'spacer'; return s; };
  el.appendChild(segment('left', left));
  if (justify === 'centre' || justify === 'absolute-centre') el.appendChild(spacer());
  else if (justify === 'right') el.appendChild(spacer());
  el.appendChild(winEl);
  el.appendChild(spacer());
  el.appendChild(segment('right', right));
}

