# chrome-tmux

tmux inside Chrome. A Manifest V3 extension that turns a tab (or a chromeless
`--app` window) into a tmux client. Panes hold web pages, and you get windows,
sessions, a status line, copy mode and modal key bindings. It is configured by
your real `~/.tmux.conf`, including TPM plugins.

![chrome-tmux running a real ~/.tmux.conf: Dracula status line on top, Wikipedia, Hacker News and GitHub in three panes](docs/screenshots/workspace.png)

*A real `~/.tmux.conf` (prefix `C-s`, Dracula theme, status line on top) driving three
panes. Window list on the left, the Dracula weather widget on the right.*

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
2. The options page opens. Load your config, either by path (recommended) or by upload or paste.
   For the path option, enable **Allow access to file URLs** on the extension's details page
   and enter an absolute path such as `/home/you/.tmux.conf`. The file is then re-read on every
   start and on `source-file ~/.tmux.conf`, like real tmux.

   <details><summary>Options page: the config is parsed and checked before you use it</summary>

   ![Options page with a loaded tmux.conf and its parse report](docs/screenshots/options.png)
   </details>

3. Click the toolbar icon (or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>) to open the workspace.
   For a terminal-like window with no tab strip or address bar:

   ```sh
   google-chrome --app=chrome-extension://<extension-id>/src/workspace/workspace.html
   ```

   The options page shows the exact command with your extension ID filled in.

A new pane starts as a prompt: type a URL, search terms, or `:command` for any tmux command.

## What works

| Area | Supported |
|---|---|
| Config syntax | quoting rules, `\` continuations, `;` and `\;`, `{ }` blocks, `NAME=value` and `$NAME`/`${NAME}`, `%if/%elif/%else/%endif`, `%hidden`, `source-file`, deprecated `*-fg/-bg/-attr` options |
| Keys | `prefix`/`prefix2`, prefix/root/custom tables (`bind -n`, `-T`, `switch-client -T`), repeat (`-r`, `repeat-time`), `unbind [-a]` |
| Panes | `split-window [-h/-v/-b/-f/-l/-p/-c]`, `select-pane -L/R/U/D/-l/-t`, `resize-pane` (keys, `-x/-y`, `-Z` zoom, mouse-drag borders), `swap-pane`, `rotate-window`, `break-pane`, `join-pane`, `kill-pane`, `display-panes`, `pane-border-status` |
| Windows | `new-window`, `select-window`, `next/previous/last-window`, `rename-window`, `swap-window`, `move-window`, `kill-window`, `base-index`, `renumber-windows`, `automatic-rename` (uses the site hostname) |
| Layouts | `even-horizontal`, `even-vertical`, `main-horizontal`, `main-vertical`, `tiled`, `next-layout`, `select-layout -E/-o` |
| Sessions | `new-session`, `rename-session`, `switch-client -n/-p/-l/-t`, `kill-session`, `detach-client`; `prefix s` / `prefix w` (choose-tree) is a session manager: `Enter` switch, `(0)`–`(9)` shortcuts, `n` new session, `c` new window, `$` / `,` rename session/window, `x` kill, `h/l` fold, `/` filter |
| Status line | `status-left/right` (with `-length`/`-style`), `window-status-*format/style`, `status-justify`, `status-position`, `status-interval`, `message-style`, full `#{}` format language, `#[]` styles, 256/hex colours, strftime. Powerline glyphs are drawn with CSS, so no patched font is needed |
| Modes | `command-prompt` (`-p/-I/-1`, history, Tab completion), `confirm-before`, `display-message`, `list-keys [-N]`, `show-options`, `show-messages`, `clock-mode`, `choose-buffer`, `find-window` |
| Copy mode | `copy-mode-vi` / `copy-mode` tables from your config. The page caret is the cursor, moved with the DOM Selection API (`h j k l w b e 0 $ g G H M L C-u C-d …`), with `/ ? n N` search, `Space`/`V` selection and `Enter`/`y` to copy to the clipboard and a paste buffer |
| Web | `goto`/`open <url>`, `back`, `forward`, `reload`, `open-in-tab`, `paste-buffer`, `send-keys` (text) |

Extra default bindings, for things a browser needs: `prefix g` opens a URL in the pane,
`prefix B` goes back, `prefix T` opens the pane in a real Chrome tab.

State lives in `chrome.storage.session`, like a tmux server: it survives reloading
the workspace but not restarting Chrome. Use resurrect/continuum to persist across restarts.

