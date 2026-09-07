// Client Router with Nested Routes
//
// Path params (`:id`), nested outlets (a parent route renders its own
// chrome plus a `[data-outlet]` slot where the matched child route
// mounts), lazy-loaded route components (shown as a loading state while
// pending), and scroll-position restore on back/forward, keyed to each
// history entry rather than the URL (so two visits to the same path keep
// separate scroll positions).
//
// This deliberately runs as an in-memory router — its own history stack,
// not `window.history` — rather than a real one bound to the browser's
// address bar. A single-file demo embedded inside a harness page doesn't
// own the real URL, and calling `history.pushState` here would rewrite the
// host page's own address, which is exactly the kind of side effect a
// router embedded in someone else's app must not have. `back()`/
// `forward()` are exposed directly instead of listening for `popstate`.
//
// Usage:
//   const router = createRouter(routes, outletEl, scrollEl);
//   router.navigate('/users/42');
//   router.back();
//
// `mount(root)` wires up a small demo app.

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

export interface Route {
  path: string; // static segment or ':param'
  component: (params: Record<string, string>) => HTMLElement | Promise<HTMLElement>;
  children?: Route[];
}

function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function resolvePath(
  routes: Route[],
  segments: string[],
  parentParams: Record<string, string>,
): RouteMatch[] | null {
  for (const route of routes) {
    const routeSegs = pathSegments(route.path);
    if (routeSegs.length > segments.length) continue;

    const localParams: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < routeSegs.length; i++) {
      const rs = routeSegs[i];
      const as = segments[i];
      if (rs.startsWith(':')) localParams[rs.slice(1)] = as;
      else if (rs !== as) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    const merged = { ...parentParams, ...localParams };
    const remaining = segments.slice(routeSegs.length);

    if (remaining.length === 0) {
      if (route.children) {
        const indexMatch = resolvePath(route.children, [], merged);
        return [{ route, params: merged }, ...(indexMatch ?? [])];
      }
      return [{ route, params: merged }];
    }
    if (route.children) {
      const childMatch = resolvePath(route.children, remaining, merged);
      if (childMatch) return [{ route, params: merged }, ...childMatch];
    }
  }
  return null;
}

async function renderChain(chain: RouteMatch[], rootContainer: HTMLElement) {
  let container = rootContainer;
  for (const { route, params } of chain) {
    container.innerHTML = '';
    const loading = document.createElement('div');
    loading.setAttribute('data-testid', 'route-loading');
    loading.textContent = 'Loading…';
    container.appendChild(loading);

    const result = await route.component(params);

    container.innerHTML = '';
    container.appendChild(result);
    const outlet = result.querySelector('[data-outlet]') as HTMLElement | null;
    if (!outlet) break;
    container = outlet;
  }
}

interface HistoryEntry {
  path: string;
  id: number;
}

export function createRouter(routes: Route[], outletContainer: HTMLElement, scrollContainer: HTMLElement, initialPath = '/') {
  let entries: HistoryEntry[] = [{ path: initialPath, id: 0 }];
  let index = 0;
  let nextId = 1;
  const scrollPositions = new Map<number, number>();

  async function render() {
    const segments = pathSegments(entries[index].path);
    const match = resolvePath(routes, segments, {});
    if (!match) {
      outletContainer.innerHTML = '';
      const notFound = document.createElement('div');
      notFound.setAttribute('data-testid', 'not-found');
      notFound.textContent = '404 Not Found';
      outletContainer.appendChild(notFound);
      return;
    }
    await renderChain(match, outletContainer);
  }

  function navigate(path: string) {
    scrollPositions.set(entries[index].id, scrollContainer.scrollTop);
    entries = [...entries.slice(0, index + 1), { path, id: nextId++ }];
    index = entries.length - 1;
    scrollContainer.scrollTop = 0;
    void render();
  }

  async function back() {
    if (index === 0) return;
    scrollPositions.set(entries[index].id, scrollContainer.scrollTop);
    index -= 1;
    await render();
    scrollContainer.scrollTop = scrollPositions.get(entries[index].id) ?? 0;
  }

  async function forward() {
    if (index === entries.length - 1) return;
    scrollPositions.set(entries[index].id, scrollContainer.scrollTop);
    index += 1;
    await render();
    scrollContainer.scrollTop = scrollPositions.get(entries[index].id) ?? 0;
  }

  void render();

  return {
    navigate,
    back,
    forward,
    get currentPath() {
      return entries[index].path;
    },
    get canGoBack() {
      return index > 0;
    },
    get canGoForward() {
      return index < entries.length - 1;
    },
  };
}

