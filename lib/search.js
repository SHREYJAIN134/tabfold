// Searching and filtering the tab list for the switcher. Pure functions: no Chrome APIs.

import { displayHost } from './url.js';
import { filterCategory } from './categories.js';

const wordStart = (text, token) => text.startsWith(token) || text.includes(` ${token}`) || text.includes(`-${token}`) || text.includes(`/${token}`) || text.includes(`.${token}`);

/** What a tab is shown as: the title, or its address when it has none. */
export function tabTitle(tab) {
  return (tab.title && tab.title.trim()) || displayHost(tab.url) || tab.url || 'Untitled';
}

/** Score for one search token against a tab (higher = better); -1 when it matches nothing. */
function scoreToken(token, title, host, url) {
  if (host.startsWith(token)) return 100;
  if (wordStart(title, token)) return 80;
  if (host.includes(token)) return 70;
  if (title.includes(token)) return 50;
  if (url.includes(token)) return 20;
  return -1;
}

/** Every whitespace-separated word must match the title, the domain or the address. Returns a score, or -1. */
export function scoreTab(tab, query) {
  const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const title = tabTitle(tab).toLowerCase();
  const host = displayHost(tab.url).toLowerCase();
  const url = String(tab.url || '').toLowerCase();
  let total = 0;
  for (const token of tokens) {
    const s = scoreToken(token, title, host, url);
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

/**
 * tabs: [{ id, windowId, title, url, lastAccessed?, active? }]. category: 'all' | 'youtube' | 'technical' | 'google' | 'others'.
 * Best match first; ties (and an empty query) by most recently used.
 */
export function filterTabs(tabs, { query = '', category = 'all' } = {}) {
  const out = [];
  for (const tab of tabs) {
    if (category !== 'all' && filterCategory(tab.url) !== category) continue;
    const score = scoreTab(tab, query);
    if (score < 0) continue;
    out.push({ tab, score });
  }
  out.sort((a, b) => b.score - a.score || (b.tab.lastAccessed || 0) - (a.tab.lastAccessed || 0) || a.tab.id - b.tab.id);
  return out.map((r) => r.tab);
}

/** Moves a selection index by `delta` with wrap-around; always a valid index (or -1 for an empty list). */
export function moveSelection(index, delta, length) {
  if (!length) return -1;
  if (index < 0) return delta > 0 ? 0 : length - 1;
  return (index + delta + length) % length;
}
