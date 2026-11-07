// Regression tests for src/core/format.ts, layout.ts and server.ts: session
// bookkeeping when windows move away, layouts never stored as null, and the
// strftime / neighbour fixes from the typing pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from '../src/core/server.js';
import { strftime } from '../src/core/format.js';
import * as L from '../src/core/layout.js';

const options: Record<string, unknown> = { 'base-index': 0, 'pane-base-index': 0 };
const makeServer = (): Server => new Server((name) => options[name]);

test('joinPane: moving the last pane out leaves session.active null, not undefined', () => {
  const s = makeServer();
  const a = s.newSession({ name: 'a' });
  const b = s.newSession({ name: 'b' });
  const [src] = a.windows;
  const [dst] = b.windows;
  s.joinPane(src.active, dst, dst.active, 'h');
  assert.equal(a.windows.length, 0);
  assert.equal(a.active, null);
  assert.equal(L.panesInOrder(dst.layout).length, 2);
  assert.notEqual(src.layout, null, 'the dropped window never holds a null layout');
});

test('moveWindow: moving the only window away leaves session.active null, not undefined', () => {
  const s = makeServer();
  const a = s.newSession({ name: 'a' });
  const b = s.newSession({ name: 'b' });
  const [w] = a.windows;
  s.moveWindow(a, w, 5, b);
  assert.equal(a.active, null);
  assert.ok(b.windows.includes(w));
  assert.equal(w.index, 5);
  assert.equal(s.sessionByName('a'), null);
});

test('killPane: the last pane kills its window without storing a null layout', () => {
  const s = makeServer();
  const sess = s.newSession({ name: 'a' });
  const first = sess.windows[0];
  const second = s.newWindow(sess);
  const pane = second.active;
  s.killPane(pane);
  assert.deepEqual(sess.windows, [first]);
  assert.equal(sess.active, first.id);
  assert.notEqual(second.layout, null);
  assert.equal(s.panes[pane], undefined);
});

test('killPane / breakPane: active pane falls back correctly when window.last is null', () => {
  const s = makeServer();
  const sess = s.newSession({ name: 'a' });
  const [w] = sess.windows;
  const p1 = w.active;
  const p2 = s.splitPane(w, p1, 'h').id;
  const p3 = s.splitPane(w, p2, 'v').id;
  // last is null: falls back to the first pane.
  w.last = null;
  assert.equal(w.active, p3);
  const broken = s.breakPane(p3);
  assert.ok(broken && broken !== w);
  assert.equal(w.active, p1);
  assert.equal(w.last, null);
  // last points at a remaining pane: it becomes active.
  const p4 = s.splitPane(w, p1, 'h').id;
  s.selectPane(w, p2);
  s.selectPane(w, p4);
  assert.equal(w.last, p2);
  s.breakPane(p4);
  assert.equal(w.active, p2);
  // killPane with last null keeps it null and picks the first pane.
  const p5 = s.splitPane(w, p2, 'v').id;
  w.last = null;
  s.killPane(p5);
  assert.equal(w.last, null);
  assert.equal(w.active, p1);
});

test('strftime: %j (day of year) and %s (epoch seconds)', () => {
  const d = new Date(2026, 1, 3, 12, 0, 0);
  assert.equal(strftime('%j', d), '034');
  assert.equal(strftime('%j', new Date(2026, 0, 1)), '001');
  assert.equal(strftime('%s', d), String(Math.floor(d.getTime() / 1000)));
});

test('neighbour returns numeric pane ids', () => {
  let t = L.splitPane(L.leaf(10), 10, 20, 'h');
  t = L.splitPane(t, 20, 30, 'v');
  const { panes } = L.computeRects(t, { x: 0, y: 0, w: 1001, h: 601 }, 1);
  assert.equal(L.neighbour(panes, 10, 'R'), 20);
  assert.equal(L.neighbour(panes, 30, 'L'), 10);
  assert.equal(L.neighbour(panes, 10, 'L'), 20, 'wraps');
  assert.equal(L.neighbour(panes, 10, 'L', false), null);
  assert.equal(L.neighbour(panes, 99, 'L'), null);
});

test('moveDivider: a path through a pane throws', () => {
  const t = L.splitPane(L.leaf(1), 1, 2, 'h');
  const area = { x: 0, y: 0, w: 1001, h: 601 };
  assert.throws(() => L.moveDivider(t, [0], 1, 10, area));
  const moved = L.moveDivider(t, [], 1, 100, area);
  assert.ok(L.computeRects(moved, area).panes[1].w > 550);
});
