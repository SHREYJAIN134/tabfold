// Tabfold Quick Switcher (Alt+Q): groups first, then the tabs of a group, all from the keyboard.
// Page titles and URLs are only ever put into the DOM with textContent / setAttribute, never as HTML.

import { displayHost } from './lib/url.js';
import { CATEGORIES, filterCategory } from './lib/categories.js';
import { moveSelection, tabTitle } from './lib/search.js';
import { buildGroups, runQuery, MAX_TAB_ROWS } from './lib/quick.js';

const $ = (id) => document.getElementById(id);

const state = { tabs: [], windows: [], groups: [], groupId: null, query: '', rows: [], truncated: false, selectedKey: null, selected: 0 };

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== undefined && c !== null) node.append(c);
  return node;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const rowKey = (row) => (row.kind === 'group' ? `g:${row.group.id}` : `t:${row.tab.id}`);
const announce = (message) => { $('live').textContent = ''; setTimeout(() => { $('live').textContent = message; }, 30); };

// =============================================================================================== data

async function load() {
  const [tabs, windows] = await Promise.all([chrome.tabs.query({ windowType: 'normal' }), chrome.windows.getAll({ windowTypes: ['normal'] })]);
  state.tabs = tabs;
  state.windows = windows.map((w) => w.id);
  state.groups = buildGroups(tabs);
}

/** Re-reads Chrome, keeping the query and, when possible, the highlighted row. Used for the first paint and for live updates. */
async function refresh() {
  await load();
  render({ keepSelection: true });
}

// =============================================================================================== view

function render({ keepSelection = false } = {}) {
  const previous = keepSelection ? state.selectedKey : null;
  const result = runQuery(state.groups, { query: state.query, groupId: state.groupId });
  state.rows = result.rows;
  state.truncated = result.truncated;

  const at = previous ? state.rows.findIndex((r) => rowKey(r) === previous) : -1;
  state.selected = at >= 0 ? at : 0;
  state.selectedKey = state.rows[state.selected] ? rowKey(state.rows[state.selected]) : null;

  const group = state.groupId ? state.groups.find((g) => g.id === state.groupId) : null;
  $('crumb').hidden = !group;
  if (group) $('crumb').textContent = `${group.title} — ${plural(group.count, 'tab')}`;
  $('q').placeholder = group ? `Search within ${group.title}...` : 'Search groups or tabs...';
  $('hints').textContent = group ? '↑↓ select · Enter switch · Backspace back · Esc close' : '↑↓ select · Enter open · Esc close';

  const list = $('results');
  list.textContent = '';
  const frag = document.createDocumentFragment();
  state.rows.forEach((row, i) => frag.append(row.kind === 'group' ? groupItem(row, i) : tabItem(row, i)));
  if (state.truncated) frag.append(el('li', { class: 'more', text: `Showing the first ${MAX_TAB_ROWS}. Keep typing to narrow it down.` }));
  list.append(frag);

  const empty = $('empty');
  empty.hidden = state.rows.length > 0;
  if (!state.rows.length) {
    empty.textContent = state.query ? `No matches for “${state.query}”.` : group ? `No tabs in ${group.title}.` : 'No groups.';
  }
  $('count').textContent = state.groupId ? plural(state.rows.length, 'tab') : '';
  syncSelection({ scroll: false });
}

function groupItem(row, i) {
  const { group } = row;
  const item = el('li', { class: 'item group', role: 'option', id: `opt-${i}`, 'aria-selected': 'false', 'aria-label': `${group.title}, ${plural(group.count, 'tab')}` },
    el('span', { class: 'fav', 'aria-hidden': 'true' }, el('i', { class: `dot ${group.id}` })),
    el('div', { class: 'meta' }, el('div', { class: 'title', text: group.title })),
    el('span', { class: 'count-pill', text: plural(group.count, 'tab') }));
  item.addEventListener('click', () => choose(row));
  item.addEventListener('mousemove', () => { if (state.selected !== i) select(i, { scroll: false }); });
  return item;
}

