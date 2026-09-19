// SVG Chart Library Core
//
// Scales (linear + band), a "nice round number" tick generator, and a
// line/bar renderer, all as plain SVG DOM — no charting dependency. The
// hard-to-get-right part is standard for every chart library: pixel-y grows
// downward but data-y usually shouldn't, so every scale here maps the data
// domain onto the range you hand it, in whatever direction that range runs
// (pass a flipped range like [height, 0] for a y-axis and larger values
// land higher on screen).
//
// Usage:
//   import { mount } from './SvgCharts';
//   mount(document.getElementById('app'));
//
// `linearScale`, `bandScale`, `niceTicks`, `renderLineChart` and
// `renderBarChart` are exported standalone for reuse outside the demo.

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// ---- Scales -----------------------------------------------------------------

export interface LinearScale {
  (value: number): number;
  invert: (px: number) => number;
}

export function linearScale(domain: [number, number], range: [number, number]): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const scale = ((v: number) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0)) as LinearScale;
  scale.invert = (px: number) => d0 + ((px - r0) / (r1 - r0)) * (d1 - d0);
  return scale;
}

export interface BandScale {
  (key: string): number;
  bandwidth: number;
}

export function bandScale(domain: string[], range: [number, number], padding = 0.15): BandScale {
  const [r0, r1] = range;
  const step = (r1 - r0) / domain.length;
  const bandwidth = step * (1 - padding);
  const fn = ((key: string) => {
    const i = domain.indexOf(key);
    return r0 + i * step + (step - bandwidth) / 2;
  }) as BandScale;
  fn.bandwidth = bandwidth;
  return fn;
}

function niceStep(rough: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / magnitude;
  const niceNorm = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return niceNorm * magnitude;
}

export function niceTicks(min: number, max: number, targetCount = 5): number[] {
  if (min === max) return [min];
  const step = niceStep((max - min) / targetCount);
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.round(v / step) * step); // snap away from float drift
  }
  return ticks;
}

// ---- Axes -----------------------------------------------------------------

function drawXAxis(svg: SVGSVGElement, scale: LinearScale, ticks: number[], y: number) {
  const g = svgEl('g', {});
  g.setAttribute('data-testid', 'x-axis');
  for (const t of ticks) {
    const x = scale(t);
    g.appendChild(svgEl('line', { x1: x, y1: y, x2: x, y2: y + 5, stroke: '#666' }));
    const label = svgEl('text', { x, y: y + 18, 'text-anchor': 'middle', 'font-size': 10, fill: '#999' });
    label.setAttribute('data-testid', 'x-tick');
    label.setAttribute('data-value', String(t));
    label.textContent = String(t);
    g.appendChild(label);
  }
  svg.appendChild(g);
}

function drawYAxis(svg: SVGSVGElement, scale: LinearScale, ticks: number[], x: number) {
  const g = svgEl('g', {});
  g.setAttribute('data-testid', 'y-axis');
  for (const t of ticks) {
    const y = scale(t);
    g.appendChild(svgEl('line', { x1: x - 5, y1: y, x2: x, y2: y, stroke: '#666' }));
    const label = svgEl('text', { x: x - 8, y: y + 3, 'text-anchor': 'end', 'font-size': 10, fill: '#999' });
    label.setAttribute('data-testid', 'y-tick');
    label.setAttribute('data-value', String(t));
    label.textContent = String(t);
    g.appendChild(label);
  }
  svg.appendChild(g);
}

// ---- Renderers -----------------------------------------------------------------

const MARGIN = { top: 16, right: 16, bottom: 28, left: 40 };

export function renderLineChart(container: HTMLElement, data: { x: number; y: number }[], width = 480, height = 260) {
  const svg = svgEl('svg', { width, height, 'data-testid': 'line-chart' });
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;

  const xDomain: [number, number] = [Math.min(...data.map((d) => d.x)), Math.max(...data.map((d) => d.x))];
  const yDomain: [number, number] = [0, Math.max(...data.map((d) => d.y))];
  const xScale = linearScale(xDomain, [MARGIN.left, MARGIN.left + plotW]);
  const yScale = linearScale(yDomain, [MARGIN.top + plotH, MARGIN.top]); // flipped: larger y -> higher on screen

  drawXAxis(svg, xScale, niceTicks(xDomain[0], xDomain[1], 6), MARGIN.top + plotH);
  drawYAxis(svg, yScale, niceTicks(yDomain[0], yDomain[1], 5), MARGIN.left);

  const points = data.map((d) => `${xScale(d.x)},${yScale(d.y)}`).join(' ');
  svg.appendChild(svgEl('polyline', { points, fill: 'none', stroke: '#3b82f6', 'stroke-width': 2, 'data-testid': 'line-path' }));

  for (const d of data) {
    const circle = svgEl('circle', { cx: xScale(d.x), cy: yScale(d.y), r: 3, fill: '#3b82f6' });
    circle.setAttribute('data-testid', 'line-point');
    circle.setAttribute('data-x', String(d.x));
    circle.setAttribute('data-y', String(d.y));
    svg.appendChild(circle);
  }

  container.appendChild(svg);
  return svg;
}

export function renderBarChart(container: HTMLElement, data: { label: string; value: number }[], width = 480, height = 260) {
  const svg = svgEl('svg', { width, height, 'data-testid': 'bar-chart' });
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;

  const xScale = bandScale(data.map((d) => d.label), [MARGIN.left, MARGIN.left + plotW]);
  const yDomain: [number, number] = [0, Math.max(...data.map((d) => d.value))];
  const yScale = linearScale(yDomain, [MARGIN.top + plotH, MARGIN.top]);

  drawYAxis(svg, yScale, niceTicks(yDomain[0], yDomain[1], 5), MARGIN.left);

  const g = svgEl('g', {});
  g.setAttribute('data-testid', 'x-axis');
  for (const d of data) {
    const cx = xScale(d.label) + xScale.bandwidth / 2;
    const label = svgEl('text', { x: cx, y: MARGIN.top + plotH + 14, 'text-anchor': 'middle', 'font-size': 10, fill: '#999' });
    label.setAttribute('data-testid', 'x-tick');
    label.textContent = d.label;
    g.appendChild(label);
  }
  svg.appendChild(g);

  for (const d of data) {
    const barY = yScale(d.value);
    const barHeight = MARGIN.top + plotH - barY;
    const rect = svgEl('rect', {
      x: xScale(d.label),
      y: barY,
      width: xScale.bandwidth,
      height: barHeight,
      fill: '#22c55e',
    });
    rect.setAttribute('data-testid', 'bar');
    rect.setAttribute('data-label', d.label);
    rect.setAttribute('data-value', String(d.value));
    svg.appendChild(rect);
  }

  container.appendChild(svg);
  return svg;
}

export function mount(root: HTMLElement) {
  root.innerHTML = '';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '16px';
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.gap = '16px';

  const lineData = Array.from({ length: 12 }, (_, i) => ({
    x: i,
    y: Math.round(50 + 40 * Math.sin(i / 2) + i * 3),
  }));
  renderLineChart(root, lineData);

  const barData = [
    { label: 'Mon', value: 42 },
    { label: 'Tue', value: 67 },
    { label: 'Wed', value: 23 },
    { label: 'Thu', value: 89 },
    { label: 'Fri', value: 55 },
  ];
  renderBarChart(root, barData);
}

export default mount;
