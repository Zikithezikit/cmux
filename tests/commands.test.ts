// Bug fixes in src/core/commands.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tmux } from '../src/core/tmux.js';
import type { Ui } from '../src/core/types.js';

/** A stub UI that records messages; any method it doesn't define is a no-op. */
function stubUi(messages: string[]): Ui {
  const ui = {
    geometry: () => ({ rect: { x: 0, y: 0, w: 1600, h: 900 }, gap: 1, cell: { w: 8, h: 20 } }),
    message: (m: string) => { messages.push(m); },
  };
  return new Proxy(ui, { get: (o, p) => (p in o ? o[p as keyof typeof o] : () => {}) }) as unknown as Ui;
}

test('new-window -t <index> with no current session creates the session', async () => {
  const messages: string[] = [];
  const t = new Tmux({ ui: stubUi(messages) });
  await t.loadDefaults();
  assert.equal(t.server.sessions.length, 0);
  const out: string[] = [];
  await t.runString('new-window -t 3', { print: (l) => out.push(l) });
  assert.equal(t.server.sessions.length, 1);
  const s = t.server.session;
  assert.ok(s);
  assert.ok(s.windows.some((w) => w.index === 3), 'window created at index 3');
  assert.deepEqual(messages, []);
});
