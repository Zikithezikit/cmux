// TPM emulation: plugin emulators outside a browser, and the typed fakes
// (TpmFetch, TpmTimers) tests and the options page inject.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tmux, nullUi } from '../src/core/tmux.js';
import { Tpm, memoryStorage } from '../src/tpm/tpm.js';
import type { TpmFetch, TpmTimers } from '../src/tpm/tpm.js';
import type { Ui } from '../src/core/types.js';

// Minimal fakes: they type-check against TpmTimers/TpmFetch without casts.
const timers: TpmTimers = { setInterval: () => 0, clearInterval() {} };
const offlineFetch: TpmFetch = async () => ({ ok: false, status: 0, json: async () => null });

async function boot(conf: string, { fetchImpl = offlineFetch, ui = nullUi() }: { fetchImpl?: TpmFetch; ui?: Ui } = {}) {
  const t = new Tmux({ ui });
  const tpm = new Tpm(t, { storage: memoryStorage(), timers, fetchImpl });
  await t.loadDefaults();
  await t.runConfig(conf, { source: 'test.conf' });
  tpm.finish();
  t.server.newSession({});
  return { t, tpm };
}

/** Runs fn with no global `navigator`, as in runtimes that don't define one. */
async function withoutNavigator<T>(fn: () => Promise<T>): Promise<T> {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Reflect.deleteProperty(globalThis, 'navigator');
  try {
    assert.equal(typeof navigator, 'undefined');
    return await fn();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
  }
}

test('dracula: #{dracula_network} works without a global navigator', async () => {
  await withoutNavigator(async () => {
    const { t } = await boot("set -g @plugin 'dracula/tmux'\nset -g @dracula-plugins 'network battery'");
    assert.equal(t.expand('#{dracula_network}'), 'Online');
    assert.equal(t.expand('#{dracula_battery}'), 'AC');
  });
});

test('online-status: #{online_status} works without a global navigator', async () => {
  await withoutNavigator(async () => {
    const { t } = await boot("set -g @plugin 'tmux-plugins/tmux-online-status'");
    assert.equal(t.expand('#{online_status}'), 'online');
  });
});

test('resurrect: restore focuses the active pane', async () => {
  const focused: (number | undefined)[] = [];
  const focusPane: Ui['focusPane'] = (paneId) => { focused.push(paneId); };
  const ui = new Proxy(nullUi(), { get: (o, p, r): unknown => (p === 'focusPane' ? focusPane : Reflect.get(o, p, r)) });
  const { t } = await boot("set -g @plugin 'tmux-plugins/tmux-resurrect'", { ui });
  await t.runString('resurrect-save -q');
  await t.runString('kill-server');
  focused.length = 0;
  await t.runString('resurrect-restore -q');
  assert.equal(t.server.sessions.length, 1);
  assert.deepEqual(focused, [undefined]);
});

test('tpm: metadata is read from a minimal TpmFetch fake', async () => {
  const fetchImpl: TpmFetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ full_name: 'dracula/tmux', stargazers_count: 7, license: { spdx_id: 'MIT' }, description: null }),
  });
  const { tpm } = await boot("set -g @plugin 'dracula/tmux'", { fetchImpl });
  const [meta] = await tpm.fetchMetadata();
  assert.equal(meta.fullName, 'dracula/tmux');
  assert.equal(meta.stars, 7);
  assert.equal(meta.license, 'MIT');
  assert.equal(meta.description, null);
  assert.equal(meta.archived, false);
});
