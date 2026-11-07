import { Tmux } from '../core/tmux.js';
import { Tpm, memoryStorage } from '../tpm/tpm.js';
import type { TpmTimers } from '../tpm/tpm.js';
import type { Snapshot } from '../core/server.js';
import {
  CONF_KEY, getConfRecord, setConfRecord, fileAccessAllowed, readLocalFile,
} from '../shared/config-source.js';

/** The parts of a tmux-resurrect snapshot this page shows. */
type ResurrectSnapshot = Pick<Snapshot, 'savedAt' | 'sessions'>;

/** The elements of options.html, by id. */
interface OptionsElements {
  'open': HTMLButtonElement;
  'ext-details': HTMLAnchorElement;
  'file-access': HTMLElement;
  'path-form': HTMLFormElement;
  'path': HTMLInputElement;
  'file': HTMLInputElement;
  'text': HTMLTextAreaElement;
  'save-text': HTMLButtonElement;
  'source-label': HTMLSpanElement;
  'status': HTMLParagraphElement;
  'report': HTMLDivElement;
  'app-cmd': HTMLPreElement;
  'clear-resurrect': HTMLButtonElement;
  'clear-history': HTMLButtonElement;
  'state-info': HTMLSpanElement;
}

type Child = Node | string | number | boolean | null | undefined;

// options.html guarantees these elements and their tags.
const $ = <K extends keyof OptionsElements>(id: K): OptionsElements[K] => document.getElementById(id) as OptionsElements[K];
const WORKSPACE = chrome.runtime.getURL('src/workspace/workspace.html');

/** The dry run never polls or fetches plugin metadata. */
const NO_TIMERS = { setInterval: () => 0, clearInterval() {} } satisfies TpmTimers;

function isResurrectSnapshot(v: unknown): v is ResurrectSnapshot {
  return typeof v === 'object' && v !== null && 'savedAt' in v && typeof v.savedAt === 'number'
    && 'sessions' in v && Array.isArray(v.sessions);
}

/** Adapt an async handler for addEventListener (a rejection stays unhandled, as before). */
function listener<E>(fn: (e: E) => Promise<void>): (e: E) => void {
  return (e) => { void fn(e); };
}

function status(text: string, ok = true): void {
  const el = $('status');
  el.textContent = text;
  el.className = ok ? 'ok' : 'err';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c instanceof Node ? c : String(c));
  return e;
}

/** Dry-run the config through the real engine and show what it understood. */
async function report(text: string): Promise<void> {
  const box = $('report');
  box.textContent = '';
  if (!text) { box.append(el('p', { class: 'hint' }, 'No configuration loaded — built-in tmux defaults (prefix C-b) will be used.')); return; }
  const t = new Tmux({ loadFile: async () => '' });
  // Response.error() is a network-error response: ok false, status 0.
  const tpm = new Tpm(t, { storage: memoryStorage(), fetchImpl: async () => Response.error(), timers: NO_TIMERS });
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

async function refresh(): Promise<void> {
  const rec = await getConfRecord();
  $('text').value = rec?.text || '';
  if (rec?.path) $('path').value = rec.path;
  $('source-label').textContent = rec
    ? `Current source: ${rec.path || rec.name || 'pasted text'} (saved ${new Date(rec.updatedAt ?? NaN).toLocaleString()})`
    : 'No configuration saved yet.';
  await report(rec?.text || '');
}

async function init(): Promise<void> {
  const allowed = await fileAccessAllowed();
  $('file-access').textContent = allowed ? 'allowed' : 'not allowed';
  $('file-access').className = allowed ? 'ok' : 'lvl-warn';
  $('ext-details').addEventListener('click', (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  });
  $('app-cmd').textContent = `google-chrome --app=${WORKSPACE}`;
  $('open').addEventListener('click', () => void chrome.tabs.create({ url: WORKSPACE }));

  $('path-form').addEventListener('submit', listener(async (e) => {
    e.preventDefault();
    const path = $('path').value.trim();
    if (!path) return;
    if (path.startsWith('~')) { status('Use an absolute path, e.g. /home/you/.tmux.conf (the browser does not know your home directory).', false); return; }
    try {
      const text = await readLocalFile(path);
      await setConfRecord({ path, text, origin: 'path' });
      status(`Loaded ${path} (${text.split('\n').length} lines).`);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      status(`${message}. ${allowed ? '' : 'Enable "Allow access to file URLs" first.'}`, false);
    }
  }));

  $('file').addEventListener('change', listener(async () => {
    const f = $('file').files?.[0];
    if (!f) return;
    const text = await f.text();
    await setConfRecord({ text, name: f.name, origin: 'upload' });
    status(`Saved a copy of ${f.name}. Re-upload after editing it, or use the path option.`);
    await refresh();
  }));

  $('save-text').addEventListener('click', listener(async () => {
    const rec = await getConfRecord();
    const text = $('text').value;
    if (rec?.path) {
      status('Saved text replaces the disk path: the workspace will use this text from now on.');
    } else {
      status('Saved.');
    }
    await setConfRecord({ text, origin: 'paste' });
    await refresh();
  }));

  $('clear-resurrect').addEventListener('click', listener(async () => {
    await chrome.storage.local.remove(['ctmux:resurrect:last', 'ctmux:resurrect:history']);
    $('state-info').textContent = 'Resurrect snapshot deleted.';
  }));
  $('clear-history').addEventListener('click', listener(async () => {
    await chrome.storage.local.remove('ctmux:history');
    $('state-info').textContent = 'URL history cleared.';
  }));
  const snap = (await chrome.storage.local.get('ctmux:resurrect:last'))['ctmux:resurrect:last'];
  if (isResurrectSnapshot(snap)) $('state-info').textContent = `Last resurrect save: ${new Date(snap.savedAt).toLocaleString()} (${snap.sessions.length} sessions)`;

  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[CONF_KEY]) void refresh(); });
  await refresh();
}

void init();