// ---- Demo ---------------------------------------------------------------

function homeComponent(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-testid', 'home-page');
  const lines = Array.from({ length: 15 }, (_, i) => `<p>Home content line ${i + 1}, tall enough to make this route scrollable.</p>`);
  el.innerHTML = `<h3>Home</h3>${lines.join('')}`;
  return el;
}

function usersLayoutComponent(): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = `
    <h3>Users</h3>
    <nav>${['1', '2'].map((id) => `<a href="/users/${id}" data-link data-testid="user-link-${id}">User ${id}</a>`).join(' · ')}</nav>
    <div data-outlet data-testid="users-outlet" style="border-top:1px solid #333;margin-top:8px;padding-top:8px;"></div>
  `;
  return el;
}

function usersIndexComponent(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-testid', 'users-index');
  el.textContent = 'Select a user above.';
  return el;
}

function userDetailComponent(params: Record<string, string>): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-testid', 'user-detail');
  el.innerHTML = `
    <p data-testid="user-id">User #${params.id}</p>
    <a href="/users/${params.id}/posts" data-link data-testid="posts-link">View posts</a>
    <div data-outlet data-testid="user-detail-outlet" style="margin-top:8px;"></div>
  `;
  return el;
}

async function userPostsComponent(params: Record<string, string>): Promise<HTMLElement> {
  await new Promise((r) => setTimeout(r, 350)); // simulated lazy-loaded chunk
  const el = document.createElement('div');
  el.setAttribute('data-testid', 'user-posts');
  el.textContent = `Posts by user #${params.id}: "Hello world", "Second post"`;
  return el;
}

const routes: Route[] = [
  { path: '', component: () => homeComponent() },
  {
    path: 'users',
    component: () => usersLayoutComponent(),
    children: [
      { path: '', component: () => usersIndexComponent() },
      {
        path: ':id',
        component: (params) => userDetailComponent(params),
        children: [{ path: 'posts', component: userPostsComponent }],
      },
    ],
  },
];

export function mount(root: HTMLElement) {
  root.innerHTML = '';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '16px';

  const nav = document.createElement('div');
  nav.style.marginBottom = '8px';
  nav.innerHTML = `
    <button data-testid="back-btn">← Back</button>
    <button data-testid="forward-btn">Forward →</button>
    <a href="/" data-link data-testid="nav-home" style="margin-left:12px;">Home</a>
    <a href="/users" data-link data-testid="nav-users" style="margin-left:8px;">Users</a>
    <span data-testid="current-path" style="margin-left:12px;opacity:0.6;font-size:12px;"></span>
  `;

  const scrollContainer = document.createElement('div');
  scrollContainer.setAttribute('data-testid', 'route-container');
  scrollContainer.style.height = '160px';
  scrollContainer.style.overflowY = 'auto';
  scrollContainer.style.border = '1px solid #333';
  scrollContainer.style.padding = '8px';

  root.appendChild(nav);
  root.appendChild(scrollContainer);

  const router = createRouter(routes, scrollContainer, scrollContainer, '/');

  function refreshChrome() {
    nav.querySelector('[data-testid="current-path"]')!.textContent = router.currentPath;
    (nav.querySelector('[data-testid="back-btn"]') as HTMLButtonElement).disabled = !router.canGoBack;
    (nav.querySelector('[data-testid="forward-btn"]') as HTMLButtonElement).disabled = !router.canGoForward;
  }

  nav.querySelector('[data-testid="back-btn"]')!.addEventListener('click', async () => {
    await router.back();
    refreshChrome();
  });
  nav.querySelector('[data-testid="forward-btn"]')!.addEventListener('click', async () => {
    await router.forward();
    refreshChrome();
  });

  root.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest('[data-link]') as HTMLAnchorElement | null;
    if (link) {
      e.preventDefault();
      router.navigate(link.getAttribute('href')!);
      refreshChrome();
    }
  });

  refreshChrome();
}

export default mount;
