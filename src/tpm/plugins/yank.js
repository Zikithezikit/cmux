// tmux-plugins/tmux-yank: copy-mode `y` copies the selection to the system
// clipboard (navigator.clipboard), mouse selections are copied when mouse is
// on, prefix + y copies the pane URL and prefix + Y a Markdown link.

export default {
  repo: 'tmux-plugins/tmux-yank',
  description: 'Copy selections in panes to the system clipboard; prefix+y copies the URL, prefix+Y a Markdown link.',
  optionPrefixes: ['@yank', '@copy_mode', '@shell_mode', '@override_copy_command', '@custom_copy_command'],
  apply(t, api) {
    const action = api.option('@yank_action', 'copy-pipe-and-cancel');
    const yankKey = api.option('@copy_mode_yank', 'y');
    const putKey = api.option('@copy_mode_put', 'Y');
    const yankPutKey = api.option('@copy_mode_yank_put', 'M-y');
    for (const table of ['copy-mode-vi', 'copy-mode']) {
      api.bind(table, yankKey, `send-keys -X ${action}`, { note: 'yank: copy selection' });
      api.bind(table, putKey, 'send-keys -X copy-selection-and-paste', { note: 'yank: copy and paste' });
      api.bind(table, yankPutKey, 'send-keys -X copy-selection-and-paste', { note: 'yank: copy and paste' });
    }
    api.command({
      name: 'yank-pane', flags: 'mt:', run(tt, f) {
        const p = tt.server.pane;
        if (!p || p.kind !== 'web') { tt.ui.message('Nothing to yank'); return; }
        const text = f.m ? `[${p.title || p.url}](${p.url})` : p.url;
        tt.buffers.unshift({ name: `buffer${String(tt.buffers.length).padStart(4, '0')}`, data: text, time: Date.now() });
        tt.ui.writeClipboard?.(text);
        tt.ui.message(`Copied: ${text.length > 60 ? text.slice(0, 57) + '...' : text}`);
      },
    });
    api.bind('prefix', api.option('@yank_line', 'y'), 'yank-pane', { note: 'yank: copy pane URL' });
    api.bind('prefix', api.option('@yank_pane_pwd', 'Y'), 'yank-pane -m', { note: 'yank: copy Markdown link' });
  },
};
