// Lazy-Load Image Library
//
// Each image starts as a blurred color placeholder. An IntersectionObserver
// with a generous rootMargin starts loading images before they're actually
// on screen (viewport prefetching — by the time you scroll to one, it's
// often already decoded). Once the "network" fetch resolves, the image is
// decoded off the main thread via `img.decode()` and only faded in once
// that promise resolves — setting `src` and fading in immediately can flash
// an undecoded frame on a slow device, since the decode would otherwise
// happen synchronously on first paint.
//
// Usage:
//   const el = createLazyImage({ src: 'photo.jpg', color: '#334' });
//   observer.observe(el);
//
// `mount(root)` builds a scrollable demo list and wires up the observer.

export interface LazyImageOptions {
  src: string;
  color?: string;
  label?: string;
}

export function createLazyImage(opts: LazyImageOptions): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-testid', 'lazy-image');
  wrapper.setAttribute('data-src', opts.src);
  wrapper.setAttribute('data-state', 'pending');
  wrapper.style.position = 'relative';
  wrapper.style.width = '100%';
  wrapper.style.height = '120px';
  wrapper.style.overflow = 'hidden';
  wrapper.style.borderRadius = '4px';
  wrapper.style.marginBottom = '16px';

  const placeholder = document.createElement('div');
  placeholder.setAttribute('data-testid', 'placeholder');
  placeholder.style.position = 'absolute';
  placeholder.style.inset = '0';
  placeholder.style.background = opts.color ?? '#334155';
  placeholder.style.filter = 'blur(10px)';
  placeholder.style.transform = 'scale(1.1)'; // hides the blur's edge feathering

  const img = document.createElement('img');
  img.setAttribute('data-testid', 'real-image');
  img.alt = opts.label ?? '';
  img.style.position = 'absolute';
  img.style.inset = '0';
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.objectFit = 'cover';
  img.style.opacity = '0';
  img.style.transition = 'opacity 250ms ease';

  const label = document.createElement('div');
  label.setAttribute('data-testid', 'label');
  label.style.position = 'absolute';
  label.style.inset = '0';
  label.style.display = 'flex';
  label.style.alignItems = 'center';
  label.style.justifyContent = 'center';
  label.style.color = 'white';
  label.style.fontFamily = 'system-ui, sans-serif';
  label.style.fontSize = '12px';
  label.style.textShadow = '0 1px 2px rgba(0,0,0,0.6)';
  label.textContent = opts.label ?? '';

  wrapper.append(placeholder, img, label);
  return wrapper;
}

// Simulates a network fetch delay, then loads + decodes the image before
// making it visible.
async function loadImage(wrapper: HTMLElement, networkDelayMs = 200) {
  if (wrapper.getAttribute('data-state') !== 'pending') return;
  wrapper.setAttribute('data-state', 'loading');

  await new Promise((r) => setTimeout(r, networkDelayMs));

  const img = wrapper.querySelector('img') as HTMLImageElement;
  const src = wrapper.getAttribute('data-src')!;
  img.src = src;

  try {
    if (typeof img.decode === 'function') {
      await img.decode();
    } else {
      await new Promise((resolve, reject) => {
        img.onload = () => resolve(undefined);
        img.onerror = reject;
      });
    }
    img.style.opacity = '1';
    wrapper.setAttribute('data-state', 'loaded');
  } catch {
    wrapper.setAttribute('data-state', 'error');
  }
}

export function observeLazyImages(container: HTMLElement, root: HTMLElement, rootMargin = '150px') {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          void loadImage(entry.target as HTMLElement);
        }
      }
    },
    { root, rootMargin },
  );
  container.querySelectorAll('[data-testid="lazy-image"]').forEach((el) => observer.observe(el));
  return observer;
}

// A tiny inline SVG data URI stands in for a real photo -- offline-safe and
// instant, since this demo shouldn't depend on network access to prove the
// loading pipeline works.
function placeholderPhoto(seed: number, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="${color}"/><circle cx="${40 + (seed * 37) % 240}" cy="${60 + (seed * 53) % 80}" r="30" fill="rgba(255,255,255,0.3)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function mount(root: HTMLElement) {
  root.innerHTML = '';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '16px';

  const scrollContainer = document.createElement('div');
  scrollContainer.setAttribute('data-testid', 'scroll-container');
  scrollContainer.style.height = '260px';
  scrollContainer.style.overflowY = 'auto';
  scrollContainer.style.border = '1px solid #333';
  scrollContainer.style.padding = '12px';

  const colors = ['#334155', '#3f2d54', '#1e4a3f', '#553228', '#2d3f54', '#4a3f1e', '#3f1e4a', '#1e3f4a'];
  for (let i = 0; i < colors.length; i++) {
    const img = createLazyImage({ src: placeholderPhoto(i, colors[i]), color: colors[i], label: `Photo ${i + 1}` });
    scrollContainer.appendChild(img);
  }

  root.appendChild(scrollContainer);
  observeLazyImages(scrollContainer, scrollContainer, '150px');
}

export default mount;
