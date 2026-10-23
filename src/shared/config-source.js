// Where the user's tmux.conf comes from. The options page stores either a
// filesystem path (read through file:// — needs "Allow access to file URLs")
// or the file's text (uploaded or pasted). Shared by the workspace and options page.

export const CONF_KEY = 'ctmux:conf';

export async function getConfRecord() {
  return (await chrome.storage.local.get(CONF_KEY))[CONF_KEY] || null;
}

export async function setConfRecord(rec) {
  await chrome.storage.local.set({ [CONF_KEY]: { ...rec, updatedAt: Date.now() } });
}

export function fileAccessAllowed() {
  return new Promise((resolve) => {
    try { chrome.extension.isAllowedFileSchemeAccess(resolve); } catch { resolve(false); }
  });
}

/** Read a local file through file://. fetch() rejects file: URLs, XHR does not. */
export function readLocalFile(path) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = 'file://' + path.split('/').map(encodeURIComponent).join('/');
    xhr.open('GET', url);
    xhr.onload = () => {
      if (xhr.status === 0 || xhr.status === 200) resolve(xhr.responseText);
      else reject(new Error(`HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('cannot read file (is "Allow access to file URLs" enabled?)'));
    xhr.send();
  });
}

/** Infer $HOME from the configured path (/home/me/.tmux.conf → /home/me). */
export function homeFromPath(path) {
  const m = /^(\/(?:home|Users)\/[^/]+|\/root)(?:\/|$)/.exec(path || '');
  return m ? m[1] : null;
}

export function expandHome(path, home) {
  if (!home) return path;
  return path.replace(/^~(?=\/|$)/, home).replace(/^\$HOME(?=\/|$)/, home).replace(/^\$\{HOME\}(?=\/|$)/, home);
}

const MAIN_CONF = [/^~\/\.tmux\.conf$/, /^~\/\.config\/tmux\/tmux\.conf$/, /^\$XDG_CONFIG_HOME\/tmux\/tmux\.conf$/, /^\$HOME\/\.tmux\.conf$/];

/**
 * Load the main configuration. Re-reads from disk when a path is configured,
 * falling back to the stored copy. Returns { text, label, error }.
 */
export async function loadMainConfig() {
  const rec = await getConfRecord();
  if (!rec) return { text: '', label: 'none (built-in defaults — load your ~/.tmux.conf in the extension options)', error: null };
  if (rec.path) {
    try {
      const text = await readLocalFile(rec.path);
      if (text !== rec.text) await setConfRecord({ ...rec, text });
      return { text, label: rec.path, error: null };
    } catch (err) {
      return {
        text: rec.text || '',
        label: `${rec.path} (cached copy)`,
        error: `could not re-read ${rec.path}: ${err.message}`,
      };
    }
  }
  return { text: rec.text || '', label: rec.name ? `${rec.name} (${rec.origin || 'stored'})` : `stored text (${rec.origin || 'pasted'})`, error: null };
}

/** Loader for `source-file <path>`. */
export async function loadConfigFile(path) {
  const rec = await getConfRecord();
  const home = homeFromPath(rec?.path);
  const isMain = MAIN_CONF.some((re) => re.test(path)) || (rec?.path && expandHome(path, home) === rec.path);
  if (isMain) {
    const r = await loadMainConfig();
    if (!r.text && !rec) throw new Error('no configuration loaded (see extension options)');
    return r.text;
  }
  const full = expandHome(path, home);
  if (!full.startsWith('/')) throw new Error(`cannot resolve ${path}${home ? '' : ' (set a config path in options so ~ can be expanded)'}`);
  return readLocalFile(full);
}
