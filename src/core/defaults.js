// Built-in option values and key bindings, mirroring tmux 3.4 defaults.

export const DEFAULT_OPTIONS = {
  // server / session
  prefix: 'C-b',
  prefix2: 'None',
  'base-index': '0',
  'renumber-windows': 'off',
  mouse: 'off',
  'status-keys': 'emacs',
  'repeat-time': '500',
  'escape-time': '500',
  'history-limit': '2000',
  'display-time': '750',
  'display-panes-time': '1000',
  'display-panes-colour': 'blue',
  'display-panes-active-colour': 'red',
  'default-command': '',
  'default-terminal': 'tmux-256color',
  'set-titles': 'off',
  'set-titles-string': '#S:#I:#W - "#T" #{session_alerts}',
  'focus-events': 'off',
  'detach-on-destroy': 'on',

  // status line
  status: 'on',
  'status-position': 'bottom',
  'status-justify': 'left',
  'status-interval': '15',
  'status-style': 'bg=green,fg=black',
  'status-left': '[#{session_name}] ',
  'status-left-length': '10',
  'status-left-style': 'default',
  'status-right': '#{?window_bigger,[#{window_offset_x}#,#{window_offset_y}] ,}"#{=21:pane_title}" %H:%M %d-%b-%y',
  'status-right-length': '40',
  'status-right-style': 'default',
  'message-style': 'bg=yellow,fg=black',
  'message-command-style': 'bg=black,fg=yellow',

  // window
  'pane-base-index': '0',
  'mode-keys': 'emacs',
  'mode-style': 'bg=yellow,fg=black',
  'automatic-rename': 'on',
  'allow-rename': 'off',
  'aggressive-resize': 'off',
  'window-status-format': '#I:#W#{?window_flags,#{window_flags}, }',
  'window-status-current-format': '#I:#W#{?window_flags,#{window_flags}, }',
  'window-status-separator': ' ',
  'window-status-style': 'default',
  'window-status-current-style': 'default',
  'window-status-last-style': 'default',
  'window-status-activity-style': 'reverse',
  'window-status-bell-style': 'reverse',
  'pane-border-style': 'default',
  'pane-active-border-style': 'fg=green',
  'pane-border-status': 'off',
  'pane-border-format': '#{?pane_active,#[reverse],}#{pane_index}#[default] "#{pane_title}"',
  'pane-border-lines': 'single',
  'main-pane-width': '80',
  'main-pane-height': '24',
  'clock-mode-colour': 'blue',
  'clock-mode-style': '24',
  'window-style': 'default',
  'window-active-style': 'default',

  // chrome-tmux specific (user options so tmux itself ignores them)
  '@ctmux-search-url': 'https://duckduckgo.com/?q=%s',
  '@ctmux-font-family': '"JetBrainsMono Nerd Font", "JetBrains Mono", "Fira Code", "DejaVu Sans Mono", Menlo, monospace',
  '@ctmux-font-size': '13',
  '@ctmux-background': '#121212',
  '@ctmux-foreground': '#d0d0d0',
  '@ctmux-launcher-motd': 'on',

  // Array options (tmux 3.4 defaults).
  'command-alias[0]': 'split-pane=split-window',
  'command-alias[1]': 'splitp=split-window',
  'command-alias[2]': 'server-info=show-messages -JT',
  'command-alias[3]': 'info=show-messages -JT',
  'command-alias[4]': 'choose-window=choose-tree -w',
  'command-alias[5]': 'choose-session=choose-tree -s',
};

/**
 * Array options (`name[N]`) and the separator tmux uses to split a value set
 * without an index (null: the whole value is one element).
 */
export const ARRAY_OPTIONS = {
  'command-alias': ',', 'terminal-overrides': ',', 'terminal-features': ',', 'update-environment': ' ',
  'status-format': null, 'user-keys': ',', 'pane-colours': ' ',
};

/** Hooks this implementation fires (besides after-<command>). */
export const EVENT_HOOKS = new Set([
  'client-attached', 'client-detached', 'client-session-changed', 'client-focus-in', 'client-focus-out',
  'session-created', 'session-closed', 'session-renamed', 'session-window-changed',
  'window-linked', 'window-unlinked', 'window-renamed', 'window-layout-changed', 'window-pane-changed',
  'pane-focus-in', 'pane-focus-out', 'pane-mode-changed', 'pane-title-changed',
]);

