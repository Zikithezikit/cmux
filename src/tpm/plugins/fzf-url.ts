// @ts-nocheck
// wfxr/tmux-fzf-url: prefix + u lists every link in the active pane in a
// fuzzy picker and opens the chosen one.

export default {
  repo: 'wfxr/tmux-fzf-url',
  description: 'prefix+u: fuzzy-pick a link from the active pane and open it (new window, split or Chrome tab).',
  optionPrefixes: ['@fzf-url'],
  apply(t, api) {
    api.command({
      name: 'fzf-url', flags: 't:', async run(tt) {
        const pane = tt.server.pane;
        if (!pane || pane.kind !== 'web') { tt.ui.message('No URLs found'); return; }
        const limit = Number(api.option('@fzf-url-history-limit', '2000')) || 2000;
        const links = (await tt.ui.paneCommand?.(pane.id, { type: 'collect-links', limit })) || [];
        if (!links.length) { tt.ui.message('No URLs found'); return; }
        const choice = await tt.ui.pick({
          title: 'fzf-url', fuzzy: true,
          hint: 'Enter: new window · C-v: split right · C-s: split below · C-t: Chrome tab',
          items: links.map((l) => ({ label: l.text && l.text !== l.url ? `${l.url}  ${l.text}` : l.url, value: l.url })),
        });
        if (!choice) return;
        const url = typeof choice === 'object' ? choice.value : choice;
        const how = (typeof choice === 'object' && choice.key) || api.option('@fzf-url-open', 'window');
        if (how === 'C-t' || /tab|chrome|xdg-open|open/.test(how)) tt.ui.openTab?.(url);
        else if (how === 'C-v') await tt.runString(`split-window -h '${url.replace(/'/g, '%27')}'`);
        else if (how === 'C-s') await tt.runString(`split-window -v '${url.replace(/'/g, '%27')}'`);
        else await tt.runString(`new-window '${url.replace(/'/g, '%27')}'`);
      },
    });
    api.bind('prefix', api.option('@fzf-url-bind', 'u'), 'fzf-url', { note: 'fzf-url: pick a link' });
  },
};
