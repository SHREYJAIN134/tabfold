// Tabfold service worker: launcher shortcuts, automatic tab groups, collapsing inactive groups, first-run setup.
// It keeps no state in memory that matters: everything is read from storage when an event arrives, because Chrome
// stops and restarts this worker at will.

import { slotNumber, getLaunchers, seedDefaults, getSettings, recordVerified } from './lib/store.js';
import { isSafeLaunchUrl } from './lib/url.js';
import { organizeTab, organizeAll, forgetTab } from './lib/grouping.js';
import { scheduleCollapse, organizeAndCollapse, collapseAllWindows } from './lib/collapse.js';

/** The normal window a launcher should open in: the one the key was pressed in, else the last focused one. */
async function targetWindowId(tab) {
  if (tab && typeof tab.windowId === 'number' && tab.windowId >= 0) {
    try { if ((await chrome.windows.get(tab.windowId)).type === 'normal') return tab.windowId; } catch { /* closed */ }
  }
  try { return (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id; } catch { return null; }
}

/**
 * Opens a launcher's saved website in a new ACTIVE tab of the current window.
 * An empty (deleted or never used) slot does nothing at all, even if Chrome still has a key assigned to it.
 */
export async function handleCommand(command, tab) {
  if (!slotNumber(command)) return 'ignored';
  const launcher = (await getLaunchers())[command];
  if (!launcher) return 'empty';
  if (!isSafeLaunchUrl(launcher.url)) return 'unsafe';

  const windowId = await targetWindowId(tab);
  let created;
  if (windowId == null) {
    const w = await chrome.windows.create({ url: launcher.url, focused: true });
    created = w.tabs && w.tabs[0];
  } else {
    created = await chrome.tabs.create({ windowId, url: launcher.url, active: true });
  }
  // Joins its group straight away (a no-op when Auto-group is off) and then the window's groups are re-checked, because the new tab
  // became active BEFORE it had a group.
  if (created && created.id != null) organizeAndCollapse(created.id, {});
  return 'opened';
}

// ---- what Chrome actually delivered
// A key combination can only be called Verified when this function ran for that command. The same key held down repeats, and
// Chrome could in principle deliver a command twice; a launcher must open its website exactly once per press.
export const DUPLICATE_WINDOW_MS = 700;
const lastDelivery = new Map();

export async function receiveCommand(command, tab, now = Date.now()) {
  if (!slotNumber(command)) return 'ignored';
  const previous = lastDelivery.get(command);
  if (previous !== undefined && now - previous < DUPLICATE_WINDOW_MS) return 'duplicate';
  lastDelivery.set(command, now);
  // Remember that Chrome delivered it, together with the key Chrome reports for it right now.
  Promise.resolve()
    .then(() => chrome.commands.getAll())
    .then((all) => recordVerified(command, (all.find((c) => c.name === command) || {}).shortcut || '', undefined, now))
    .catch(() => {}); // recording the receipt must never get in the way of opening the website
  return handleCommand(command, tab);
}

// ---- Quick Switcher (Alt+Q): a small popup window, because an extension popup can only ever show popup.html
export const QUICK_COMMAND = 'quick-switcher';
const QUICK_SIZE = { width: 480, height: 520 };

/** Opens the switcher centred over the current window; if it is already open, brings it forward, or closes it when it already has focus. */
export async function openQuickSwitcher() {
  const { quickWindowId } = await chrome.storage.session.get('quickWindowId');
  if (typeof quickWindowId === 'number') {
    try {
      const existing = await chrome.windows.get(quickWindowId);
      if (existing.focused) await chrome.windows.remove(quickWindowId);
      else await chrome.windows.update(quickWindowId, { focused: true });
      return existing.focused ? 'closed' : 'focused';
    } catch { /* it was closed: open a new one */ }
  }
  const position = {};
  try {
    const base = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (base.state !== 'minimized' && [base.left, base.top, base.width].every(Number.isFinite)) {
      position.left = Math.max(0, base.left + Math.round((base.width - QUICK_SIZE.width) / 2));
      position.top = Math.max(0, base.top + 60);
    }
  } catch { /* no normal window: let Chrome place it */ }
  const win = await chrome.windows.create({ url: chrome.runtime.getURL('quick.html'), type: 'popup', focused: true, ...QUICK_SIZE, ...position });
  await chrome.storage.session.set({ quickWindowId: win.id });
  return 'opened';
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === QUICK_COMMAND) { openQuickSwitcher().catch((err) => console.warn('Tabfold Quick Switcher failed:', err)); return; }
  receiveCommand(command, tab).catch((err) => console.warn('Tabfold launcher failed:', err));
});

// ---- grouping: new tabs, navigation, tabs moved between windows
chrome.tabs.onCreated.addListener((tab) => { if (tab.pendingUrl || tab.url) organizeAndCollapse(tab.id, {}); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url) organizeAndCollapse(tabId, { onlyIfCategoryChanged: true }); // a real navigation; not every reload
  else if (change.pinned === false) organizeAndCollapse(tabId, {});
  else if (change.groupId !== undefined && tab && tab.active) scheduleCollapse(tab.windowId, { skipDefer: true }); // the tab being read changed group
});
chrome.tabs.onAttached.addListener((tabId) => { organizeAndCollapse(tabId, {}); });
chrome.tabs.onRemoved.addListener((tabId) => { forgetTab(tabId); });

// ---- collapse: only the ACTIVATION of a tab (or grouping the active tab) triggers it, never background activity
chrome.tabs.onActivated.addListener(({ windowId }) => { scheduleCollapse(windowId); });

// ---- settings switched on later apply to what is already open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const flag = (side, key) => !changes.settings[side] || changes.settings[side][key] !== false; // missing = on
  if (!flag('oldValue', 'autoGroup') && flag('newValue', 'autoGroup')) organizeAll().then(collapseAllWindows);
  else if (!flag('oldValue', 'collapseInactive') && flag('newValue', 'collapseInactive')) collapseAllWindows();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await seedDefaults();
  if (details.reason === 'install' && (await getSettings()).autoGroup) { await organizeAll(); await collapseAllWindows(); }
});

// Also seed on every worker start: it is idempotent (a flag stops it re-adding a launcher the user deleted), and it means the
// default YouTube launcher exists even if Chrome did not deliver onInstalled (for example when the extension was reloaded).
seedDefaults().catch((err) => console.warn('Tabfold could not save its defaults:', err));

// Handy for diagnostics from the service worker's DevTools console.
globalThis.__tabfold = { handleCommand, receiveCommand, openQuickSwitcher, organizeAll, organizeTab, scheduleCollapse };