### A quick tour

<table>
<tr>
<td width="50%"><a href="docs/screenshots/sessions.png"><img src="docs/screenshots/sessions.png" alt="Session manager"></a><br>
<b>Session manager</b> (<code>prefix s</code>): switch, create (<code>n</code>), rename (<code>$</code>), kill (<code>x</code>).</td>
<td width="50%"><a href="docs/screenshots/copy-mode.png"><img src="docs/screenshots/copy-mode.png" alt="Copy mode"></a><br>
<b>Copy mode</b> (<code>prefix [</code>): vi keys, <code>/</code> search and a selection in a live page; <code>Enter</code> copies it.</td>
</tr>
<tr>
<td><a href="docs/screenshots/fzf-url.png"><img src="docs/screenshots/fzf-url.png" alt="fzf-url link picker"></a><br>
<b>tmux-fzf-url</b> (<code>prefix u</code>): every link on the page in a fuzzy picker.</td>
<td><a href="docs/screenshots/plugins.png"><img src="docs/screenshots/plugins.png" alt="TPM plugins in the debug panel"></a><br>
<b>TPM emulation</b> (<code>prefix ~</code>): which plugins are emulated, their options, GitHub metadata.</td>
</tr>
</table>

## TPM plugins

TPM plugins are shell scripts, which a browser can't run. Instead, `set -g @plugin '…'`
lines are collected, and `run '~/.tmux/plugins/tpm/tpm'` applies built-in JS emulators.
If the `run` line is missing, they are applied at the end of the config. `prefix I` / `U`
fetch each plugin's metadata from the GitHub API (cached for 24h) for the debug panel.

| Plugin | Emulation |
|---|---|
| `tmux-plugins/tpm` | `prefix I/U/M-u`: install/update/clean = fetch or clear GitHub metadata |
| `tmux-plugins/tmux-sensible` | option defaults (never overriding yours), `C-p`/`C-n`, `R` reload, prefix-letter `send-prefix` |
| `tmux-plugins/tmux-resurrect` | `prefix C-s`/`C-r` save/restore sessions, windows, layouts, split ratios and URLs in `chrome.storage.local` |
| `tmux-plugins/tmux-continuum` | auto-save every `@continuum-save-interval` minutes, `@continuum-restore 'on'`, `#{continuum_status}` |
| `tmux-plugins/tmux-yank` | `y` in copy mode copies to the system clipboard; mouse selections are copied when `mouse on`; `prefix y` copies the URL, `prefix Y` a Markdown link |
| `tmux-plugins/tmux-pain-control` | `h j k l`, `H J K L` (repeatable resize), `\| - \\ _` splits, `< >` window moves |
| `christoomey/vim-tmux-navigator` | `C-h/j/k/l/\` without the prefix (web pages are never vim, so these always move panes) |
| `dracula/tmux` | full theme from `dracula.sh`: powerline, flags, left icon, colours; `time`, `weather` (wttr.in), `battery`, `network` widgets |
| `wfxr/tmux-fzf-url` | `prefix u`: fuzzy-pick any link or URL on the page, then open it in a new window, a split (`C-v`/`C-s`) or a Chrome tab (`C-t`) |
| `tmux-plugins/tmux-prefix-highlight` | `#{prefix_highlight}` |
| `tmux-plugins/tmux-battery` | `#{battery_percentage}`, `#{battery_icon}`, `#{battery_status}`, `#{battery_remain}` |
| `tmux-plugins/tmux-online-status` | `#{online_status}` |

Unknown plugins are listed in the debug panel (`prefix ~`, Plugins tab) together with
the `@options` they would have used. So are config lines that need a shell:
`#()`, `run-shell`, and `if-shell` (which is evaluated as false, so the else-branch runs;
`if -F` works).

## How it works

```
manifest.json
src/
  background/service-worker.js   DNR session rule: strip X-Frame-Options + CSP on sub_frame
                                 responses, scoped (tabIds) to workspace tabs only
  content/pane-agent.js          runs in pane iframes: key routing, URL/title reports,
                                 copy mode (Selection API), paste, link collection
  shared/keys.js                 tmux key names + key-table router (shared by page and agent)
  shared/config-source.js        tmux.conf from a file:// path or stored text
  core/                          UI-independent engine (unit-tested in Node)
    parser.js                    tmux config/command tokenizer, getopt
    format.js                    #{formats}, #[styles], colours, strftime
    layout.js                    split tree: geometry, navigation, resize, preset layouts
    server.js                    sessions → windows → panes, snapshots
    target.js                    -t target resolution (session:window.pane, %id, {last}, …)
    commands.js                  74 tmux commands (+ aliases)
    defaults.js                  tmux 3.4 default options and key tables
    tmux.js                      engine: options, key tables, sourcing, dispatch
  tpm/tpm.js, tpm/plugins/*      TPM emulation layer + plugin emulators
  workspace/                     the tmux "client" page: status line, panes, overlays
  options/                       config loader + parse report
tests/                           unit tests (node --test, incl. a real-world tmux.conf) + e2e/smoke.mjs
tools/                           icon generator, packaging
```

Key routing: pressing the prefix inside a web page is caught by the pane agent at
`keydown` (capture phase, `document_start`). The agent mirrors the key tables
(published to `chrome.storage.local`), so it knows which keys to swallow synchronously.
It then sends `{table, key}` to the workspace with `chrome.runtime.sendMessage`. Page
scripts can't forge these messages. Iframes are never moved in the DOM, so switching
windows or layouts doesn't reload pages.

## Limitations

- **Reserved browser shortcuts.** Chrome doesn't let pages intercept <kbd>Ctrl</kbd>+<kbd>T</kbd>/<kbd>W</kbd>/<kbd>N</kbd>/<kbd>Tab</kbd>, so those can't be tmux keys. App mode (`--app`) frees up a few more.
- **Some sites won't work in a frame** even with the headers stripped: Google sign-in, sites that detect framing in JavaScript, and pages whose cookies Chrome treats as third-party (you may look logged out). `prefix T` opens the pane in a normal tab.
- **Pages without the agent** (Chrome error pages, the PDF viewer, `chrome://` URLs, which can't be framed at all) don't see the prefix while focused. Click the status line to give keys back to the workspace.
- **Copy mode** uses the page's text layout: no rectangle selection, and `cursor-up/down` follow rendered lines.
- **Security trade-off.** Inside workspace tabs, the framed pages lose their `Content-Security-Policy` and `X-Frame-Options` headers. Normal browsing is unaffected, because the rule is scoped to workspace tab IDs.
- **No New Tab override by default**, to avoid taking over every new tab. To get one, add `"chrome_url_overrides": { "newtab": "src/workspace/workspace.html" }` to `manifest.json`.

## Development

`make` lists every task. The main ones:

| Command | What it does |
|---|---|
| `make run` | Launches Chromium with the extension loaded (separate dev profile) and opens the options page and workspace |
| `make app` | Opens the workspace as a chromeless `--app` window in your everyday Chrome (extension loaded there via *Load unpacked*) |
| `make check` | Lint, unit tests and the browser test |
| `make test` / `make e2e` / `make lint` | Each of those on its own |
| `make package` | Builds `dist/chrome-tmux-<version>.zip` |
| `make info` | Prints the extension ID, workspace URL and the browsers found |
| `make screenshots` | Regenerates the README images in `docs/screenshots/` (needs network: it loads real sites) |

The extension ID of an unpacked extension is derived from its folder path, so the
Makefile computes the workspace URL itself. Override the browsers with
`make run CHROMIUM=…` or `make app CHROME=…`.

`make app` finds the Chrome profile that has chrome-tmux installed and opens the
workspace there. If none does, it prints the one-time *Load unpacked* steps.
On Ubuntu 23.10+, AppArmor blocks the sandbox of Playwright's Chromium, so `make run`
starts its throwaway dev profile with `--no-sandbox` (pass `RUN_FLAGS=` to disable).
Use that profile only for development, not everyday browsing.

The same tasks as npm scripts:

```sh
npm install         # only needed for the browser test (playwright-core)
npm test            # unit tests: parser, formats, layouts, engine, TPM, resurrect
npm run e2e         # loads the extension into Chromium and drives it with real keys
npm run package     # dist/chrome-tmux-<version>.zip
npm run icons       # regenerate icons/
```

`npm run e2e` needs Chromium rather than branded Chrome, which ignores `--load-extension`.
It uses `CHROME_PATH` or the newest Playwright Chromium in `~/.cache/ms-playwright`.
Set `SCREENSHOTS=/some/dir` to keep screenshots of each screen.

Debugging: the workspace exposes `window.ctmux` in DevTools (`ctmux.t` is the engine).
