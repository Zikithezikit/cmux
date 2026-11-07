// @ts-nocheck
import { Tmux } from '../core/tmux.js';
import { Tpm, memoryStorage } from '../tpm/tpm.js';
import {
  CONF_KEY, getConfRecord, setConfRecord, fileAccessAllowed, readLocalFile,
} from '../shared/config-source.js';

const $ = (id) => document.getElementById(id);
const WORKSPACE = chrome.runtime.getURL('src/workspace/workspace.html');

function status(text, ok = true) {
  const el = $('status');
  el.textContent = text;
  el.className = ok ? 'ok' : 'err';
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c instanceof Node ? c : String(c));
  return e;
}

/** Dry-run the config through the real engine and show what it understood. */
async function report(text) {
  const box = $('report');
  box.textContent = '';
  if (!text) { box.append(el('p', { class: 'hint' }, 'No configuration loaded — built-in tmux defaults (prefix C-b) will be used.')); return; }
  const t = new Tmux({ loadFile: async () => '' });
  const tpm = new Tpm(t, { storage: memoryStorage(), fetchImpl: async () => ({ ok: false, status: 0 }), timers: { setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout } });
  await t.loadDefaults();
  await t.runConfig(text, { source: '~/.tmux.conf' });
  tpm.finish();
  const userBindings = [...t.tables.values()].flatMap((m) => [...m.values()]).filter((b) => b.origin === 'user').length;
  const pluginBindings = [...t.tables.values()].flatMap((m) => [...m.values()]).filter((b) => b.origin.startsWith('plugin:')).length;
  box.append(
    el('p', {}, `Prefix `, el('code', {}, t.getOption('prefix')), ` · mouse `, el('code', {}, t.getOption('mouse')),
      ` · mode-keys `, el('code', {}, t.getOption('mode-keys')), ` · status `, el('code', {}, t.getOption('status-position')),
      ` · ${userBindings} key bindings from your file, ${pluginBindings} from plugins`),
  );
  const plugins = tpm.report();
  if (plugins.length) {
    box.append(el('h3', {}, 'Plugins'), el('table', {},
      el('tr', {}, el('th', {}, 'plugin'), el('th', {}, 'status'), el('th', {}, 'what it does here')),
      plugins.map((p) => el('tr', {},
        el('td', {}, el('code', {}, p.repo)),
        el('td', { class: p.status === 'emulated' ? 'ok' : 'lvl-warn' }, p.status),
        el('td', {}, p.description || 'No JS emulator — listed in the debug panel (prefix ~) with its options.')))));
  }
  const notices = t.notices.filter((n) => n.source !== '(defaults)');
  box.append(el('h3', {}, `Notices (${notices.length})`));
  if (!notices.length) box.append(el('p', { class: 'ok' }, 'Everything in the file was understood.'));
  else {
    box.append(el('table', {}, notices.map((n) => el('tr', {},
      el('td', { class: `lvl-${n.level}` }, n.level),
      el('td', {}, n.line ? `line ${n.line}` : ''),
      el('td', {}, n.message)))));
  }
}

async function refresh() {
  const rec = await getConfRecord();
  $('text').value = rec?.text || '';
  if (rec?.path) $('path').value = rec.path;
  $('source-label').textContent = rec
    ? `Current source: ${rec.path || rec.name || 'pasted text'} (saved ${new Date(rec.updatedAt).toLocaleString()})`
    : 'No configuration saved yet.';
  await report(rec?.text || '');
}

async function init() {
  const allowed = await fileAccessAllowed();
  $('file-access').textContent = allowed ? 'allowed' : 'not allowed';
  $('file-access').className = allowed ? 'ok' : 'lvl-warn';
  $('ext-details').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  });
  $('app-cmd').textContent = `google-chrome --app=${WORKSPACE}`;
  $('open').addEventListener('click', () => chrome.tabs.create({ url: WORKSPACE }));

  $('path-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let path = $('path').value.trim();
    if (!path) return;
    if (path.startsWith('~')) { status('Use an absolute path, e.g. /home/you/.tmux.conf (the browser does not know your home directory).', false); return; }
    try {
      const text = await readLocalFile(path);
      await setConfRecord({ path, text, origin: 'path' });
      status(`Loaded ${path} (${text.split('\n').length} lines).`);
      await refresh();
    } catch (err) {
      status(`${err.message}. ${allowed ? '' : 'Enable "Allow access to file URLs" first.'}`, false);
    }
  });

  $('file').addEventListener('change', async () => {
    const f = $('file').files[0];
    if (!f) return;
    const text = await f.text();
    await setConfRecord({ text, name: f.name, origin: 'upload' });
    status(`Saved a copy of ${f.name}. Re-upload after editing it, or use the path option.`);
    await refresh();
  });

  $('save-text').addEventListener('click', async () => {
    const rec = await getConfRecord();
    const text = $('text').value;
    if (rec?.path) {
      status('Saved text replaces the disk path: the workspace will use this text from now on.');
    } else {
      status('Saved.');
    }
    await setConfRecord({ text, origin: 'paste' });
    await refresh();
  });

  $('clear-resurrect').addEventListener('click', async () => {
    await chrome.storage.local.remove(['ctmux:resurrect:last', 'ctmux:resurrect:history']);
    $('state-info').textContent = 'Resurrect snapshot deleted.';
  });
  $('clear-history').addEventListener('click', async () => {
    await chrome.storage.local.remove('ctmux:history');
    $('state-info').textContent = 'URL history cleared.';
  });
  const snap = (await chrome.storage.local.get('ctmux:resurrect:last'))['ctmux:resurrect:last'];
  if (snap) $('state-info').textContent = `Last resurrect save: ${new Date(snap.savedAt).toLocaleString()} (${snap.sessions.length} sessions)`;

  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[CONF_KEY]) refresh(); });
  await refresh();
}

init();
