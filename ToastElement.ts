// Toast Web Component
//
// A framework-free custom element — <toast-item> — with an open Shadow DOM,
// slotted content (the caller writes normal HTML as children), an ARIA live
// region so screen readers announce it, CSS custom properties for theming,
// and an optional auto-dismiss timer. Dismissing (by button or timer) fires
// a bubbling, shadow-piercing `toast-dismiss` CustomEvent so host code can
// react without reaching into the shadow tree.
//
// Usage:
//   customElements.define('toast-item', ToastItem);
//   const t = document.createElement('toast-item');
//   t.setAttribute('type', 'success');
//   t.setAttribute('duration', '4000');
//   t.innerHTML = '<strong>Saved!</strong> Your changes are live.';
//   document.body.appendChild(t);
//
// `mount(root)` registers the element and renders a demo host page.

const TYPE_COLORS: Record<string, { bg: string; border: string }> = {
  info: { bg: '#1e3a5f', border: '#3b82f6' },
  success: { bg: '#14532d', border: '#22c55e' },
  error: { bg: '#5f1e1e', border: '#ef4444' },
  warning: { bg: '#5f4a1e', border: '#f59e0b' },
};

export class ToastItem extends HTMLElement {
  private timer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback() {
    const type = this.getAttribute('type') || 'info';
    const colors = TYPE_COLORS[type] ?? TYPE_COLORS.info;
    const duration = Number(this.getAttribute('duration') || 0);
    const role = type === 'error' ? 'alert' : 'status'; // alert implies assertive, status implies polite

    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { display: block; font-family: system-ui, sans-serif; margin-bottom: 8px; }
        .toast {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 12px;
          border-radius: 6px;
          background: var(--toast-bg, ${colors.bg});
          border-left: 4px solid var(--toast-border, ${colors.border});
          color: var(--toast-color, white);
          font-size: 13px;
        }
        button {
          background: none;
          border: none;
          color: inherit;
          cursor: pointer;
          font-size: 14px;
          opacity: 0.8;
        }
        button:hover { opacity: 1; }
      </style>
      <div class="toast" part="toast" role="${role}" aria-live="${role === 'alert' ? 'assertive' : 'polite'}">
        <slot></slot>
        <button aria-label="Dismiss notification" part="close">✕</button>
      </div>
    `;

    shadow.querySelector('button')!.addEventListener('click', () => this.dismiss());

    if (duration > 0) {
      this.timer = setTimeout(() => this.dismiss(), duration);
    }
  }

  disconnectedCallback() {
    if (this.timer) clearTimeout(this.timer);
  }

  dismiss() {
    if (this.timer) clearTimeout(this.timer);
    this.dispatchEvent(
      new CustomEvent('toast-dismiss', {
        bubbles: true,
        composed: true, // crosses the shadow boundary so host listeners see it
        detail: { type: this.getAttribute('type') || 'info' },
      }),
    );
    this.remove();
  }
}

export function mount(root: HTMLElement) {
  if (!customElements.get('toast-item')) {
    customElements.define('toast-item', ToastItem);
  }

  root.innerHTML = '';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '16px';

  const controls = document.createElement('div');
  controls.style.display = 'flex';
  controls.style.gap = '8px';
  controls.style.marginBottom = '12px';

  const container = document.createElement('div');
  container.setAttribute('data-testid', 'toast-container');
  container.style.width = '300px';

  let dismissLog: string[] = [];
  const log = document.createElement('div');
  log.setAttribute('data-testid', 'dismiss-log');
  log.style.fontSize = '12px';
  log.style.opacity = '0.7';
  log.style.marginTop = '8px';

  document.addEventListener('toast-dismiss', (e) => {
    const detail = (e as CustomEvent).detail;
    dismissLog = [...dismissLog, detail.type];
    log.textContent = `Dismissed: ${dismissLog.join(', ')}`;
  });

  function spawn(type: string, text: string, duration?: number) {
    const toast = document.createElement('toast-item') as ToastItem;
    toast.setAttribute('type', type);
    if (duration) toast.setAttribute('duration', String(duration));
    toast.setAttribute('data-testid', 'toast-item');
    toast.innerHTML = text;
    container.appendChild(toast);
  }

  for (const [type, buttonLabel, message] of [
    ['info', 'Add info', 'Heads up: a new version is available.'],
    ['success', 'Add success', '<strong>Saved!</strong> Your changes are live.'],
    ['error', 'Add error', '<strong>Upload failed.</strong> Check your connection.'],
  ] as const) {
    const btn = document.createElement('button');
    btn.textContent = buttonLabel;
    btn.addEventListener('click', () => spawn(type, message, 0));
    controls.appendChild(btn);
  }

  const autoBtn = document.createElement('button');
  autoBtn.textContent = 'Add auto-dismiss (500ms)';
  autoBtn.addEventListener('click', () => spawn('warning', 'Expiring soon', 500));
  controls.appendChild(autoBtn);

  root.appendChild(controls);
  root.appendChild(container);
  root.appendChild(log);

  // One statically-declared example with rich slotted content.
  spawn('success', '<strong>Saved!</strong> Your changes are live.', 0);
}

export default mount;
