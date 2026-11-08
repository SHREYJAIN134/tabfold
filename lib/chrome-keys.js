// What Chrome itself does with a key, so Tabfold can say what a launcher key REPLACES and where that Chrome action lives now.
// Pure data and functions. Windows/Linux key names. This is knowledge, not control: Chrome gives extensions no way to rebind its
// own shortcuts (or another extension's), so Tabfold can only explain; the actual assignment is always made in Chrome.
//
// Priority rule (confirmed in a real Chrome 156 test): once Chrome has assigned a key to a Tabfold launcher, the launcher
// receives it INSTEAD of Chrome's built-in action. The exceptions are RESERVED keys, which Chrome never lets an extension take.

/** "Ctrl + g" -> "ctrl+g": for comparing what Chrome reports with what a person typed. */
export function normalizeKey(key) {
  return String(key || '').toLowerCase().replace(/\s+/g, '').replace(/^command\+/, 'cmd+').replace(/\+command\+/g, '+cmd+');
}

/** Keys Chrome refuses to give to extensions. */
export const RESERVED = Object.freeze({
  'ctrl+n': 'New window', 'ctrl+shift+n': 'New incognito window', 'ctrl+t': 'New tab', 'ctrl+shift+t': 'Reopen closed tab',
  'ctrl+w': 'Close tab', 'ctrl+shift+w': 'Close window', 'ctrl+tab': 'Next tab', 'ctrl+shift+tab': 'Previous tab', 'alt+f4': 'Close the window',
});

/** Built-in Chrome shortcuts a launcher key would replace, with the other keys that do the same job (empty = the ⋮ menu only). */
export const BUILT_IN = Object.freeze({
  'ctrl+g': { action: 'Find Next', alternates: ['F3'] },
  'cmd+g': { action: 'Find Next', alternates: [] },
  'ctrl+shift+g': { action: 'Find Previous', alternates: ['Shift+F3'] },
  'ctrl+r': { action: 'Reload', alternates: ['F5'] },
  'ctrl+shift+r': { action: 'Hard reload', alternates: ['Ctrl+F5', 'Shift+F5'] },
  'ctrl+l': { action: 'Focus the address bar', alternates: ['Alt+D', 'F6'] },
  'ctrl+e': { action: 'Search from the address bar', alternates: ['Ctrl+K'] },
  'ctrl+k': { action: 'Search from the address bar', alternates: ['Ctrl+E'] },
  'ctrl+shift+i': { action: 'Open DevTools', alternates: ['F12'] },
  'ctrl+f': { action: 'Find in page', alternates: [] },
  'ctrl+h': { action: 'History', alternates: [] },
  'ctrl+j': { action: 'Downloads', alternates: [] },
  'ctrl+d': { action: 'Bookmark this page', alternates: [] },
  'ctrl+p': { action: 'Print', alternates: [] },
  'ctrl+s': { action: 'Save page', alternates: [] },
  'ctrl+o': { action: 'Open a file', alternates: [] },
  'ctrl+u': { action: 'View page source', alternates: [] },
  'ctrl+shift+b': { action: 'Show or hide the bookmarks bar', alternates: [] },
  'ctrl+shift+delete': { action: 'Clear browsing data', alternates: [] },
});

/**
 * null when Chrome does nothing with this key, else
 *   { kind: 'reserved', action }                        Chrome keeps it: an extension cannot use it
 *   { kind: 'builtin', action, alternates: [...] }      Tabfold takes priority once Chrome assigns it
 */
export function chromeKeyInfo(key) {
  const k = normalizeKey(key);
  if (!k) return null;
  if (RESERVED[k]) return { kind: 'reserved', action: RESERVED[k], alternates: [] };
  if (BUILT_IN[k]) return { kind: 'builtin', ...BUILT_IN[k] };
  return null;
}

const list = (keys) => keys.join(' or ');

/** The sentence(s) telling the user what a key replaces in Chrome and where that Chrome action is now. `label` is "Tabfold launcher 02". */
export function conflictNote(key, label, { holds = false } = {}) {
  const info = chromeKeyInfo(key);
  if (!info) return null;
  if (info.kind === 'reserved') {
    return `Chrome keeps ${key} for itself (${info.action}), so no extension can use it. Pick a different key for “${label}”, for example Alt+Shift+G.`;
  }
  const where = info.alternates.length
    ? `${info.action} keeps working on ${list(info.alternates)}`
    : `Chrome has no second key for ${info.action}; it stays in Chrome's menu (the three dots)`;
  return holds
    ? `${key} is Tabfold's now: it takes priority over Chrome's ${info.action}. ${where}.`
    : `${key} is also Chrome's ${info.action}. Once Chrome assigns it to “${label}” Tabfold takes priority, and Chrome's ${info.action} stops responding to ${key}; ${where}.`;
}
