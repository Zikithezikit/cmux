// Resolution of tmux target specifications (-t / -s):
//   [session][:[window][.[pane]]], %pane-id, @window-id, $session-id,
//   and the special tokens (!, +, -, {last}, {next}, {left}, ...).

import { panesInOrder, computeRects, neighbour } from './layout.js';

function findSession(server, spec, current) {
  if (!spec) return current;
  if (spec[0] === '$') return server.sessionById(Number(spec.slice(1)));
  if (spec === '!' ) return server.sessionById(server.lastSessionId);
  const exact = spec[0] === '=' ? spec.slice(1) : null;
  if (exact != null) return server.sessionByName(exact);
  return server.sessionByName(spec)
    || server.sessions.find((s) => s.name.startsWith(spec))
    || null;
}

function findWindow(server, session, spec, current) {
  if (!session) return null;
  const sorted = server.sortedWindows(session);
  const cur = current && session.windows.includes(current) ? current : server.activeWindow(session);
  if (spec === '' || spec == null) return cur;
  if (spec[0] === '@') return session.windows.find((w) => w.id === Number(spec.slice(1))) || null;
  const pos = sorted.indexOf(cur);
  const rel = (n) => sorted.length ? sorted[((pos + n) % sorted.length + sorted.length) % sorted.length] : null;
  switch (spec) {
    case '!': case '{last}': return session.windows.find((w) => w.id === session.last) || null;
    case '+': case '{next}': return rel(1);
    case '-': case '{previous}': return rel(-1);
    case '^': case '{start}': return sorted[0] || null;
    case '$': case '{end}': return sorted[sorted.length - 1] || null;
  }
  let m;
  if ((m = /^([+-])(\d+)$/.exec(spec))) return rel((m[1] === '+' ? 1 : -1) * Number(m[2]));
  const exact = spec[0] === '=';
  const s = exact ? spec.slice(1) : spec;
  if (/^\d+$/.test(s)) {
    const byIndex = session.windows.find((w) => w.index === Number(s));
    if (byIndex || exact) return byIndex || null;
  }
  const byName = session.windows.find((w) => server.windowName(w) === s);
  if (byName || exact) return byName || null;
  return session.windows.find((w) => server.windowName(w).startsWith(s)) || null;
}

function findPane(server, window, spec, geometry) {
  if (!window) return null;
  const ids = panesInOrder(window.layout);
  if (spec === '' || spec == null) return window.active;
  if (spec[0] === '%') {
    const id = Number(spec.slice(1));
    return ids.includes(id) ? id : null;
  }
  const pos = ids.indexOf(window.active);
  const rel = (n) => ids[((pos + n) % ids.length + ids.length) % ids.length];
  switch (spec) {
    case '!': case '{last}': return ids.includes(window.last) ? window.last : null;
    case '+': case '{next}': return rel(1);
    case '-': case '{previous}': return rel(-1);
  }
  let m;
  if ((m = /^([+-])(\d+)$/.exec(spec))) return rel((m[1] === '+' ? 1 : -1) * Number(m[2]));
  if (/^\d+$/.test(spec)) {
    const base = Number(server.getOption('pane-base-index') || 0);
    return ids[Number(spec) - base] ?? null;
  }
  const dirs = { '{left-of}': 'L', '{right-of}': 'R', '{up-of}': 'U', '{down-of}': 'D' };
  if (dirs[spec] && geometry) {
    const { panes } = computeRects(window.layout, geometry.rect, geometry.gap);
    return neighbour(panes, window.active, dirs[spec], false);
  }
  const edges = { '{top}': 'top', '{bottom}': 'bottom', '{left}': 'left', '{right}': 'right',
    '{top-left}': 'tl', '{top-right}': 'tr', '{bottom-left}': 'bl', '{bottom-right}': 'br' };
  if (edges[spec]) {
    const { panes } = computeRects(window.layout, { x: 0, y: 0, w: 1000, h: 1000 }, 0);
    const score = (r) => ({
      top: r.y, bottom: -(r.y + r.h), left: r.x, right: -(r.x + r.w),
      tl: r.x + r.y, tr: -(r.x + r.w) + r.y, bl: r.x - (r.y + r.h), br: -(r.x + r.w) - (r.y + r.h),
    })[edges[spec]];
    return ids.slice().sort((a, b) => score(panes[a]) - score(panes[b]))[0];
  }
  return null;
}

