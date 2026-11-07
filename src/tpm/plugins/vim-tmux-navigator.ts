// @ts-nocheck
// christoomey/vim-tmux-navigator: Ctrl-h/j/k/l (no prefix) move between panes.
// Web pages are never vim, so the "is_vim" check always falls through to select-pane.

export default {
  repo: 'christoomey/vim-tmux-navigator',
  description: 'C-h/C-j/C-k/C-l/C-\\ move between panes without the prefix (also in copy mode).',
  optionPrefixes: ['@vim_navigator'],
  apply(t, api) {
    const maps = [
      ['@vim_navigator_mapping_left', 'C-h', 'select-pane -L'],
      ['@vim_navigator_mapping_down', 'C-j', 'select-pane -D'],
      ['@vim_navigator_mapping_up', 'C-k', 'select-pane -U'],
      ['@vim_navigator_mapping_right', 'C-l', 'select-pane -R'],
      ['@vim_navigator_mapping_prev', 'C-\\', 'select-pane -l'],
    ];
    for (const [opt, def, cmd] of maps) {
      for (const key of api.option(opt, def).split(/\s+/).filter(Boolean)) {
        api.bind('root', key, cmd, { note: `vim-tmux-navigator: ${cmd}` });
        api.bind('copy-mode-vi', key, cmd, { note: `vim-tmux-navigator: ${cmd}` });
      }
    }
    const clear = api.option('@vim_navigator_prefix_mapping_clear_screen', 'C-l');
    if (clear) api.bind('prefix', clear, 'send-keys C-l', { note: 'vim-tmux-navigator: clear screen' });
  },
};
