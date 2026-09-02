// Mini Virtual DOM Diff Engine
//
// Keyed list reconciliation: given an old and a new array of keyed items,
// compute a patch list (REMOVE / INSERT / MOVE / UPDATE) and apply it to a
// real DOM parent. The move set is minimized with the same trick real
// frameworks use — the longest increasing subsequence of old-indices, in
// new order, is the run of items that can stay exactly where they are;
// everything else outside that subsequence gets a MOVE. DOM positioning
// itself is done back-to-front with a running "anchor" node, which is what
// makes `insertBefore` correct without needing the moves to be applied in
// any particular order relative to each other.
//
// Usage:
//   const ops = diffKeyedList(oldItems, newItems);
//   applyKeyedList(ulElement, newItems, ops, domMap);
//
// `mount(root)` wires this into a small interactive demo with a visible
// patch-list readout.

export type Key = string | number;

export interface ListItem {
  key: Key;
  tag: string;
  text: string;
  props: Record<string, string>;
}

export type ChildOp =
  | { op: 'REMOVE'; key: Key }
  | { op: 'INSERT'; key: Key; item: ListItem; beforeKey: Key | null }
  | { op: 'MOVE'; key: Key; beforeKey: Key | null }
  | { op: 'UPDATE'; key: Key; text: string; props: Record<string, string> };

function shallowEqualProps(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

// Returns indices INTO `seq` forming a longest strictly-increasing
// subsequence, via patience sorting (O(n log n)).
function longestIncreasingSubsequenceIndices(seq: number[]): number[] {
  const predecessors = new Array(seq.length).fill(-1);
  const tails: number[] = []; // tails[k] = index in seq of the smallest possible tail for length k+1
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) predecessors[i] = tails[lo - 1];
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }
  const result: number[] = [];
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k !== -1) {
    result.push(k);
    k = predecessors[k];
  }
  return result.reverse();
}

export function diffKeyedList(oldItems: ListItem[], newItems: ListItem[]): ChildOp[] {
  const ops: ChildOp[] = [];
  const oldIndexByKey = new Map(oldItems.map((it, i) => [it.key, i]));
  const oldByKey = new Map(oldItems.map((it) => [it.key, it]));
  const newKeySet = new Set(newItems.map((it) => it.key));

  for (const it of oldItems) {
    if (!newKeySet.has(it.key)) ops.push({ op: 'REMOVE', key: it.key });
  }

  // Old-index sequence of the kept items, in NEW order — the LIS of this
  // sequence is the subset that needs no move at all.
  const keptOldIdxSeq: number[] = [];
  const keptNewPos: number[] = [];
  newItems.forEach((it, pos) => {
    const oldIdx = oldIndexByKey.get(it.key);
    if (oldIdx !== undefined) {
      keptOldIdxSeq.push(oldIdx);
      keptNewPos.push(pos);
    }
  });
  const lis = longestIncreasingSubsequenceIndices(keptOldIdxSeq);
  const staysPut = new Set(lis.map((i) => keptNewPos[i]));

  newItems.forEach((it, pos) => {
    const beforeKey = pos + 1 < newItems.length ? newItems[pos + 1].key : null;
    const existedBefore = oldIndexByKey.has(it.key);
    if (!existedBefore) {
      ops.push({ op: 'INSERT', key: it.key, item: it, beforeKey });
    } else if (!staysPut.has(pos)) {
      ops.push({ op: 'MOVE', key: it.key, beforeKey });
    }
    if (existedBefore) {
      const old = oldByKey.get(it.key)!;
      if (old.text !== it.text || !shallowEqualProps(old.props, it.props)) {
        ops.push({ op: 'UPDATE', key: it.key, text: it.text, props: it.props });
      }
    }
  });

  return ops;
}

function createItemDom(item: ListItem): HTMLElement {
  const el = document.createElement(item.tag);
  el.textContent = item.text;
  el.setAttribute('data-key', String(item.key));
  el.setAttribute('data-testid', 'list-item');
  for (const [k, v] of Object.entries(item.props)) el.setAttribute(k, v);
  return el;
}

function updateItemDom(el: HTMLElement, item: ListItem) {
  if (el.textContent !== item.text) el.textContent = item.text;
  const current = Array.from(el.attributes)
    .map((a) => a.name)
    .filter((n) => n !== 'data-key' && n !== 'data-testid');
  for (const name of current) if (!(name in item.props)) el.removeAttribute(name);
  for (const [k, v] of Object.entries(item.props)) if (el.getAttribute(k) !== v) el.setAttribute(k, v);
}

