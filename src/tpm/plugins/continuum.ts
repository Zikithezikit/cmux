// @ts-nocheck
// tmux-plugins/tmux-continuum: periodic automatic resurrect saves and
// automatic restore when the workspace starts with no live state.

import { saveSnapshot, restoreSnapshot, LAST_KEY } from './resurrect.js';

export default {
  repo: 'tmux-plugins/tmux-continuum',
  description: 'Automatic resurrect save every @continuum-save-interval minutes; @continuum-restore on restores at start.',
  optionPrefixes: ['@continuum'],
  apply(t, api) {
    if (!t.plugins.declared.has('tmux-plugins/tmux-resurrect')) {
      api.notice('requires tmux-plugins/tmux-resurrect; saving with the built-in resurrect logic anyway', 'warn');
    }
    const minutes = Number(api.option('@continuum-save-interval', '15'));
    let lastSave = null;
    if (minutes > 0) {
      api.every(minutes * 60 * 1000, async () => {
        await saveSnapshot(t, api.storage, { quiet: true });
        lastSave = Date.now();
        api.refresh();
      });
    }
    api.formatVar('continuum_status', () => (minutes > 0 ? String(minutes) : 'off'));
    api.formatVar('continuum_last_save', () => (lastSave ? new Date(lastSave).toLocaleTimeString() : ''));

    if (api.option('@continuum-restore', 'off') === 'on') {
      api.onStartup(async ({ hadLiveState }) => {
        if (hadLiveState) return;
        if (await api.storage.get(LAST_KEY)) await restoreSnapshot(t, api.storage, { quiet: true });
      });
    }
    if (t.options['@continuum-boot'] === 'on') {
      api.notice('@continuum-boot: start Chrome with --app=<workspace URL> from your session autostart instead');
    }
  },
};
