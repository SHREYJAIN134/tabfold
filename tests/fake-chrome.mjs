// A small in-memory stand-in for the parts of `chrome.*` that Tabfold's background code uses (windows, tabs, tab groups,
// storage, commands). It follows Chrome's documented behaviour closely enough to test grouping and launching logic;
// the REAL browser behaviour is checked separately by tests/e2e-chrome.mjs.

export function createFakeChrome() {
  let nextTab = 100;
  let nextGroup = 500;
  const state = { windows: [], tabs: [], groups: [], updateLog: [], forcedSwitches: [], focusedWindow: null, store: { local: {}, session: {} }, listeners: {} };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  const storageArea = (area) => ({
    async get(keys) {
      const data = state.store[area];
      if (keys == null) return clone(data);
      if (typeof keys === 'string') return keys in data ? { [keys]: clone(data[keys]) } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, clone(data[k])]));
      return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? clone(data[k]) : d]));
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: clone(state.store[area][k]), newValue: clone(v) }; state.store[area][k] = clone(v); }
      if (area === 'local') for (const fn of state.listeners.storageChanged || []) fn(changes, 'local');
    },
    async remove(keys) { for (const k of [].concat(keys)) delete state.store[area][k]; },
  });

  const event = (name) => ({ addListener: (fn) => { (state.listeners[name] ||= []).push(fn); } });
  const emit = (name, ...args) => Promise.all((state.listeners[name] || []).map((fn) => fn(...args)));

  const findTab = (id) => state.tabs.find((t) => t.id === id);
  const view = (t) => ({ ...t });
  const groupView = (g) => ({ ...g });

  const api = {
    windows: {
      WINDOW_ID_NONE: -1,
      async get(id) { const w = state.windows.find((x) => x.id === id); if (!w) throw new Error(`No window with id: ${id}.`); return { ...w }; },
      async getAll({ populate = false, windowTypes } = {}) {
        return state.windows.filter((w) => !windowTypes || windowTypes.includes(w.type)).map((w) => ({ ...w, ...(populate ? { tabs: state.tabs.filter((t) => t.windowId === w.id).map(view) } : {}) }));
      },
      async getLastFocused({ windowTypes } = {}) {
        const w = state.windows.find((x) => x.id === state.focusedWindow && (!windowTypes || windowTypes.includes(x.type)));
        if (!w) throw new Error('No focused window');
        return { ...w };
      },
      async create({ url }) { const w = helpers.addWindow(); const tab = helpers.addTab(w.id, url); return { ...w, tabs: [view(tab)] }; },
      async update(id, props) { if (props.focused) state.focusedWindow = id; return { id }; },
    },
    tabs: {
      TAB_ID_NONE: -1,
      async get(id) { const t = findTab(id); if (!t) throw new Error(`No tab with id: ${id}.`); return view(t); },
      async query({ windowType, active, windowId, groupId } = {}) {
        return state.tabs.filter((t) => (!windowType || state.windows.find((w) => w.id === t.windowId).type === windowType)
          && (active === undefined || t.active === active) && (windowId === undefined || t.windowId === windowId) && (groupId === undefined || t.groupId === groupId)).map(view);
      },
      async create({ windowId, url, active = true }) {
        const tab = helpers.addTab(windowId, url, { active });
        if (active) { for (const o of state.tabs.filter((x) => x.windowId === windowId && x !== tab)) o.active = false; }
        await emit('tabCreated', view(tab));
        if (active) await emit('tabActivated', { tabId: tab.id, windowId });
        return view(tab);
      },
      async update(id, props) {
        const t = findTab(id);
        if (props.active) { for (const o of state.tabs.filter((x) => x.windowId === t.windowId)) o.active = false; t.active = true; await emit('tabActivated', { tabId: id, windowId: t.windowId }); }
        return view(t);
      },
      async group({ tabIds, groupId, createProperties }) {
        const ids = [].concat(tabIds);
        let gid = groupId;
        if (gid == null) {
          gid = nextGroup++;
          state.groups.push({ id: gid, windowId: createProperties?.windowId ?? findTab(ids[0]).windowId, title: '', color: 'grey', collapsed: false });
        } else if (!state.groups.find((g) => g.id === gid)) throw new Error(`No group with id: ${gid}.`);
        for (const id of ids) { const t = findTab(id); if (!t) throw new Error(`No tab with id: ${id}.`); if (t.pinned) throw new Error('Cannot group a pinned tab.'); t.groupId = gid; t.windowId = state.groups.find((g) => g.id === gid).windowId; }
        helpers.dropEmptyGroups();
        for (const id of ids) await emit('tabUpdated', id, { groupId: gid }, view(findTab(id)));
        return gid;
      },
      onCreated: event('tabCreated'), onActivated: event('tabActivated'), onUpdated: event('tabUpdated'), onAttached: event('tabAttached'), onRemoved: event('tabRemoved'),
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async get(id) { const g = state.groups.find((x) => x.id === id); if (!g) throw new Error(`No group with id: ${id}.`); return groupView(g); },
      async query({ windowId } = {}) { return state.groups.filter((g) => windowId == null || g.windowId === windowId).map(groupView); },
      async update(id, props) {
        const g = state.groups.find((x) => x.id === id);
        if (!g) throw new Error(`No group with id: ${id}.`);
        state.updateLog.push({ id, ...props });
        if (props.collapsed === true) {
          const active = state.tabs.find((t) => t.windowId === g.windowId && t.active);
          if (active && active.groupId === id) { state.forcedSwitches.push({ group: id, tab: active.id }); const other = state.tabs.find((t) => t.windowId === g.windowId && t.groupId !== id); if (other) { active.active = false; other.active = true; } }
        }
        Object.assign(g, props);
        return groupView(g);
      },
    },
    storage: { local: storageArea('local'), session: storageArea('session'), onChanged: event('storageChanged') },
    commands: { onCommand: event('command'), async getAll() { return []; } },
    runtime: { onInstalled: event('installed') },
  };

  const helpers = {
    addWindow(type = 'normal') { const w = { id: state.windows.length + 1, type, focused: false }; state.windows.push(w); if (state.focusedWindow == null && type === 'normal') state.focusedWindow = w.id; return w; },
    addTab(windowId, url, { pinned = false, groupId = -1, active = false } = {}) {
      const tab = { id: nextTab++, windowId, url, pendingUrl: undefined, pinned, groupId, active, index: state.tabs.filter((t) => t.windowId === windowId).length };
      state.tabs.push(tab);
      return tab;
    },
    /** What a user would do: create a group of their own. */
    addUserGroup(windowId, title, color, tabIds) {
      const g = { id: nextGroup++, windowId, title, color, collapsed: false };
      state.groups.push(g);
      for (const id of tabIds) findTab(id).groupId = g.id;
      return g;
    },
    async navigate(tabId, url) { const t = findTab(tabId); t.url = url; await emit('tabUpdated', tabId, { url }, view(t)); },
    removeTab(id) { state.tabs = state.tabs.filter((t) => t.id !== id); helpers.dropEmptyGroups(); },
    dropEmptyGroups() { state.groups = state.groups.filter((g) => state.tabs.some((t) => t.groupId === g.id)); },
    collapsedIn(windowId) { return Object.fromEntries(state.groups.filter((g) => g.windowId === windowId).map((g) => [g.title, g.collapsed])); },
    groupsIn(windowId) { return state.groups.filter((g) => g.windowId === windowId).map((g) => ({ ...g, tabs: state.tabs.filter((t) => t.groupId === g.id).map((t) => t.url) })); },
    emit,
  };
  return { chrome: api, state, helpers };
}

/** Lets queued promise work (the grouping queue) finish. */
export const settle = async (ms = 30) => { await new Promise((r) => setTimeout(r, ms)); };
