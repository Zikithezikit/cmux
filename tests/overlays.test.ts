// Overlays bug fixes. Node has no DOM, so these cover the paths that return
// before any element is built, with a minimal `document` stub.

import '../src/shared/keys.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Overlays } from '../src/workspace/overlays.js';
import type { OverlayHost } from '../src/workspace/overlays.js';
import type { Tmux } from '../src/core/tmux.js';

function overlays(): Overlays {
  const g = globalThis as { document?: unknown };
  g.document ??= { getElementById: () => ({}) };
  const t = { server: { window: null }, getOption: () => '1000' } as unknown as Tmux;
  const host = {
    t, view: { areaRect: { x: 0, y: 0, w: 0, h: 0 }, rects: {} }, cell: { w: 8, h: 17 },
    keySink() {}, focusPane() {}, renderStatus() {}, flashStatusHint() {},
    configInfo: () => ({ label: '', error: null, lines: 0 }),
  } satisfies OverlayHost;
  return new Overlays(host);
}

test('displayPanes without options does not throw', async () => {
  const ov = overlays();
  assert.equal(await ov.displayPanes(), null);
  assert.equal(await ov.displayPanes({}), null);
  assert.equal(await ov.displayPanes({ time: 0 }), null);
});
