// chrome-tmux service worker.
//
// Keeps a declarativeNetRequest *session* rule that strips X-Frame-Options and
// Content-Security-Policy from sub_frame responses — scoped with `tabIds` to
// workspace tabs only, so ordinary browsing keeps its protections.
//
// Loaded as an ES module (manifest "type": "module"); the empty export keeps
// its top-level names out of the global scope the other scripts share.
export {};

const RULE_ID = 1;
const TABS_KEY = 'workspaceTabs';
const WORKSPACE = 'src/workspace/workspace.html';

function isTabList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'number');
}

/** The one message this worker handles (sent by the workspace page). */
interface RegisterMessage {
  ctmux: 'register-workspace';
}

function isRegisterMessage(msg: unknown): msg is RegisterMessage {
  return typeof msg === 'object' && msg !== null && 'ctmux' in msg && msg.ctmux === 'register-workspace';
}

async function getTabs(): Promise<number[]> {
  const stored: unknown = (await chrome.storage.session.get(TABS_KEY))[TABS_KEY];
  return isTabList(stored) ? stored : [];
}

async function applyRule(tabs: number[]): Promise<void> {
  const addRules: chrome.declarativeNetRequest.Rule[] = tabs.length ? [{
    id: RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
      ],
    },
    condition: { resourceTypes: ['sub_frame'], tabIds: tabs },
  }] : [];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID], addRules });
}

// All updates to the tab list go through one queue so concurrent
// registrations / tab closes can't lose each other's writes.
let queue: Promise<unknown> = Promise.resolve();
function updateTabs(fn: (tabs: number[]) => number[] | Promise<number[]>): Promise<number[]> {
  const run = queue.then(async () => {
    const before = await getTabs();
    const tabs = await fn(before.slice());
    if (tabs.join() === before.join()) return tabs;
    await chrome.storage.session.set({ [TABS_KEY]: tabs });
    await applyRule(tabs);
    return tabs;
  });
  queue = run.catch(() => {});
  return run;
}

function register(tabId: number): Promise<number[]> {
  return updateTabs(async (tabs) => {
    if (!tabs.includes(tabId)) tabs.push(tabId);
    // Drop tabs that no longer exist (e.g. after a crash).
    const alive: number[] = [];
    for (const id of tabs) {
      try { await chrome.tabs.get(id); alive.push(id); } catch { /* gone */ }
    }
    return alive;
  });
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (!isRegisterMessage(msg)) return false;
  // Only our own extension pages may register a tab.
  const tabId = sender.tab?.id;
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(WORKSPACE)) || tabId === undefined) {
    sendResponse({ ok: false });
    return false;
  }
  register(tabId).then(() => sendResponse({ ok: true, tabId }), (err: unknown) => sendResponse({ ok: false, error: String(err) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void updateTabs((tabs) => tabs.filter((id) => id !== tabId));
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // A workspace tab that navigated away is no longer a workspace.
  if (!info.url || info.url.startsWith(chrome.runtime.getURL(WORKSPACE))) return;
  void updateTabs((tabs) => tabs.filter((id) => id !== tabId));
});

async function openWorkspace(): Promise<void> {
  const url = chrome.runtime.getURL(WORKSPACE);
  for (const id of await getTabs()) {
    try {
      const tab = await chrome.tabs.get(id);
      await chrome.tabs.update(id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch { /* stale */ }
  }
  await chrome.tabs.create({ url });
}

chrome.action.onClicked.addListener(() => void openWorkspace());
chrome.commands.onCommand.addListener((cmd) => { if (cmd === 'open-workspace') void openWorkspace(); });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // Extension updates drop session rules; re-apply for open workspaces.
  void getTabs().then(applyRule);
  if (reason === 'install') void chrome.runtime.openOptionsPage();
});