/**
 * Resolve a target. `kind` is 'pane', 'window' or 'session'.
 * Returns { session, window, pane } (pane is a pane id) or null when not found.
 */
export function resolveTarget(server, spec, kind, ctx = {}, geometry = null) {
  const curSession = ctx.session || server.session;
  const curWindow = ctx.window || (curSession && server.activeWindow(curSession));
  const done = (session, window, pane) => {
    if (!session) return null;
    window = window || server.activeWindow(session);
    if (!window && kind !== 'session') return null;
    if (pane == null && window) pane = window.active;
    return { session, window, pane };
  };

  if (spec == null || spec === '') return done(curSession, curWindow, ctx.pane ?? null);
  spec = String(spec);

  // The marked pane: `~` or `{marked}` (alone, or as the pane part of a target).
  if (spec === '~' || spec === '{marked}' || /[:.](~|\{marked\})$/.test(spec)) {
    const id = server.markedPane?.();
    if (id == null) return null;
    const loc = server.locate(id);
    return loc ? { session: loc.session, window: loc.window, pane: id } : null;
  }

  if (spec[0] === '%' && /^%\d+$/.test(spec)) {
    const id = Number(spec.slice(1));
    const loc = server.locate(id);
    return loc ? { session: loc.session, window: loc.window, pane: id } : null;
  }
  if (spec[0] === '@' && /^@\d+$/.test(spec)) {
    const loc = server.windowById(Number(spec.slice(1)));
    return loc ? done(loc.session, loc.window) : null;
  }

  const colon = spec.indexOf(':');
  let sPart, wPart, pPart;
  if (colon !== -1) {
    sPart = spec.slice(0, colon);
    const rest = spec.slice(colon + 1);
    const dot = rest.lastIndexOf('.');
    if (dot !== -1 && !/^\{.*\}$/.test(rest)) { wPart = rest.slice(0, dot); pPart = rest.slice(dot + 1); }
    else wPart = rest;
  } else if (spec[0] === '.') {
    pPart = spec.slice(1);
  } else if (/^[^.]+\.[^.]*$/.test(spec) && kind === 'pane') {
    const dot = spec.indexOf('.');
    wPart = spec.slice(0, dot);
    pPart = spec.slice(dot + 1);
  } else {
    // Bare token: interpret according to the target kind, falling back.
    if (kind === 'pane') {
      const p = findPane(server, curWindow, spec, geometry);
      if (p != null) return done(curSession, curWindow, p);
      const w = findWindow(server, curSession, spec, curWindow);
      if (w) return done(curSession, w);
      const s = findSession(server, spec, null);
      return s ? done(s) : null;
    }
    if (kind === 'window') {
      const w = findWindow(server, curSession, spec, curWindow);
      if (w) return done(curSession, w);
      const s = findSession(server, spec, null);
      return s ? done(s) : null;
    }
    const s = findSession(server, spec, null);
    if (s) return done(s);
    const w = findWindow(server, curSession, spec, curWindow);
    return w ? done(curSession, w) : null;
  }

  const session = findSession(server, sPart, curSession);
  if (!session) return null;
  const window = findWindow(server, session, wPart, session === curSession ? curWindow : null);
  if (!window) return null;
  if (pPart == null) return done(session, window);
  const pane = findPane(server, window, pPart, geometry);
  if (pane == null) return null;
  return { session, window, pane };
}
