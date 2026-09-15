// Drag-Resize Split Panes
//
// A recursive pane tree (so panes can nest — a horizontal split whose right
// side is itself a vertical split), resized by dragging a divider with
// pointer capture (so a fast drag that outruns the cursor past the divider's
// own bounds keeps working, since the pointer stays "captured" by the
// divider element regardless of what's under the cursor). Each divider
// clamps to both panes' minimum sizes, and its ratio is persisted to
// localStorage keyed by the split's id, restored on the next mount.
//
// Usage:
//   mount(document.getElementById('app'));
//
// The pane tree, ids and min sizes are defined in the demo spec below;
// `buildPane` is exported for reuse with a different spec.

export type PaneSpec =
  | { type: 'leaf'; id: string; label: string }
  | {
      type: 'split';
      id: string;
      direction: 'horizontal' | 'vertical'; // horizontal = side-by-side panes, vertical divider
      minSizes: [number, number]; // px, for [first, second]
      children: [PaneSpec, PaneSpec];
    };

const STORAGE_PREFIX = 'split-pane-ratio:';

function loadRatio(id: string): number {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + id);
    const n = raw ? parseFloat(raw) : NaN;
    return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.5;
  } catch {
    return 0.5;
  }
}

function saveRatio(id: string, ratio: number) {
  try {
    localStorage.setItem(STORAGE_PREFIX + id, String(ratio));
  } catch {
    // ignore (private mode, quota, etc.)
  }
}

export function buildPane(spec: PaneSpec): HTMLElement {
  if (spec.type === 'leaf') {
    const el = document.createElement('div');
    el.setAttribute('data-testid', 'pane');
    el.setAttribute('data-pane-id', spec.id);
    el.style.padding = '8px';
    el.style.overflow = 'auto';
    el.style.fontFamily = 'system-ui, sans-serif';
    el.style.fontSize = '13px';
    el.textContent = spec.label;
    return el;
  }

  const { direction, minSizes, children, id } = spec;
  const isRow = direction === 'horizontal';

  const container = document.createElement('div');
  container.setAttribute('data-testid', 'split');
  container.setAttribute('data-split-id', id);
  container.style.display = 'flex';
  container.style.flexDirection = isRow ? 'row' : 'column';
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.minWidth = '0';
  container.style.minHeight = '0';

  const ratio = loadRatio(id);

  const firstWrap = document.createElement('div');
  firstWrap.style.flex = `${ratio} 1 0`;
  firstWrap.style.minWidth = '0';
  firstWrap.style.minHeight = '0';
  firstWrap.style.overflow = 'hidden';
  firstWrap.appendChild(buildPane(children[0]));

  const secondWrap = document.createElement('div');
  secondWrap.style.flex = `${1 - ratio} 1 0`;
  secondWrap.style.minWidth = '0';
  secondWrap.style.minHeight = '0';
  secondWrap.style.overflow = 'hidden';
  secondWrap.appendChild(buildPane(children[1]));

  const divider = document.createElement('div');
  divider.setAttribute('data-testid', 'divider');
  divider.setAttribute('data-divider-id', id);
  divider.style.flex = '0 0 6px';
  divider.style.cursor = isRow ? 'col-resize' : 'row-resize';
  divider.style.background = '#333';
  divider.style.touchAction = 'none';

  let dragging = false;

  divider.addEventListener('pointerdown', (e) => {
    dragging = true;
    divider.setPointerCapture(e.pointerId);
  });

  divider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const total = isRow ? rect.width : rect.height;
    const pos = isRow ? e.clientX - rect.left : e.clientY - rect.top;
    const [minFirst, minSecond] = minSizes;
    const clamped = Math.max(minFirst, Math.min(total - minSecond, pos));
    const newRatio = total > 0 ? clamped / total : 0.5;
    firstWrap.style.flex = `${newRatio} 1 0`;
    secondWrap.style.flex = `${1 - newRatio} 1 0`;
    divider.setAttribute('data-current-ratio', newRatio.toFixed(4));
  });

  function endDrag(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    divider.releasePointerCapture(e.pointerId);
    const finalRatio = parseFloat(divider.getAttribute('data-current-ratio') ?? String(ratio));
    saveRatio(id, finalRatio);
  }
  divider.addEventListener('pointerup', endDrag);
  divider.addEventListener('pointercancel', endDrag);

  container.appendChild(firstWrap);
  container.appendChild(divider);
  container.appendChild(secondWrap);
  return container;
}

const DEMO_SPEC: PaneSpec = {
  type: 'split',
  id: 'main',
  direction: 'horizontal',
  minSizes: [80, 80],
  children: [
    { type: 'leaf', id: 'left', label: 'Left pane (min 80px)' },
    {
      type: 'split',
      id: 'right-nested',
      direction: 'vertical',
      minSizes: [40, 40],
      children: [
        { type: 'leaf', id: 'top-right', label: 'Top-right pane' },
        { type: 'leaf', id: 'bottom-right', label: 'Bottom-right pane (min 40px)' },
      ],
    },
  ],
};

export function mount(root: HTMLElement) {
  root.innerHTML = '';
  root.style.width = '480px';
  root.style.height = '260px';
  root.style.border = '1px solid #333';
  root.appendChild(buildPane(DEMO_SPEC));
}

export default mount;