function tabItem(row, i) {
  const { tab, group } = row;
  const host = displayHost(tab.url);
  const cat = filterCategory(tab.url);
  const fav = el('span', { class: 'fav', 'aria-hidden': 'true' });
  const letter = (host || tabTitle(tab)).charAt(0).toUpperCase();
  if (tab.favIconUrl && /^(https?:|data:image\/)/.test(tab.favIconUrl)) {
    const img = el('img', { src: tab.favIconUrl, alt: '', width: '16', height: '16' });
    img.addEventListener('error', () => { fav.textContent = letter; img.remove(); });
    fav.append(img);
  } else fav.textContent = letter;

  const badges = el('span', { class: 'badges' });
  if (tab.pinned) badges.append(el('span', { class: 'badge', text: 'Pinned' }));
  if (state.windows.length > 1) {
    const n = state.windows.indexOf(tab.windowId) + 1;
    badges.append(el('span', { class: 'badge other', text: `Window ${n || '?'}`, title: 'Which Chrome window this tab is in' }));
  } else if (tab.active) badges.append(el('span', { class: 'badge', text: 'Current' }));

  // Outside a group view the group name tells equal-looking results apart; the domain does the same for duplicate titles.
  const sub = el('div', { class: 'sub' }, el('i', { class: `dot ${cat}`, title: CATEGORIES[cat].title }));
  if (!state.groupId) sub.append(el('span', { class: 'gname', text: group.title }), el('span', { class: 'sep', text: '·' }));
  sub.append(el('span', { class: 'host', text: host || tab.url || '' }));

  const item = el('li', { class: 'item', role: 'option', id: `opt-${i}`, 'aria-selected': 'false', 'aria-label': `${tabTitle(tab)}, ${host}, ${group.title}` },
    fav, el('div', { class: 'meta' }, el('div', { class: 'title', text: tabTitle(tab) }), sub), badges);
  item.addEventListener('click', () => choose(row));
  item.addEventListener('mousemove', () => { if (state.selected !== i) select(i, { scroll: false }); });
  return item;
}

function syncSelection({ scroll = true } = {}) {
  const items = $('results').querySelectorAll('.item');
  items.forEach((node, i) => node.setAttribute('aria-selected', String(i === state.selected)));
  const node = items[state.selected];
  if (node) {
    if (scroll) node.scrollIntoView({ block: 'nearest' });
    $('q').setAttribute('aria-activedescendant', node.id);
  } else $('q').removeAttribute('aria-activedescendant');
}

function select(index, { scroll = true } = {}) {
  state.selected = index;
  state.selectedKey = state.rows[index] ? rowKey(state.rows[index]) : null;
  syncSelection({ scroll });
}

// =============================================================================================== actions

function openGroup(groupId) {
  state.groupId = groupId;
  state.query = '';
  $('q').value = '';
  render();
  const g = state.groups.find((x) => x.id === groupId);
  if (g) announce(`${g.title}, ${plural(g.count, 'tab')}`);
}

function leaveGroup() {
  state.groupId = null;
  state.query = '';
  $('q').value = '';
  render();
}

function choose(row) {
  if (!row) return;
  if (row.kind === 'group') openGroup(row.group.id);
  else activate(row.tab);
}

/** Switches to the tab and brings its window forward (restoring it if minimised). A tab closed in the meantime just disappears from the list. */
async function activate(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    const win = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(tab.windowId, win.state === 'minimized' ? { focused: true, state: 'normal' } : { focused: true });
  } catch {
    announce('That tab was closed.');
    await refresh();
    return;
  }
  window.close();
}

// =============================================================================================== events

function wire() {
  $('q').addEventListener('input', () => { state.query = $('q').value; render(); });
  $('q').addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = moveSelection(state.selected, e.key === 'ArrowDown' ? 1 : -1, state.rows.length);
      if (next >= 0) select(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(state.rows[state.selected]);
    } else if (e.key === 'Backspace' && !$('q').value && state.groupId) {
      e.preventDefault();
      leaveGroup();
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); window.close(); } });

  // Keep the lists current while the switcher is open (nothing listens when it is closed).
  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(() => refresh().catch(() => {}), 120); };
  chrome.tabs.onCreated.addListener(soon);
  chrome.tabs.onRemoved.addListener(soon);
  chrome.tabs.onMoved.addListener(soon);
  chrome.tabs.onAttached.addListener(soon);
  chrome.tabs.onDetached.addListener(soon);
  chrome.tabs.onUpdated.addListener((id, change) => { if (change.title !== undefined || change.url !== undefined || change.pinned !== undefined || change.favIconUrl !== undefined) soon(); });
  chrome.windows.onRemoved.addListener(soon);

  // Close when the person clicks away, like any quick switcher (not before it has been focused once).
  let wasFocused = document.hasFocus();
  window.addEventListener('focus', () => { wasFocused = true; $('q').focus(); });
  window.addEventListener('blur', () => { if (wasFocused) setTimeout(() => { if (!document.hasFocus()) window.close(); }, 150); });
}

load().then(() => {
  wire();
  render();
  $('q').focus();
}).catch((err) => {
  console.error('Tabfold Quick Switcher failed to start', err);
  $('empty').hidden = false;
  $('empty').textContent = 'Tabfold could not load your tabs. Try again.';
});
