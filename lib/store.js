// Launchers and preferences, saved locally in chrome.storage.local (they survive Chrome restarts, never leave the device).
//
// How shortcuts work in Chrome: an extension cannot choose its own keys. It declares commands in the manifest and the
// USER assigns keys at chrome://extensions/shortcuts. So Tabfold ships 12 launcher commands (launch-01 ... launch-12)
// and remembers, per command, which website it should open. The key itself is always read back from
// chrome.commands.getAll(); nothing here claims a key is active.

export const SLOT_COUNT = 12;
export const slotCommand = (n) => `launch-${String(n).padStart(2, '0')}`;
export const slotNumber = (command) => { const m = /^launch-(\d{2})$/.exec(command || ''); const n = m ? Number(m[1]) : 0; return n >= 1 && n <= SLOT_COUNT ? n : 0; };
/** The same text is the command's description in the manifest, so the name matches in Tabfold and in Chrome's shortcuts page. */
export const slotLabel = (command) => `Tabfold launcher ${String(slotNumber(command)).padStart(2, '0')}`;
export const ALL_COMMANDS = Array.from({ length: SLOT_COUNT }, (_, i) => slotCommand(i + 1));

export const SHORTCUTS_PAGE = 'chrome://extensions/shortcuts';

const DEFAULTS = { autoGroup: true, collapseInactive: true };
export const DEFAULT_LAUNCHER = { command: 'launch-01', name: 'YouTube', url: 'https://www.youtube.com/' };

const clean = (l) => (l && typeof l.url === 'string' && typeof l.name === 'string'
  ? { name: l.name.slice(0, 60), url: l.url, ...(typeof l.wantedKey === 'string' && l.wantedKey ? { wantedKey: l.wantedKey.slice(0, 40) } : {}) }
  : null);

/** { 'launch-01': { name, url, wantedKey? }, ... } with only well-formed entries for known slots. */
export async function getLaunchers(storage = chrome.storage.local) {
  const { launchers } = await storage.get('launchers');
  const out = {};
  if (launchers && typeof launchers === 'object') for (const cmd of ALL_COMMANDS) { const l = clean(launchers[cmd]); if (l) out[cmd] = l; }
  return out;
}

export async function saveLauncher(command, launcher, storage = chrome.storage.local) {
  if (!slotNumber(command)) throw new Error(`Unknown launcher slot: ${command}`);
  const all = await getLaunchers(storage);
  all[command] = clean(launcher);
  await storage.set({ launchers: all });
  return all;
}

export async function deleteLauncher(command, storage = chrome.storage.local) {
  const all = await getLaunchers(storage);
  delete all[command];
  await storage.set({ launchers: all });
  return all;
}

/** Both switches are ON unless the user switched them off; anything missing or malformed in storage means "on". */
export async function getSettings(storage = chrome.storage.local) {
  const { settings } = await storage.get('settings');
  const s = settings && typeof settings === 'object' ? settings : {};
  return { autoGroup: s.autoGroup !== false, collapseInactive: s.collapseInactive !== false };
}

export async function setSetting(key, value, storage = chrome.storage.local) {
  const next = { ...(await getSettings(storage)), [key]: value };
  await storage.set({ settings: next });
  return next;
}

/** First launch only: YouTube in slot 01. The flag stops a later update from bringing back a launcher the user deleted. */
export async function seedDefaults(storage = chrome.storage.local) {
  const { seeded } = await storage.get('seeded');
  if (seeded) return false;
  const existing = await getLaunchers(storage);
  if (!Object.keys(existing).length) await storage.set({ launchers: { [DEFAULT_LAUNCHER.command]: { name: DEFAULT_LAUNCHER.name, url: DEFAULT_LAUNCHER.url } } });
  await storage.set({ seeded: true });
  return true;
}

/**
 * Commands Tabfold has actually RECEIVED from Chrome, with the key Chrome reported at that moment:
 * { 'launch-02': { shortcut: 'Ctrl+G', at: 1730000000000 } }. This is what "Verified" means; nothing else sets it.
 */
export async function getVerified(storage = chrome.storage.local) {
  const { verified } = await storage.get('verified');
  const out = {};
  if (verified && typeof verified === 'object') for (const cmd of ALL_COMMANDS) { const v = verified[cmd]; if (v && typeof v.shortcut === 'string' && Number.isFinite(v.at)) out[cmd] = { shortcut: v.shortcut, at: v.at }; }
  return out;
}
export async function recordVerified(command, shortcut, storage = chrome.storage.local, now = Date.now()) {
  if (!slotNumber(command)) return;
  const all = await getVerified(storage);
  all[command] = { shortcut: String(shortcut || ''), at: now };
  await storage.set({ verified: all });
}

/** The slot that was just saved and still needs a key (remembered so the hint survives closing the popup). */
export async function getPendingAssign(storage = chrome.storage.local) {
  const { pendingAssign } = await storage.get('pendingAssign');
  return slotNumber(pendingAssign) ? pendingAssign : null;
}
export async function setPendingAssign(command, storage = chrome.storage.local) {
  if (command) await storage.set({ pendingAssign: command }); else await storage.remove('pendingAssign');
}
