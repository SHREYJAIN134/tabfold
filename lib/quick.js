// Quick Switcher logic: Tabfold groups, fuzzy matching and result ranking. Pure functions: no Chrome APIs.
// A "group" here is a Tabfold category (YouTube, Technical, Google, Others), decided by each tab's address, not a Chrome tab group.

import { CATEGORIES, CATEGORY_ORDER, filterCategory } from './categories.js';
import { tabTitle } from './search.js';
import { displayHost } from './url.js';

export const MAX_TAB_ROWS = 200; // rendering cap for huge result lists; typing narrows it

const boundary = (ch) => ch === ' ' || ch === '-' || ch === '_' || ch === '/' || ch === '.' || ch === ':' || ch === '|';

/** Score for one lower-case token against lower-case text; -1 for no match. A plain substring always beats a scattered match. */
export function fuzzyScore(token, text) {
  if (!token) return 0;
  if (!text) return -1;
  const at = text.indexOf(token);
  if (at >= 0) return 80 + Math.max(0, 40 - at) + (at === 0 ? 40 : boundary(text[at - 1]) ? 25 : 0);
  if (token.length < 2 || text.length > 300) return -1;
  // letters in order, e.g. "mlc" in "Machine Learning Course"
  let ti = 0, first = -1, last = -2, run = 0, score = 0, initials = 0;
  for (let i = 0; i < text.length && ti < token.length; i++) {
    if (text[i] !== token[ti]) continue;
    if (first < 0) first = i;
    run = i === last + 1 ? run + 1 : 0;
    const atStart = i === 0 || boundary(text[i - 1]);
    if (atStart) initials++;
    score += 4 + run * 3 + (atStart ? 6 : 0);
    last = i; ti++;
  }
  if (ti < token.length) return -1;
  const span = last - first + 1;
  if (initials < token.length && span > token.length * 3 + 6) return -1; // too scattered, unless every letter starts a word ("mlc")
  return Math.max(1, Math.min(60, score - (span - token.length)));
}

const tokensOf = (query) => String(query || '').toLowerCase().split(/\s+/).filter(Boolean);

/** Every token must match at least one field. fields: [[lowerCaseText, weight]]. Returns the summed best scores, or -1. */
function scoreFields(tokens, fields) {
  let total = 0;
  for (const token of tokens) {
    let best = -1;
    for (const [text, weight] of fields) { const s = fuzzyScore(token, text); if (s >= 0) best = Math.max(best, s * weight); }
    if (best < 0) return -1;
    total += best;
  }
  return total;
}

/** Tab title (weight 1), domain (0.9) and full address (0.5). Case-insensitive; every word must match. */
export function scoreTabFuzzy(tab, tokens) {
  if (!tokens.length) return 0;
  return scoreFields(tokens, [
    [tabTitle(tab).toLowerCase(), 1],
    [displayHost(tab.url).toLowerCase(), 0.9],
    [String(tab.url || '').toLowerCase(), 0.5],
  ]);
}

/**
 * tabs: [{ id, windowId, title, url, pinned?, lastAccessed? }] -> [{ id, title, color, count, tabs }].
 * Always the four groups, in Tabfold's order, even when empty. Tabs inside are most recently used first.
 */
export function buildGroups(tabs) {
  const groups = CATEGORY_ORDER.map((id) => ({ id, title: CATEGORIES[id].title, color: CATEGORIES[id].color, tabs: [] }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const tab of tabs || []) byId.get(filterCategory(tab.url)).tabs.push(tab);
  for (const g of groups) { g.tabs.sort(byRecency); g.count = g.tabs.length; }
  return groups;
}

const byRecency = (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0) || a.id - b.id;
const rankTabs = (rows) => rows.sort((a, b) => b.score - a.score || byRecency(a.tab, b.tab));

function matchTabs(group, tokens) {
  const rows = [];
  for (const tab of group.tabs) { const score = scoreTabFuzzy(tab, tokens); if (score >= 0) rows.push({ kind: 'tab', tab, group, score }); }
  return rankTabs(rows);
}

/**
 * What the switcher lists.
 *   groupId given        -> the tabs of that group, filtered by the query.
 *   "Group / words"      -> tabs matching `words` inside the group(s) matching "Group" (all its tabs when words is empty).
 *   anything else        -> matching groups first, then matching tabs from every group.
 * Rows are { kind: 'group', group } or { kind: 'tab', tab, group }. `truncated` is true when the tab list was cut at MAX_TAB_ROWS.
 */
export function runQuery(groups, { query = '', groupId = null } = {}) {
  const cap = (rows) => (rows.length > MAX_TAB_ROWS ? { rows: rows.slice(0, MAX_TAB_ROWS), truncated: true } : { rows, truncated: false });

  if (groupId) {
    const group = groups.find((g) => g.id === groupId);
    return group ? cap(matchTabs(group, tokensOf(query))) : { rows: [], truncated: false };
  }

  const slash = String(query).indexOf('/');
  if (slash > 0) {
    const groupTokens = tokensOf(query.slice(0, slash));
    const tabTokens = tokensOf(query.slice(slash + 1));
    const hits = groups
      .map((group) => ({ group, score: scoreFields(groupTokens, [[group.title.toLowerCase(), 1]]) }))
      .filter((h) => h.score >= 0)
      .sort((a, b) => b.score - a.score);
    if (hits.length) return cap(hits.flatMap((h) => matchTabs(h.group, tabTokens)));
    // "github.com/pulls" and the like: not a group, so the whole text is an ordinary search
  }

  const tokens = tokensOf(query);
  if (!tokens.length) return { rows: groups.map((group) => ({ kind: 'group', group, score: 0 })), truncated: false };

  const groupRows = groups
    .map((group) => ({ kind: 'group', group, score: scoreFields(tokens, [[group.title.toLowerCase(), 1]]) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score);
  const tabRows = rankTabs(groups.flatMap((group) => matchTabs(group, tokens)));
  const capped = cap(tabRows);
  return { rows: [...groupRows, ...capped.rows], truncated: capped.truncated };
}
