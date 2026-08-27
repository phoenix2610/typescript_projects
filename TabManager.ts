// Browser Extension Tab Manager
//
// Groups open tabs by domain, filters them by a search query, "suspends"
// a tab (a discard, freeing its memory without closing it), and saves/
// restores a full session snapshot to localStorage. This runs as a plain
// page rather than an installed extension, so there's no real
// `chrome.tabs` API to call — the tab list below is an in-memory stand-in
// for it, but the grouping/search/suspend/session logic is the real thing
// an extension's background script would run against actual tabs.
//
// Usage:
//   const manager = createTabManager(seedTabs);
//   manager.groupsByDomain();
//   manager.saveSession();
//   manager.restoreSession();

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  suspended: boolean;
}

export interface DomainGroup {
  domain: string;
  tabs: TabInfo[];
}

export function groupByDomain(tabs: TabInfo[]): DomainGroup[] {
  const map = new Map<string, TabInfo[]>();
  for (const t of tabs) {
    const domain = new URL(t.url).hostname;
    const list = map.get(domain);
    if (list) list.push(t);
    else map.set(domain, [t]);
  }
  return [...map.entries()]
    .map(([domain, tabs]) => ({ domain, tabs }))
    .sort((a, b) => b.tabs.length - a.tabs.length || a.domain.localeCompare(b.domain));
}

export function searchTabs(tabs: TabInfo[], query: string): TabInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return tabs;
  return tabs.filter((t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q));
}

const SESSION_KEY = 'tab-manager-session';

export function createTabManager(initialTabs: TabInfo[]) {
  let tabs = initialTabs;
  const listeners = new Set<() => void>();

  function notify() {
    for (const l of listeners) l();
  }

  return {
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getTabs() {
      return tabs;
    },
    suspend(id: number) {
      tabs = tabs.map((t) => (t.id === id ? { ...t, suspended: true } : t));
      notify();
    },
    wake(id: number) {
      tabs = tabs.map((t) => (t.id === id ? { ...t, suspended: false } : t));
      notify();
    },
    close(id: number) {
      tabs = tabs.filter((t) => t.id !== id);
      notify();
    },
    saveSession() {
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(tabs));
      } catch {
        // ignore
      }
    },
    restoreSession(): boolean {
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return false;
        tabs = JSON.parse(raw) as TabInfo[];
        notify();
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---- Demo -----------------------------------------------------------------

const SEED_TABS: TabInfo[] = [
  { id: 1, title: 'my-repo: pull request #42', url: 'https://github.com/me/my-repo/pull/42', suspended: false },
  { id: 2, title: 'my-repo: issues', url: 'https://github.com/me/my-repo/issues', suspended: false },
  { id: 3, title: 'Q3 planning doc', url: 'https://docs.google.com/document/d/abc123', suspended: false },
  { id: 4, title: 'Show HN: I built a tab manager', url: 'https://news.ycombinator.com/item?id=1', suspended: true },
  { id: 5, title: 'Ask HN: best editor 2026?', url: 'https://news.ycombinator.com/item?id=2', suspended: false },
];

export function mount(root: HTMLElement) {
  root.innerHTML = '';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '16px';
  root.style.maxWidth = '360px';

  const manager = createTabManager(SEED_TABS);

  const searchInput = document.createElement('input');
  searchInput.setAttribute('aria-label', 'Search tabs');
  searchInput.setAttribute('data-testid', 'search-input');
  searchInput.placeholder = 'Search tabs…';
  searchInput.style.width = '100%';
  searchInput.style.marginBottom = '8px';

  const controls = document.createElement('div');
  controls.style.marginBottom = '8px';
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save session';
  saveBtn.setAttribute('data-testid', 'save-session');
  const restoreBtn = document.createElement('button');
  restoreBtn.textContent = 'Restore session';
  restoreBtn.setAttribute('data-testid', 'restore-session');
  restoreBtn.style.marginLeft = '6px';
  controls.append(saveBtn, restoreBtn);

  const groupsEl = document.createElement('div');
  groupsEl.setAttribute('data-testid', 'groups');
  groupsEl.style.fontSize = '13px';

  function render() {
    const query = searchInput.value;
    const filtered = searchTabs(manager.getTabs(), query);
    const groups = groupByDomain(filtered);

    groupsEl.innerHTML = '';
    for (const group of groups) {
      const groupEl = document.createElement('div');
      groupEl.setAttribute('data-testid', 'domain-group');
      groupEl.setAttribute('data-domain', group.domain);
      groupEl.style.marginBottom = '8px';

      const header = document.createElement('div');
      header.style.fontWeight = '600';
      header.style.opacity = '0.8';
      header.textContent = `${group.domain} (${group.tabs.length})`;
      groupEl.appendChild(header);

      for (const tab of group.tabs) {
        const row = document.createElement('div');
        row.setAttribute('data-testid', 'tab-row');
        row.setAttribute('data-tab-id', String(tab.id));
        row.setAttribute('data-suspended', String(tab.suspended));
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.padding = '2px 0';
        row.style.opacity = tab.suspended ? '0.5' : '1';

        const title = document.createElement('span');
        title.textContent = tab.title;
        title.style.overflow = 'hidden';
        title.style.textOverflow = 'ellipsis';
        title.style.whiteSpace = 'nowrap';

        const actions = document.createElement('span');
        const toggleBtn = document.createElement('button');
        toggleBtn.textContent = tab.suspended ? 'Wake' : 'Suspend';
        toggleBtn.setAttribute('data-testid', 'toggle-suspend');
        toggleBtn.style.fontSize = '11px';
        toggleBtn.addEventListener('click', () => (tab.suspended ? manager.wake(tab.id) : manager.suspend(tab.id)));

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.setAttribute('data-testid', 'close-tab');
        closeBtn.style.fontSize = '11px';
        closeBtn.style.marginLeft = '4px';
        closeBtn.addEventListener('click', () => manager.close(tab.id));

        actions.append(toggleBtn, closeBtn);
        row.append(title, actions);
        groupEl.appendChild(row);
      }
      groupsEl.appendChild(groupEl);
    }
  }

  searchInput.addEventListener('input', render);
  saveBtn.addEventListener('click', () => manager.saveSession());
  restoreBtn.addEventListener('click', () => manager.restoreSession());
  manager.subscribe(render);

  root.append(searchInput, controls, groupsEl);
  render();
}

export default mount;
