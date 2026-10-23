// tmux-plugins/tmux-sensible: defaults "everyone can agree on".
// Like the original it never overrides options the user set explicitly.

export default {
  repo: 'tmux-plugins/tmux-sensible',
  description: 'Sensible option defaults, C-p/C-n window cycling, prefix-repeat and R to reload.',
  optionPrefixes: [],
  apply(t, api) {
    api.setDefault('escape-time', '0');
    api.setDefault('history-limit', '50000');
    api.setDefault('display-time', '4000');
    api.setDefault('status-interval', '5');
    api.setDefault('status-keys', 'emacs');
    api.setDefault('focus-events', 'on');
    api.setDefault('aggressive-resize', 'on');

    api.bind('prefix', 'C-p', 'previous-window', { note: 'sensible: previous window' });
    api.bind('prefix', 'C-n', 'next-window', { note: 'sensible: next window' });
    api.bind('prefix', 'R', 'source-file ~/.tmux.conf \\; display-message "~/.tmux.conf sourced"', { note: 'sensible: reload config' });

    // Pressing the prefix letter (without Ctrl) after the prefix sends the
    // prefix; pressing the prefix twice switches to the last window.
    const prefix = t.getOption('prefix');
    const m = /^C-([a-z])$/.exec(prefix);
    if (m && prefix !== 'C-b') {
      if (!t.lookupKey('prefix', m[1])) api.bind('prefix', m[1], 'send-prefix', { note: 'sensible: send prefix' });
      if (!t.lookupKey('prefix', prefix)) api.bind('prefix', prefix, 'last-window', { note: 'sensible: last window' });
    }
  },
};
