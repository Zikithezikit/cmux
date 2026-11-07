// @ts-nocheck
// tmux-plugins/tpm: prefix + I (install), U (update), M-u (clean).
// "Installing" fetches plugin metadata from the GitHub API; emulators are built in.

export default {
  repo: 'tmux-plugins/tpm',
  description: 'Plugin manager. Install/update fetch GitHub metadata; plugins themselves are built-in JS emulators.',
  optionPrefixes: ['@tpm'],
  apply(t, api) {
    const tpm = t.plugins;
    api.command({
      name: 'tpm-install', flags: '', async run(tt) {
        tt.ui.message('TPM: fetching plugin metadata from GitHub...');
        await tpm.fetchMetadata();
        tt.ui.showMessages?.('plugins');
        tt.ui.message('TMUX environment reloaded. Plugins are emulated in JS — see the debug panel.');
      },
    });
    api.command({
      name: 'tpm-update', flags: '', async run(tt) {
        tt.ui.message('TPM: refreshing plugin metadata...');
        await tpm.fetchMetadata({ force: true });
        tt.ui.showMessages?.('plugins');
      },
    });
    api.command({
      name: 'tpm-clean', flags: '', async run(tt) {
        await tpm.clearMetadata();
        tt.ui.message('TPM: cleared cached plugin metadata');
      },
    });
    api.bind('prefix', api.option('@tpm-install', 'I'), 'tpm-install', { note: 'TPM: install plugins' });
    api.bind('prefix', api.option('@tpm-update', 'U'), 'tpm-update', { note: 'TPM: update plugins' });
    api.bind('prefix', api.option('@tpm-clean', 'M-u'), 'tpm-clean', { note: 'TPM: clean plugins' });
  },
};