/** Hooks tmux has but that never fire here (no processes, alerts or resizes). */
export const KNOWN_UNFIRED_HOOKS = new Set([
  'alert-activity', 'alert-bell', 'alert-silence', 'client-resized', 'client-active', 'client-light-theme',
  'client-dark-theme', 'command-error', 'pane-died', 'pane-exited', 'pane-set-clipboard', 'session-closed-all',
]);

/** Options whose values are on/off flags. */
export const FLAG_OPTIONS = new Set([
  'mouse', 'renumber-windows', 'set-titles', 'focus-events', 'status', 'automatic-rename',
  'allow-rename', 'aggressive-resize', 'detach-on-destroy', '@ctmux-launcher-motd',
]);

/** Options this implementation renders/acts on; anything else is stored but noted as inert. */
export const ACTIVE_OPTIONS = new Set(Object.keys(DEFAULT_OPTIONS).filter((k) => ![
  'escape-time', 'history-limit', 'default-terminal', 'focus-events', 'aggressive-resize',
  'detach-on-destroy', 'window-status-activity-style', 'window-status-bell-style',
  'pane-border-lines', 'window-style', 'window-active-style',
].includes(k)));

/**
 * tmux's default key bindings (key-bindings.c), expressed as configuration so
 * they go through the same parser as the user's file. Bindings that only
 * make sense for a terminal are omitted.
 */
