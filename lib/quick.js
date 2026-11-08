// Quick Switcher data: Tabfold's groups and the tabs in them. Pure functions: no Chrome APIs.
// A "group" here is a Tabfold category (YouTube, Technical, Google, Others), decided by each tab's address, not a Chrome tab group.

import { CATEGORIES, CATEGORY_ORDER, filterCategory } from './categories.js';

/**
 * tabs: [{ id, windowId, index, url, ... }], windowOrder: window ids as Chrome lists them.
 * -> [{ id, title, color, count, tabs }]: always all four groups in Tabfold's order (empty ones included); inside a group the
 * tabs keep browser order (window by window, left to right).
 */
export function buildGroups(tabs, windowOrder = []) {
  const groups = CATEGORY_ORDER.map((id) => ({ id, title: CATEGORIES[id].title, color: CATEGORIES[id].color, tabs: [] }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const tab of tabs || []) byId.get(filterCategory(tab.url)).tabs.push(tab);
  const rank = (w) => { const i = windowOrder.indexOf(w); return i < 0 ? windowOrder.length : i; };
  for (const g of groups) {
    g.tabs.sort((a, b) => rank(a.windowId) - rank(b.windowId) || a.index - b.index || a.id - b.id);
    g.count = g.tabs.length;
  }
  return groups;
}
