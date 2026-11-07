// chrome-tmux service worker.
//
// Keeps a declarativeNetRequest *session* rule that strips X-Frame-Options and
// Content-Security-Policy from sub_frame responses — scoped with `tabIds` to
// workspace tabs only, so ordinary browsing keeps its protections.

const RULE_ID = 1;
const TABS_KEY = 'workspaceTabs';
const WORKSPACE = 'src/workspace/workspace.html';

async function getTabs(): Promise<number[]> {
  return ((await chrome.storage.session.get(TABS_KEY))[TABS_KEY] as number[] | undefined) || [];
}

async function applyRule(tabs: number[]) {
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
function updateTabs(fn: (tabs: number[]) => number[] | Promise<number[]>) {
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

function register(tabId: number) {
  return updateTabs(async (tabs) => {
    if (!tabs.includes(tabId)) tabs.push(tabId);
    // Drop tabs that no longer exist (e.g. after a crash).
    const alive = [];
    for (const id of tabs) {
      try { await chrome.tabs.get(id); alive.push(id); } catch { /* gone */ }
    }
    return alive;
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.ctmux !== 'register-workspace') return false;
  // Only our own extension pages may register a tab.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(WORKSPACE)) || !sender.tab) {
    sendResponse({ ok: false });
    return false;
  }
  register(sender.tab.id!).then(() => sendResponse({ ok: true, tabId: sender.tab!.id }), (err) => sendResponse({ ok: false, error: String(err) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  updateTabs((tabs) => tabs.filter((id) => id !== tabId));
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // A workspace tab that navigated away is no longer a workspace.
  if (!info.url || info.url.startsWith(chrome.runtime.getURL(WORKSPACE))) return;
  updateTabs((tabs) => tabs.filter((id) => id !== tabId));
});

async function openWorkspace() {
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

chrome.action.onClicked.addListener(openWorkspace);
chrome.commands.onCommand.addListener((cmd) => { if (cmd === 'open-workspace') openWorkspace(); });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // Extension updates drop session rules; re-apply for open workspaces.
  getTabs().then(applyRule);
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