export const DEFAULT_BINDINGS = String.raw`
bind -N 'Send the prefix key' C-b send-prefix
bind -N 'Rotate through the panes' C-o rotate-window
bind -N 'Select next layout' Space next-layout
bind -N 'Break pane to a new window' ! break-pane
bind -N 'Split window vertically' '"' split-window
bind -N 'List all paste buffers' '#' list-buffers
bind -N 'Rename current session' '$' command-prompt -I "#S" { rename-session -- '%%' }
bind -N 'Split window horizontally' % split-window -h
bind -N 'Kill current window' & confirm-before -p "kill-window #W? (y/n)" kill-window
bind -N 'Prompt for window index to select' "'" command-prompt -T window-target -p index { select-window -t ':%%' }
bind -N 'Switch to previous client' ( switch-client -p
bind -N 'Switch to next client' ) switch-client -n
bind -N 'Rename current window' , command-prompt -I "#W" { rename-window -- '%%' }
bind -N 'Delete the most recent paste buffer' - delete-buffer
bind -N 'Move the current window' . command-prompt -T target { move-window -t '%%' }
bind -N 'Select window 0' 0 select-window -t :=0
bind -N 'Select window 1' 1 select-window -t :=1
bind -N 'Select window 2' 2 select-window -t :=2
bind -N 'Select window 3' 3 select-window -t :=3
bind -N 'Select window 4' 4 select-window -t :=4
bind -N 'Select window 5' 5 select-window -t :=5
bind -N 'Select window 6' 6 select-window -t :=6
bind -N 'Select window 7' 7 select-window -t :=7
bind -N 'Select window 8' 8 select-window -t :=8
bind -N 'Select window 9' 9 select-window -t :=9
bind -N 'Prompt for a command' : command-prompt
bind -N 'Move to the previously active pane' \; last-pane
bind -N 'Choose a paste buffer from a list' = choose-buffer -Z
bind -N 'List key bindings' ? list-keys -N
bind -N 'Switch to the last client' L switch-client -l
bind -N 'Enter copy mode' [ copy-mode
bind -N 'Paste the most recent paste buffer' ] paste-buffer -p
bind -N 'Create a new window' c new-window
bind -N 'Detach the current client' d detach-client
bind -N 'Search for a pane' f command-prompt { find-window -Z -- '%%' }
bind -N 'Display window information' i display-message
bind -N 'Select the previously current window' l last-window
bind -N 'Select the next window' n next-window
bind -N 'Select the next pane' o select-pane -t :.+
bind -N 'Select the previous window' p previous-window
bind -N 'Display pane numbers' q display-panes
bind -N 'Redraw the current client' r refresh-client
bind -N 'Choose a session from a list' s choose-tree -Zs
bind -N 'Show a clock' t clock-mode
bind -N 'Choose a window from a list' w choose-tree -Zw
bind -N 'Kill the active pane' x confirm-before -p "kill-pane #P? (y/n)" kill-pane
bind -N 'Zoom the active pane' z resize-pane -Z
bind -N 'Swap the active pane with the pane above' '{' swap-pane -U
bind -N 'Swap the active pane with the pane below' '}' swap-pane -D
bind -N 'Show messages' '~' show-messages
bind -N 'Toggle the marked pane' m select-pane -m
bind -N 'Clear the marked pane' M select-pane -M
bind -N 'Spread panes out evenly' E select-layout -E
bind -N 'Display window menu' < display-menu -T "#[align=centre]#{window_index}:#{window_name}" -x W -y W "Swap Left" l { swap-window -t:-1 } "Swap Right" r { swap-window -t:+1 } "#{?pane_marked_set,,-}Swap Marked" s { swap-window } '' Kill X { kill-window } Respawn R { respawn-window -k } "#{?pane_marked,Unmark,Mark}" m { select-pane -m } Rename n { command-prompt -FI "#W" { rename-window -t '#{window_id}' -- '%%' } } '' "New After" w { new-window -a } "New At End" W { new-window }
bind -N 'Display pane menu' > display-menu -T "#[align=centre]#{pane_index} (#{pane_id})" -x P -y P "Horizontal Split" h { split-window -h } "Vertical Split" v { split-window -v } '' "#{?#{>:#{window_panes},1},,-}Swap Up" u { swap-pane -U } "#{?#{>:#{window_panes},1},,-}Swap Down" d { swap-pane -D } "#{?pane_marked_set,,-}Swap Marked" s { swap-pane } '' Kill X { kill-pane } Respawn R { respawn-pane -k } "#{?pane_marked,Unmark,Mark}" m { select-pane -m } "#{?#{>:#{window_panes},1},,-}#{?window_zoomed_flag,Unzoom,Zoom}" z { resize-pane -Z }
bind -N 'Enter copy mode and scroll up' PPage copy-mode -u
bind -N 'Select the pane above the active pane' -r Up select-pane -U
bind -N 'Select the pane below the active pane' -r Down select-pane -D
bind -N 'Select the pane to the left of the active pane' -r Left select-pane -L
bind -N 'Select the pane to the right of the active pane' -r Right select-pane -R
bind -N 'Set the even-horizontal layout' M-1 select-layout even-horizontal
bind -N 'Set the even-vertical layout' M-2 select-layout even-vertical
bind -N 'Set the main-horizontal layout' M-3 select-layout main-horizontal
bind -N 'Set the main-vertical layout' M-4 select-layout main-vertical
bind -N 'Select the tiled layout' M-5 select-layout tiled
bind -N 'Select the next window with an alert' M-n next-window -a
bind -N 'Rotate through the panes in reverse' M-o rotate-window -D
bind -N 'Select the previous window with an alert' M-p previous-window -a
bind -N 'Resize the pane up by 5' -r M-Up resize-pane -U 5
bind -N 'Resize the pane down by 5' -r M-Down resize-pane -D 5
bind -N 'Resize the pane left by 5' -r M-Left resize-pane -L 5
bind -N 'Resize the pane right by 5' -r M-Right resize-pane -R 5
bind -N 'Resize the pane up' -r C-Up resize-pane -U
bind -N 'Resize the pane down' -r C-Down resize-pane -D
bind -N 'Resize the pane left' -r C-Left resize-pane -L
bind -N 'Resize the pane right' -r C-Right resize-pane -R
bind -N 'Open a URL in the active pane' g command-prompt -p "url:" -I "#{pane_current_path}" { goto '%%' }
bind -N 'Go back in the active pane' B back
bind -N 'Open the active pane in a real Chrome tab' T open-in-tab
`;

/**
 * Copy-mode tables. The pane agent implements the `send-keys -X` commands
 * with the DOM Selection API (Selection.modify), so these stay configurable.
 */
