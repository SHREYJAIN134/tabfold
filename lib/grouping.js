// Native Chrome tab groups: YouTube, Technical, Google, Others.
//
// Rules:
//  - Groups are per window. Each window gets its own group for a category; a category group is reused, never duplicated.
//  - Pinned tabs, blank tabs, Chrome/internal pages, and tabs in a group the user made themselves are left alone.
//  - A tab that is in one of OUR category groups is moved when it navigates to a different category.
//  - Calls are queued one at a time, so five GitHub tabs opened together end up in ONE Technical group.

import { CATEGORIES, CATEGORY_ORDER, categorize } from './categories.js';
import { getSettings } from './store.js';

// ---- a tiny serial queue: tab events arrive in bursts and each one reads then changes the group list
let tail = Promise.resolve();
function serial(job) {
  const run = tail.then(() => job());
  tail = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NO_GROUP = -1; // chrome.tabs.TAB_ID_NONE / tabGroups.TAB_GROUP_ID_NONE

/** Chrome refuses tab edits for a moment while the user drags a tab; wait and try again. */
export async function withRetry(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (err) {
      const transient = /dragging|cannot be edited|Tabs cannot/i.test(String(err && err.message));
      if (!transient || i >= tries - 1) throw err;
      await sleep(250 * (i + 1));
    }
  }
}

/** Which of OUR categories a group is (matched by the title and colour we give them), or null for anyone else's group. */
export function categoryOfGroup(group) {
  if (!group) return null;
  for (const id of CATEGORY_ORDER) if (group.title === CATEGORIES[id].title && group.color === CATEGORIES[id].color) return id;
  return null;
}

// What category each tab was last placed in (survives the service worker being stopped). Used so that, for example,
// a tab the user dragged out of "Technical" is not pulled back every time it navigates within GitHub.
const sessionStore = () => (chrome.storage && chrome.storage.session) || null;
export async function lastCategory(tabId) {
  const s = sessionStore(); if (!s) return undefined;
  const { tabCategories } = await s.get('tabCategories');
  return tabCategories ? tabCategories[tabId] : undefined;
}
async function rememberCategory(tabId, category) {
  const s = sessionStore(); if (!s) return;
  const { tabCategories = {} } = await s.get('tabCategories');
  if (category) tabCategories[tabId] = category; else delete tabCategories[tabId];
  await s.set({ tabCategories });
}
export const forgetTab = (tabId) => rememberCategory(tabId, null).catch(() => {});

async function organizeNow(tabId, { onlyIfCategoryChanged = false } = {}) {
  if (!(await getSettings()).autoGroup) return 'disabled';

  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return 'gone'; }
  if (tab.pinned) return 'pinned';

  // A tab that is still loading reports its destination in pendingUrl; prefer it when it is an ordinary website.
  const url = tab.pendingUrl && categorize(tab.pendingUrl) ? tab.pendingUrl : tab.url;
  const target = categorize(url);
  if (!target) return 'skipped'; // blank tab, chrome://..., extension page, file, devtools ...

  let win;
  try { win = await chrome.windows.get(tab.windowId); } catch { return 'gone'; }
  if (win.type !== 'normal') return 'window'; // popup / app windows cannot hold groups

  if (onlyIfCategoryChanged && (await lastCategory(tab.id)) === target) return 'unchanged';

  if (tab.groupId !== NO_GROUP) {
    let current = null;
    try { current = await chrome.tabGroups.get(tab.groupId); } catch { /* group vanished: treat as ungrouped */ }
    if (current) {
      const mine = categoryOfGroup(current);
      if (!mine) return 'custom-group'; // the user's own group: never touch it
      if (mine === target) { await rememberCategory(tab.id, target); return 'already'; }
    }
  }

  const def = CATEGORIES[target];
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
  const existing = groups.find((g) => categoryOfGroup(g) === target);
  if (existing) {
    await withRetry(() => chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id }));
  } else {
    const groupId = await withRetry(() => chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } }));
    await chrome.tabGroups.update(groupId, { title: def.title, color: def.color });
  }
  await rememberCategory(tab.id, target);
  return 'grouped';
}

/** Put one tab in the right group (queued). Resolves with what happened; never rejects. */
export function organizeTab(tabId, options) {
  return serial(() => organizeNow(tabId, options)).catch((err) => `error: ${err && err.message}`);
}

/** Organise every tab in every normal window (on install, and when Auto-group is switched back on). */
export function organizeAll() {
  return serial(async () => {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const results = [];
    for (const w of windows) for (const t of w.tabs || []) results.push(await organizeNow(t.id).catch((e) => `error: ${e && e.message}`));
    return results;
  }).catch((err) => [`error: ${err && err.message}`]);
}
