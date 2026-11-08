// "Collapse inactive groups": expand the group of the tab you are on, collapse every other group IN THAT SAME WINDOW.
//
// Rules (all enforced here):
//  - Only the `collapsed` flag of groups is ever changed. Tabs are never closed, moved or regrouped by this module, and group
//    names, colours, membership and order are untouched.
//  - A pass always reads the window's CURRENT active tab, so during rapid switching the most recently selected tab wins: a pass
//    that notices a newer request stops and the newer one runs. Passes for one window never overlap; windows are independent.
//  - Selecting an ungrouped or pinned tab collapses every group in that window.
//  - Chrome moves you to another tab if the group holding the active tab is collapsed, so that group is never collapsed, and
//    the active tab is re-read right before each collapse.
//  - A tab that just became active but is not in its group yet (auto-grouping has not run) waits for grouping, then the
//    window is re-checked with the tab's real group. Background activity never triggers a pass: only activation of a tab
//    and grouping of the ACTIVE tab do, so opening or updating a background tab can never collapse the group being read.

import { categorize } from './categories.js';
import { getSettings } from './store.js';
import { organizeTab, lastCategory, withRetry } from './grouping.js';

const NO_GROUP = -1;
const windows = new Map(); // windowId -> { running, dirty, opts, promise }

/** True while the active tab will be put into a group by Auto-group in a moment (so collapsing now would be premature). */
async function awaitingGrouping(tab, settings) {
  if (!settings.autoGroup || tab.pinned || tab.groupId !== NO_GROUP) return false;
  const url = tab.pendingUrl && categorize(tab.pendingUrl) ? tab.pendingUrl : tab.url;
  const target = categorize(url);
  if (!target) return false; // blank tab, chrome:// page ...: it will never be grouped
  return (await lastCategory(tab.id)) !== target;
}

/** One pass for one window. `stale()` turns true as soon as a newer request arrives. Returns what it did (useful in tests). */
async function reconcile(windowId, { skipDefer }, stale) {
  const settings = await getSettings();
  if (!settings.collapseInactive) return 'off';
  let win;
  try { win = await chrome.windows.get(windowId); } catch { return 'gone'; }
  if (win.type !== 'normal') return 'window';

  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (!active) return 'no-active';
  if (stale()) return 'stale';

  if (!skipDefer && (await awaitingGrouping(active, settings))) {
    organizeAndCollapse(active.id); // groups it, then re-checks this window with the tab's real group
    return 'deferred';
  }

  const groups = await chrome.tabGroups.query({ windowId });
  // The group being read first (expand), then everything else (collapse).
  const ordered = [...groups].sort((a, b) => Number(b.id === active.groupId) - Number(a.id === active.groupId));
  for (const g of ordered) {
    const wantCollapsed = g.id !== active.groupId;
    if (g.collapsed === wantCollapsed) continue;
    if (stale()) return 'stale';
    if (wantCollapsed) {
      // Re-read the active tab right before collapsing: collapsing the group that holds it would pull the user off their tab.
      const [now] = await chrome.tabs.query({ active: true, windowId });
      if (!now || now.id !== active.id || now.groupId === g.id) return 'stale';
    }
    try { await withRetry(() => chrome.tabGroups.update(g.id, { collapsed: wantCollapsed })); } catch { /* group closed meanwhile */ }
  }
  return 'done';
}

/**
 * Ask for a pass on `windowId`. Requests made while a pass is running are merged: the pass restarts once with the newest state.
 * Resolves when the window has settled.
 */
export function scheduleCollapse(windowId, { skipDefer = false } = {}) {
  let w = windows.get(windowId);
  if (!w) { w = { running: false, dirty: false, opts: {}, promise: Promise.resolve() }; windows.set(windowId, w); }
  w.dirty = true;
  w.opts = { skipDefer };
  if (!w.running) {
    w.running = true;
    w.promise = (async () => {
      try {
        while (w.dirty) {
          w.dirty = false;
          await reconcile(windowId, w.opts, () => w.dirty).catch(() => {});
        }
      } finally { w.running = false; }
    })();
  }
  return w.promise;
}

/** Put a tab in its group (Auto-group), then, if that tab is the one being read, re-check its window with its real group. */
export async function organizeAndCollapse(tabId, options) {
  const result = await organizeTab(tabId, options);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active) await scheduleCollapse(tab.windowId, { skipDefer: true });
  } catch { /* the tab closed */ }
  return result;
}

/** Collapse state for every normal window (when the setting is switched on, and after the first grouping). */
export async function collapseAllWindows() {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  await Promise.all(wins.map((w) => scheduleCollapse(w.id)));
}
