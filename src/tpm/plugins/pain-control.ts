// @ts-nocheck
// tmux-plugins/tmux-pain-control: h/j/k/l navigation, H/J/K/L resizing,
// | - \ _ splits and < > window swapping.

export default {
  repo: 'tmux-plugins/tmux-pain-control',
  description: 'Pane navigation (h/j/k/l), resizing (H/J/K/L), splitting (| - \\ _) and window swapping (< >).',
  optionPrefixes: ['@pane_resize', '@disable_deprecated_nav_bindings'],
  apply(t, api) {
    const step = api.option('@pane_resize', '5');
    const nav = { h: 'L', j: 'D', k: 'U', l: 'R' };
    for (const [key, dir] of Object.entries(nav)) {
      api.bind('prefix', key, `select-pane -${dir}`, { note: `pain-control: select pane ${dir}` });
      api.bind('prefix', `C-${key}`, `select-pane -${dir}`, { note: `pain-control: select pane ${dir}` });
      api.bind('prefix', key.toUpperCase(), `resize-pane -${dir} ${step}`, { repeat: true, note: `pain-control: resize ${dir}` });
    }
    const path = '-c "#{pane_current_path}"';
    api.bind('prefix', '|', `split-window -h ${path}`, { note: 'pain-control: split right' });
    api.bind('prefix', '\\', `split-window -fh ${path}`, { note: 'pain-control: full-height split' });
    api.bind('prefix', '-', `split-window -v ${path}`, { note: 'pain-control: split down' });
    api.bind('prefix', '_', `split-window -fv ${path}`, { note: 'pain-control: full-width split' });
    api.bind('prefix', '%', `split-window -h ${path}`, { note: 'pain-control: split right' });
    api.bind('prefix', '"', `split-window -v ${path}`, { note: 'pain-control: split down' });
    api.bind('prefix', '<', 'swap-window -t -1 \\; select-window -t -1', { repeat: true, note: 'pain-control: move window left' });
    api.bind('prefix', '>', 'swap-window -t +1 \\; select-window -t +1', { repeat: true, note: 'pain-control: move window right' });
    api.bind('prefix', 'c', `new-window ${path}`, { note: 'pain-control: new window' });
  },
};
