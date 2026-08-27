// Canvas Particle Engine
//
// A pooled particle system (particles are pre-allocated once and toggled
// active/inactive rather than allocated and garbage-collected per spawn),
// with configurable emitters and forces (gravity, drag, wind), stepped on a
// FIXED timestep via an accumulator — real elapsed time between frames
// feeds an accumulator, and the simulation advances in constant-size
// increments drained from it. That's what makes the simulation
// deterministic: the same total elapsed time produces the exact same
// particle state whether it arrived as one big chunk or many small ones,
// which is not true of naively stepping by the raw per-frame delta.
//
// Usage:
//   const sim = new Simulation(300, { gravity: 200, drag: 0.5, wind: 0 });
//   sim.addEmitter({ x: 0, y: 0, rate: 30, angleRange: [0, Math.PI*2], speedRange: [20,60], lifeRange: [1,2] }, mulberry32(1));
//   sim.advance(dtSeconds); // call every animation frame
//
// `mount(root)` renders it to a live <canvas>.

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  active: boolean;
}

export interface Forces {
  gravity: number; // px/s^2, downward
  drag: number; // fraction of velocity removed per second
  wind: number; // px/s^2, horizontal
}

export class ParticlePool {
  particles: Particle[];
  constructor(size: number) {
    this.particles = Array.from({ length: size }, () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, active: false }));
  }
  acquire(): Particle | null {
    for (const p of this.particles) if (!p.active) return p;
    return null; // pool exhausted -- caller just drops the spawn
  }
  get activeCount(): number {
    let n = 0;
    for (const p of this.particles) if (p.active) n++;
    return n;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// A tiny seeded PRNG (mulberry32) so simulations can be run twice with
// identical randomness -- needed to prove the fixed-timestep determinism
// property, since Math.random() would make two runs incomparable no matter
// how correct the stepping logic is.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface EmitterConfig {
  x: number;
  y: number;
  rate: number; // particles per second
  angleRange: [number, number];
  speedRange: [number, number];
  lifeRange: [number, number];
}

export class Emitter {
  private spawnAccumulator = 0;
  constructor(public config: EmitterConfig, private pool: ParticlePool, private rng: () => number = Math.random) {}

  update(dt: number) {
    this.spawnAccumulator += this.config.rate * dt;
    while (this.spawnAccumulator >= 1) {
      this.spawnAccumulator -= 1;
      this.spawnOne();
    }
  }

  private spawnOne() {
    const p = this.pool.acquire();
    if (!p) return;
    const angle = lerp(this.config.angleRange[0], this.config.angleRange[1], this.rng());
    const speed = lerp(this.config.speedRange[0], this.config.speedRange[1], this.rng());
    p.x = this.config.x;
    p.y = this.config.y;
    p.vx = Math.cos(angle) * speed;
    p.vy = Math.sin(angle) * speed;
    p.maxLife = lerp(this.config.lifeRange[0], this.config.lifeRange[1], this.rng());
    p.life = p.maxLife;
    p.active = true;
  }
}

export function stepParticles(pool: ParticlePool, forces: Forces, dt: number) {
  for (const p of pool.particles) {
    if (!p.active) continue;
    p.vy += forces.gravity * dt;
    p.vx += forces.wind * dt;
    const dragFactor = Math.max(0, 1 - forces.drag * dt);
    p.vx *= dragFactor;
    p.vy *= dragFactor;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    if (p.life <= 0) p.active = false;
  }
}

const FIXED_DT = 1 / 60;
// Summing many small real-frame deltas doesn't bit-for-bit equal summing a
// few large ones (floating point addition isn't associative), so without
// this tolerance the accumulator can land a hair below FIXED_DT right at
// the boundary and skip a step it should have taken -- which then desyncs
// every RNG draw after it between two runs of the "same" elapsed time.
const STEP_EPSILON = 1e-9;

export class Simulation {
  pool: ParticlePool;
  emitters: Emitter[] = [];
  forces: Forces;
  private accumulator = 0;

  constructor(poolSize: number, forces: Forces) {
    this.pool = new ParticlePool(poolSize);
    this.forces = forces;
  }

  addEmitter(config: EmitterConfig, rng?: () => number): Emitter {
    const e = new Emitter(config, this.pool, rng);
    this.emitters.push(e);
    return e;
  }

  advance(realDtSeconds: number) {
    this.accumulator += realDtSeconds;
    while (this.accumulator >= FIXED_DT - STEP_EPSILON) {
      for (const e of this.emitters) e.update(FIXED_DT);
      stepParticles(this.pool, this.forces, FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
  }
}

// ---- Demo -----------------------------------------------------------------

export function mount(root: HTMLElement) {
  root.innerHTML = '';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '16px';

  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 240;
  canvas.setAttribute('data-testid', 'particle-canvas');
  canvas.style.background = '#0d1117';
  canvas.style.border = '1px solid #333';
  const ctx = canvas.getContext('2d')!;

  const sim = new Simulation(300, { gravity: 200, drag: 0.4, wind: 15 });
  sim.addEmitter({
    x: 200, y: 20, rate: 60,
    angleRange: [Math.PI / 2 - 0.5, Math.PI / 2 + 0.5],
    speedRange: [40, 120],
    lifeRange: [1.2, 2.2],
  });

  const stats = document.createElement('div');
  stats.setAttribute('data-testid', 'particle-stats');
  stats.style.fontSize = '12px';
  stats.style.marginTop = '8px';

  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = 'Pause';
  toggleBtn.setAttribute('data-testid', 'toggle-btn');
  let running = true;
  toggleBtn.onclick = () => {
    running = !running;
    toggleBtn.textContent = running ? 'Pause' : 'Resume';
  };

  let lastTime = performance.now();
  let rafId: number;
  function frame(now: number) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    if (running) sim.advance(dt);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#60a5fa';
    for (const p of sim.pool.particles) {
      if (!p.active) continue;
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    stats.textContent = `${sim.pool.activeCount} active particles`;
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);
  void rafId;

  root.appendChild(canvas);
  root.appendChild(toggleBtn);
  root.appendChild(stats);
}

export default mount;
