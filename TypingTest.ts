// Typing Speed Test
//
// Per-keystroke timing, live WPM, an accuracy heatmap (each typed character
// is colored by how long it took relative to the last one), and a "Copy
// results" button for sharing. Pure DOM + browser APIs, no framework.
//
// Usage:
//   import { mount } from './TypingTest';
//   mount(document.getElementById('app'));
//
// `mount` builds the whole UI into `root` and returns nothing; there is no
// teardown because this is a standalone demo page, not a component embedded
// alongside other UI.

const WORD_BANK = [
  'the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'code',
  'review', 'ship', 'build', 'test', 'debug', 'merge', 'deploy', 'query',
  'array', 'string', 'object', 'function', 'return', 'value', 'error',
  'handle', 'render', 'client', 'server', 'route', 'state', 'event',
  'window', 'module', 'export', 'import', 'const', 'letter', 'number',
];

const FAST_MS = 150;
const SLOW_MS = 350;
const WORD_COUNT = 20;

function generateTarget(count = WORD_COUNT): string {
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    words.push(WORD_BANK[Math.floor(Math.random() * WORD_BANK.length)]);
  }
  return words.join(' ');
}

interface Keystroke {
  correct: boolean;
  dt: number; // ms since the previous keystroke; 0 for the first
}

function speedClass(dt: number, isFirst: boolean): 'fast' | 'medium' | 'slow' | 'neutral' {
  if (isFirst) return 'neutral';
  if (dt < FAST_MS) return 'fast';
  if (dt > SLOW_MS) return 'slow';
  return 'medium';
}

const COLORS: Record<string, string> = {
  fast: '#22c55e',
  medium: '#eab308',
  slow: '#ef4444',
  neutral: '#9ca3af',
};

export function mount(root: HTMLElement) {
  let target = generateTarget();
  let keystrokes: Keystroke[] = [];
  let startTime: number | null = null;
  let lastKeyTime: number | null = null;
  let finished = false;

  root.innerHTML = '';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.maxWidth = '640px';
  root.style.padding = '16px';

  const passageEl = document.createElement('div');
  passageEl.setAttribute('data-testid', 'passage');
  passageEl.setAttribute('data-target', target);
  passageEl.style.fontFamily = 'monospace';
  passageEl.style.fontSize = '16px';
  passageEl.style.lineHeight = '1.6';
  passageEl.style.letterSpacing = '0.5px';
  passageEl.tabIndex = 0;

  const statsEl = document.createElement('div');
  statsEl.setAttribute('data-testid', 'stats');
  statsEl.style.marginTop = '12px';
  statsEl.style.fontSize = '14px';

  const resultsEl = document.createElement('div');
  resultsEl.setAttribute('data-testid', 'results');
  resultsEl.style.marginTop = '12px';
  resultsEl.style.display = 'none';

  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy results';
  copyBtn.setAttribute('data-testid', 'copy-results');

  const copiedText = document.createElement('code');
  copiedText.setAttribute('data-testid', 'copied-text');
  copiedText.style.display = 'block';
  copiedText.style.marginTop = '6px';
  copiedText.style.fontSize = '12px';

  const restartBtn = document.createElement('button');
  restartBtn.textContent = 'Restart';
  restartBtn.setAttribute('data-testid', 'restart');
  restartBtn.style.marginTop = '12px';

  function renderPassage() {
    passageEl.innerHTML = '';
    for (let i = 0; i < target.length; i++) {
      const span = document.createElement('span');
      span.textContent = target[i];
      if (i < keystrokes.length) {
        const k = keystrokes[i];
        span.style.color = k.correct ? COLORS[speedClass(k.dt, i === 0)] : '#ffffff';
        span.style.background = k.correct ? 'transparent' : '#ef4444';
      } else if (i === keystrokes.length) {
        span.style.borderLeft = '2px solid #3b82f6';
      } else {
        span.style.opacity = '0.5';
      }
      passageEl.appendChild(span);
    }
  }

  function currentStats() {
    const correct = keystrokes.filter((k) => k.correct).length;
    const elapsedMin = startTime ? (performance.now() - startTime) / 60000 : 0;
    const wpm = elapsedMin > 0 ? Math.round(correct / 5 / elapsedMin) : 0;
    const accuracy = keystrokes.length > 0 ? Math.round((correct / keystrokes.length) * 100) : 100;
    return { wpm, accuracy, correct };
  }

  function renderStats() {
    const { wpm, accuracy } = currentStats();
    statsEl.textContent = `${wpm} WPM · ${accuracy}% accuracy · ${keystrokes.length}/${target.length} chars`;
  }

  function finish() {
    finished = true;
    document.removeEventListener('keydown', onKeyDown, true);
    const { wpm, accuracy } = currentStats();
    resultsEl.style.display = 'block';
    const summary = `${wpm} WPM, ${accuracy}% accuracy on a ${WORD_COUNT}-word passage`;
    resultsEl.innerHTML = '';
    const summaryEl = document.createElement('div');
    summaryEl.setAttribute('data-testid', 'summary');
    summaryEl.textContent = summary;
    resultsEl.appendChild(summaryEl);
    resultsEl.appendChild(copyBtn);
    resultsEl.appendChild(copiedText);

    copyBtn.onclick = () => {
      navigator.clipboard?.writeText(summary).catch(() => {});
      copiedText.textContent = summary;
    };
  }

  function onKeyDown(e: KeyboardEvent) {
    if (finished) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'Backspace') {
      e.preventDefault();
      keystrokes = keystrokes.slice(0, -1);
      renderPassage();
      renderStats();
      return;
    }

    if (e.key.length !== 1) return; // ignore Shift, Tab, arrow keys, etc.
    e.preventDefault();

    const now = performance.now();
    if (startTime === null) startTime = now;
    const dt = lastKeyTime === null ? 0 : now - lastKeyTime;
    lastKeyTime = now;

    const index = keystrokes.length;
    const correct = target[index] === e.key;
    keystrokes = [...keystrokes, { correct, dt }];

    renderPassage();
    renderStats();

    if (keystrokes.length === target.length) finish();
  }

  function restart() {
    target = generateTarget();
    keystrokes = [];
    startTime = null;
    lastKeyTime = null;
    finished = false;
    resultsEl.style.display = 'none';
    passageEl.setAttribute('data-target', target);
    document.removeEventListener('keydown', onKeyDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    renderPassage();
    renderStats();
    passageEl.focus();
  }

  restartBtn.onclick = restart;

  root.appendChild(passageEl);
  root.appendChild(statsEl);
  root.appendChild(resultsEl);
  root.appendChild(restartBtn);

  document.addEventListener('keydown', onKeyDown, true);
  renderPassage();
  renderStats();
  passageEl.focus();
}

export default mount;
