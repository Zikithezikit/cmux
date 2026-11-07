// tmux-plugins/tmux-resurrect: prefix + C-s saves sessions/windows/panes
// (layouts, split ratios, URLs) to chrome.storage.local; prefix + C-r restores.

import type { KeyValueStorage } from '../../core/types.js';
import type { PluginEmulator, ResurrectSnapshot, TpmHost } from '../tpm.js';

export const LAST_KEY = 'ctmux:resurrect:last';
export const HISTORY_KEY = 'ctmux:resurrect:history';
const HISTORY_MAX = 10;

interface SnapshotOptions {
  quiet?: boolean;
}

interface HistoryEntry {
  savedAt: number;
  sessions: number;
}

export async function saveSnapshot(t: TpmHost, storage: KeyValueStorage, { quiet = false }: SnapshotOptions = {}) {
  const snap = t.server.snapshot();
  await storage.set(LAST_KEY, snap);
  const history: HistoryEntry[] = (await storage.get(HISTORY_KEY)) || [];
  history.unshift({ savedAt: snap.savedAt, sessions: snap.sessions.length });
  await storage.set(HISTORY_KEY, history.slice(0, HISTORY_MAX));
  if (!quiet) t.ui.message('Tmux environment saved!');
  return snap;
}

export async function restoreSnapshot(t: TpmHost, storage: KeyValueStorage, { quiet = false }: SnapshotOptions = {}) {
  const snap: ResurrectSnapshot | undefined = await storage.get(LAST_KEY);
  if (!snap) { if (!quiet) t.ui.message('Tmux resurrect file not found!'); return 0; }
  const n = t.server.restore(snap);
  t.server.changed('restore');
  (t.ui.focusPane as (paneId?: number) => void)?.();
  if (!quiet) t.ui.message(n ? `Tmux restore complete! (${n} session${n === 1 ? '' : 's'})` : 'Nothing to restore: all saved sessions already exist');
  return n;
}

export default {
  repo: 'tmux-plugins/tmux-resurrect',
  description: 'Save/restore sessions, windows, pane layouts, split ratios and URLs (chrome.storage.local).',
  optionPrefixes: ['@resurrect'],
  apply(t, api) {
    api.command({ name: 'resurrect-save', flags: 'q', run: (tt, f) => saveSnapshot(tt, api.storage, { quiet: !!f.q }) });
    api.command({ name: 'resurrect-restore', flags: 'q', run: (tt, f) => restoreSnapshot(tt, api.storage, { quiet: !!f.q }) });
    for (const key of api.option('@resurrect-save', 'C-s').split(/\s+/)) {
      api.bind('prefix', key, 'resurrect-save', { note: 'resurrect: save environment' });
    }
    for (const key of api.option('@resurrect-restore', 'C-r').split(/\s+/)) {
      api.bind('prefix', key, 'resurrect-restore', { note: 'resurrect: restore environment' });
    }
    const ignored = ['@resurrect-processes', '@resurrect-strategy-vim', '@resurrect-strategy-nvim',
      '@resurrect-capture-pane-contents', '@resurrect-dir', '@resurrect-hook-post-save-all'];
    for (const o of ignored) if (t.options[o] != null) api.notice(`${o} has no meaning for web panes (URLs are always restored)`);
  },
} satisfies PluginEmulator;