export const DEFAULT_COPY_BINDINGS = String.raw`
bind -T copy-mode-vi q send -X cancel
bind -T copy-mode-vi C-c send -X cancel
bind -T copy-mode-vi Escape send -X clear-selection
bind -T copy-mode-vi h send -X cursor-left
bind -T copy-mode-vi j send -X cursor-down
bind -T copy-mode-vi k send -X cursor-up
bind -T copy-mode-vi l send -X cursor-right
bind -T copy-mode-vi Left send -X cursor-left
bind -T copy-mode-vi Down send -X cursor-down
bind -T copy-mode-vi Up send -X cursor-up
bind -T copy-mode-vi Right send -X cursor-right
bind -T copy-mode-vi w send -X next-word
bind -T copy-mode-vi W send -X next-space
bind -T copy-mode-vi b send -X previous-word
bind -T copy-mode-vi B send -X previous-space
bind -T copy-mode-vi e send -X next-word-end
bind -T copy-mode-vi 0 send -X start-of-line
bind -T copy-mode-vi ^ send -X back-to-indentation
bind -T copy-mode-vi '$' send -X end-of-line
bind -T copy-mode-vi H send -X top-line
bind -T copy-mode-vi M send -X middle-line
bind -T copy-mode-vi L send -X bottom-line
bind -T copy-mode-vi g send -X history-top
bind -T copy-mode-vi G send -X history-bottom
bind -T copy-mode-vi C-e send -X scroll-down
bind -T copy-mode-vi C-y send -X scroll-up
bind -T copy-mode-vi J send -X scroll-down
bind -T copy-mode-vi K send -X scroll-up
bind -T copy-mode-vi C-d send -X halfpage-down
bind -T copy-mode-vi C-u send -X halfpage-up
bind -T copy-mode-vi C-f send -X page-down
bind -T copy-mode-vi C-b send -X page-up
bind -T copy-mode-vi NPage send -X page-down
bind -T copy-mode-vi PPage send -X page-up
bind -T copy-mode-vi / command-prompt -T search -p "(search down)" { send -X search-forward '%%' }
bind -T copy-mode-vi ? command-prompt -T search -p "(search up)" { send -X search-backward '%%' }
bind -T copy-mode-vi n send -X search-again
bind -T copy-mode-vi N send -X search-reverse
bind -T copy-mode-vi Space send -X begin-selection
bind -T copy-mode-vi v send -X rectangle-toggle
bind -T copy-mode-vi V send -X select-line
bind -T copy-mode-vi o send -X other-end
bind -T copy-mode-vi Enter send -X copy-pipe-and-cancel
bind -T copy-mode-vi A send -X append-selection-and-cancel
bind -T copy-mode-vi D send -X copy-pipe-end-of-line-and-cancel

bind -T copy-mode q send -X cancel
bind -T copy-mode Escape send -X cancel
bind -T copy-mode C-g send -X clear-selection
bind -T copy-mode C-c send -X cancel
bind -T copy-mode C-b send -X cursor-left
bind -T copy-mode C-f send -X cursor-right
bind -T copy-mode C-n send -X cursor-down
bind -T copy-mode C-p send -X cursor-up
bind -T copy-mode Left send -X cursor-left
bind -T copy-mode Right send -X cursor-right
bind -T copy-mode Down send -X cursor-down
bind -T copy-mode Up send -X cursor-up
bind -T copy-mode M-f send -X next-word-end
bind -T copy-mode M-b send -X previous-word
bind -T copy-mode C-a send -X start-of-line
bind -T copy-mode C-e send -X end-of-line
bind -T copy-mode M-m send -X back-to-indentation
bind -T copy-mode C-v send -X page-down
bind -T copy-mode M-v send -X page-up
bind -T copy-mode NPage send -X page-down
bind -T copy-mode PPage send -X page-up
bind -T copy-mode M-< send -X history-top
bind -T copy-mode M-> send -X history-bottom
bind -T copy-mode C-Up send -X scroll-up
bind -T copy-mode C-Down send -X scroll-down
bind -T copy-mode C-s command-prompt -T search -p "(search down)" { send -X search-forward '%%' }
bind -T copy-mode C-r command-prompt -T search -p "(search up)" { send -X search-backward '%%' }
bind -T copy-mode n send -X search-again
bind -T copy-mode N send -X search-reverse
bind -T copy-mode C-Space send -X begin-selection
bind -T copy-mode M-w send -X copy-pipe-and-cancel
bind -T copy-mode C-w send -X copy-pipe-and-cancel
`;