// Applies the diff to real DOM. Positioning is recomputed back-to-front
// with a running anchor rather than by literally replaying MOVE ops in
// order — that avoids any ordering hazard between moves, since each node
// is placed relative to a sibling that is already in its final spot.
export function applyKeyedList(
  parentDom: HTMLElement,
  newItems: ListItem[],
  ops: ChildOp[],
  domMap: Map<Key, HTMLElement>,
) {
  for (const op of ops) {
    if (op.op === 'REMOVE') {
      const node = domMap.get(op.key);
      if (node) parentDom.removeChild(node);
      domMap.delete(op.key);
    }
  }

  const updateByKey = new Map(
    ops.filter((o): o is Extract<ChildOp, { op: 'UPDATE' }> => o.op === 'UPDATE').map((o) => [o.key, o]),
  );

  let anchor: Node | null = null;
  for (let i = newItems.length - 1; i >= 0; i--) {
    const it = newItems[i];
    let node = domMap.get(it.key);
    const isNew = !node;
    if (!node) {
      node = createItemDom(it);
      domMap.set(it.key, node);
    } else if (updateByKey.has(it.key)) {
      updateItemDom(node, it);
    }
    // A brand-new node is always detached (nextSibling is always null),
    // which can spuriously equal a null anchor — so newly created nodes
    // must always be inserted, not just when the position looks stale.
    const alreadyPositioned = !isNew && node.parentNode === parentDom && node.nextSibling === anchor;
    if (!alreadyPositioned) parentDom.insertBefore(node, anchor);
    anchor = node;
  }
}

function formatOp(op: ChildOp): string {
  if (op.op === 'REMOVE') return `REMOVE ${op.key}`;
  if (op.op === 'INSERT') return `INSERT ${op.key} before ${op.beforeKey ?? 'end'}`;
  if (op.op === 'MOVE') return `MOVE ${op.key} before ${op.beforeKey ?? 'end'}`;
  return `UPDATE ${op.key} text="${op.text}"`;
}

// ---- Demo ---------------------------------------------------------------

export function mount(root: HTMLElement) {
  root.innerHTML = '';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '16px';

  let items: ListItem[] = [
    { key: 'a', tag: 'li', text: 'Apple', props: {} },
    { key: 'b', tag: 'li', text: 'Banana', props: {} },
    { key: 'c', tag: 'li', text: 'Cherry', props: {} },
    { key: 'd', tag: 'li', text: 'Date', props: {} },
    { key: 'e', tag: 'li', text: 'Elderberry', props: {} },
  ];
  const domMap = new Map<Key, HTMLElement>();

  const controls = document.createElement('div');
  controls.style.display = 'flex';
  controls.style.gap = '6px';
  controls.style.marginBottom = '12px';
  controls.style.flexWrap = 'wrap';

  const list = document.createElement('ul');
  list.setAttribute('data-testid', 'item-list');
  list.style.fontFamily = 'monospace';
  list.style.fontSize = '13px';

  const log = document.createElement('pre');
  log.setAttribute('data-testid', 'patch-log');
  log.style.fontSize = '12px';
  log.style.background = '#161b22';
  log.style.padding = '8px';
  log.style.marginTop = '12px';
  log.style.minHeight = '20px';

  // Initial mount: every item is an INSERT.
  const firstOps = diffKeyedList([], items);
  applyKeyedList(list, items, firstOps, domMap);
  log.textContent = firstOps.map(formatOp).join('\n');

  function update(next: ListItem[]) {
    const ops = diffKeyedList(items, next);
    applyKeyedList(list, next, ops, domMap);
    items = next;
    log.textContent = ops.length ? ops.map(formatOp).join('\n') : '(no changes)';
  }

  function button(label: string, onClick: () => void) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    controls.appendChild(btn);
  }

  button('Reverse', () => update([...items].reverse()));
  button('Rotate (move first to end)', () => update([...items.slice(1), items[0]]));
  button('Remove Banana', () => update(items.filter((it) => it.key !== 'b')));
  button('Add Fig', () => {
    if (items.some((it) => it.key === 'f')) return;
    update([...items, { key: 'f', tag: 'li', text: 'Fig', props: {} }]);
  });
  button('Rename Cherry', () =>
    update(items.map((it) => (it.key === 'c' ? { ...it, text: 'Cherry (ripe)' } : it))),
  );
  button('Reset', () =>
    update([
      { key: 'a', tag: 'li', text: 'Apple', props: {} },
      { key: 'b', tag: 'li', text: 'Banana', props: {} },
      { key: 'c', tag: 'li', text: 'Cherry', props: {} },
      { key: 'd', tag: 'li', text: 'Date', props: {} },
      { key: 'e', tag: 'li', text: 'Elderberry', props: {} },
    ]),
  );

  root.appendChild(controls);
  root.appendChild(list);
  root.appendChild(log);
}

export default mount;
