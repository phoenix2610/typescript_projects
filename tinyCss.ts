// Tiny CSS-in-JS Runtime
//
// `css({...})` hashes a style object into a short deterministic class name
// and injects a rule for it into one shared <style> sheet — but only the
// first time that exact set of styles is seen. Two calls with the same
// properties (even in a different key order, since the hash input is
// sorted first) resolve to the same class and inject nothing twice.
// Unitless properties (opacity, zIndex, lineHeight, ...) are left alone;
// every other numeric value gets `px` appended, the same convention React
// and most CSS-in-JS libraries use.
//
// Usage:
//   const btn = css({ padding: 8, background: '#3b82f6', borderRadius: 4 });
//   el.className = btn;
//
// `mount(root)` builds a demo showing several elements sharing classes and
// the resulting stylesheet text.

const UNITLESS_PROPS = new Set([
  'opacity', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'order',
  'lineHeight', 'fontWeight', 'zoom',
]);

function toKebabCase(prop: string): string {
  return prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

// djb2 — small, fast, good enough distribution for a class-name hash.
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function stableKey(styles: Record<string, string | number>): string {
  return Object.keys(styles)
    .sort()
    .map((k) => `${k}:${styles[k]}`)
    .join(';');
}

const injectedHashes = new Set<string>();
let sheetEl: HTMLStyleElement | null = null;

function getSheet(): HTMLStyleElement {
  if (!sheetEl) {
    sheetEl = document.createElement('style');
    sheetEl.setAttribute('data-testid', 'css-in-js-sheet');
    document.head.appendChild(sheetEl);
  }
  return sheetEl;
}

export function css(styles: Record<string, string | number>): string {
  const key = stableKey(styles);
  const hash = hashString(key);
  const className = `css-${hash}`;

  if (!injectedHashes.has(hash)) {
    const body = Object.entries(styles)
      .map(([prop, value]) => {
        const cssProp = toKebabCase(prop);
        const cssValue = typeof value === 'number' && !UNITLESS_PROPS.has(prop) ? `${value}px` : value;
        return `  ${cssProp}: ${cssValue};`;
      })
      .join('\n');
    getSheet().appendChild(document.createTextNode(`.${className} {\n${body}\n}\n`));
    injectedHashes.add(hash);
  }

  return className;
}

export function injectedRuleCount(): number {
  return injectedHashes.size;
}

// ---- Demo -----------------------------------------------------------------

export function mount(root: HTMLElement) {
  root.innerHTML = '';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '16px';

  const primary = { padding: 8, background: '#3b82f6', color: 'white', borderRadius: 4, border: 'none' };
  // Same properties, different key order -- should resolve to the SAME class.
  const primaryReordered = { border: 'none', borderRadius: 4, color: 'white', background: '#3b82f6', padding: 8 };
  const danger = { padding: 8, background: '#ef4444', color: 'white', borderRadius: 4, border: 'none' };
  const label = { fontSize: 13, opacity: 0.8, lineHeight: 1.4, zIndex: 2 };

  let callCount = 0;
  function make(tag: string, styles: Record<string, string | number>, text: string): HTMLElement {
    callCount++;
    const el = document.createElement(tag);
    el.className = css(styles);
    el.textContent = text;
    return el;
  }

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '8px';
  row.style.marginBottom = '12px';
  row.appendChild(make('button', primary, 'Save'));
  row.appendChild(make('button', primaryReordered, 'Save (reordered styles)'));
  row.appendChild(make('button', danger, 'Delete'));

  // Built with placeholder text first: the stats line counts this very
  // make() call too, so it has to be filled in after make() returns —
  // an argument expression evaluates before the call it's passed to,
  // so reading callCount/injectedRuleCount() as an argument here would
  // capture their pre-call values and undercount by one.
  const labelEl = make('div', label, '');
  labelEl.setAttribute('data-testid', 'stats');
  labelEl.textContent = `${callCount} css() calls, ${injectedRuleCount()} unique rule(s) injected`;

  const sheetPreview = document.createElement('pre');
  sheetPreview.setAttribute('data-testid', 'sheet-preview');
  sheetPreview.style.fontSize = '11px';
  sheetPreview.style.background = '#161b22';
  sheetPreview.style.padding = '8px';
  sheetPreview.style.marginTop = '12px';
  sheetPreview.textContent = getSheet().textContent;

  root.appendChild(row);
  root.appendChild(labelEl);
  root.appendChild(sheetPreview);
}

export default mount;
