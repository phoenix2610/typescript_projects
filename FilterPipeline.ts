// WebGL Image Filter Pipeline
//
// Each effect (blur, curves, grain) is its own fragment shader; the
// pipeline chains them by ping-ponging between two offscreen framebuffer
// textures — pass N reads the texture pass N-1 wrote to, and writes to
// whichever of the two textures ISN'T currently the input, so nothing
// reads and writes the same texture in one draw call. The final pass
// renders straight to the visible canvas instead of a texture.
//
// Usage:
//   const pipeline = new FilterPipeline(canvas, sourceCanvas);
//   pipeline.render([
//     { name: 'blur', uniforms: { uTexelSize: [1/w, 1/h] } },
//     { name: 'curves', uniforms: { uBrightness: 0.1, uContrast: 1.2 } },
//     { name: 'grain', uniforms: { uAmount: 0.08 } },
//   ]);
//
// `mount(root)` builds a demo with a real file input for uploading a photo,
// defaulting to a procedurally generated source image so the pipeline has
// something to render immediately, before any upload.

const VERTEX_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const PASSTHROUGH_FS = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTexture;
void main() { gl_FragColor = texture2D(uTexture, vUv); }`;

const BLUR_FS = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uTexelSize;
void main() {
  vec4 sum = vec4(0.0);
  float count = 0.0;
  for (int dx = -2; dx <= 2; dx++) {
    for (int dy = -2; dy <= 2; dy++) {
      sum += texture2D(uTexture, vUv + vec2(float(dx), float(dy)) * uTexelSize);
      count += 1.0;
    }
  }
  gl_FragColor = sum / count;
}`;

const CURVES_FS = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform float uBrightness;
uniform float uContrast;
void main() {
  vec4 color = texture2D(uTexture, vUv);
  vec3 adjusted = (color.rgb - 0.5) * uContrast + 0.5 + uBrightness;
  gl_FragColor = vec4(clamp(adjusted, 0.0, 1.0), color.a);
}`;

const GRAIN_FS = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform float uAmount;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  vec4 color = texture2D(uTexture, vUv);
  float n = (hash(vUv * 1000.0) - 0.5) * uAmount;
  gl_FragColor = vec4(clamp(color.rgb + n, 0.0, 1.0), color.a);
}`;

const SHADERS: Record<string, string> = { passthrough: PASSTHROUGH_FS, blur: BLUR_FS, curves: CURVES_FS, grain: GRAIN_FS };

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}`);
  }
  return shader;
}

function linkProgram(gl: WebGLRenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    throw new Error(`Program link error: ${log}`);
  }
  return program;
}

interface RenderTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
}

function createRenderTarget(gl: WebGLRenderingContext, width: number, height: number): RenderTarget {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { framebuffer, texture };
}

export interface FilterPass {
  name: keyof typeof SHADERS;
  uniforms: Record<string, number | number[]>;
}

export class FilterPipeline {
  private gl: WebGLRenderingContext;
  private programs = new Map<string, WebGLProgram>();
  private quadBuffer: WebGLBuffer;
  private width: number;
  private height: number;
  private sourceTexture: WebGLTexture;
  private ping: RenderTarget;
  private pong: RenderTarget;

  constructor(canvas: HTMLCanvasElement, source: HTMLCanvasElement | HTMLImageElement) {
    // preserveDrawingBuffer: without it, the browser is free to discard the
    // canvas's backbuffer right after compositing a frame -- fine for a
    // pure "draw every frame" loop, but readPixels() here gets called from
    // a separate later task (e.g. to export or verify the result), by
    // which point an un-preserved buffer can already read back as zeros.
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;
    this.width = canvas.width;
    this.height = canvas.height;

    for (const [name, fs] of Object.entries(SHADERS)) {
      this.programs.set(name, linkProgram(gl, VERTEX_SRC, fs));
    }

    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.sourceTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.ping = createRenderTarget(gl, this.width, this.height);
    this.pong = createRenderTarget(gl, this.width, this.height);
  }

  // Re-uploads the source texture from a new image -- used to swap in a
  // real uploaded photo after construction, since the pipeline itself
  // doesn't care whether its input came from a <canvas> or a decoded
  // <img>, only that it's drawable.
  updateSource(source: HTMLCanvasElement | HTMLImageElement) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  private drawPass(programName: string, inputTexture: WebGLTexture, targetFb: WebGLFramebuffer | null, uniforms: Record<string, number | number[]>) {
    const gl = this.gl;
    const program = this.programs.get(programName);
    if (!program) throw new Error(`Unknown filter pass "${programName}"`);

    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFb);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(program);

    const posLoc = gl.getAttribLocation(program, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTexture);
    gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);

    for (const [key, value] of Object.entries(uniforms)) {
      const loc = gl.getUniformLocation(program, key);
      if (!loc) continue;
      if (Array.isArray(value)) gl.uniform2fv(loc, value);
      else gl.uniform1f(loc, value);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  render(passes: FilterPass[]) {
    if (passes.length === 0) {
      this.drawPass('passthrough', this.sourceTexture, null, {});
      return;
    }
    let inputTexture = this.sourceTexture;
    for (let i = 0; i < passes.length; i++) {
      const isLast = i === passes.length - 1;
      const target = isLast ? null : i % 2 === 0 ? this.ping : this.pong;
      this.drawPass(passes[i].name, inputTexture, target ? target.framebuffer : null, passes[i].uniforms);
      if (!isLast) inputTexture = target!.texture;
    }
  }

  readPixels(): Uint8Array {
    const gl = this.gl;
    const pixels = new Uint8Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }
}

// ---- Demo -----------------------------------------------------------------

function drawSourceImage(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const n = v - Math.floor(v);
      ctx.fillStyle = `rgb(${Math.floor(n * 255)},${Math.floor(((n * 7) % 1) * 180 + 40)},${Math.floor(((n * 13) % 1) * 255)})`;
      ctx.fillRect(x, y, 4, 4);
    }
  }
}

export function mount(root: HTMLElement) {
  root.innerHTML = '';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '16px';

  const W = 240;
  const H = 160;

  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = W;
  sourceCanvas.height = H;
  drawSourceImage(sourceCanvas);

  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = W;
  outputCanvas.height = H;
  outputCanvas.setAttribute('data-testid', 'output-canvas');
  outputCanvas.style.border = '1px solid #333';

  const pipeline = new FilterPipeline(outputCanvas, sourceCanvas);

  const controls = document.createElement('div');
  controls.style.marginTop = '8px';
  controls.style.fontSize = '13px';

  const blurCheckbox = document.createElement('input');
  blurCheckbox.type = 'checkbox';
  blurCheckbox.setAttribute('data-testid', 'blur-toggle');

  const brightnessSlider = document.createElement('input');
  brightnessSlider.type = 'range';
  brightnessSlider.min = '-0.5';
  brightnessSlider.max = '0.5';
  brightnessSlider.step = '0.05';
  brightnessSlider.value = '0';
  brightnessSlider.setAttribute('data-testid', 'brightness-slider');

  const grainSlider = document.createElement('input');
  grainSlider.type = 'range';
  grainSlider.min = '0';
  grainSlider.max = '0.5';
  grainSlider.step = '0.05';
  grainSlider.value = '0';
  grainSlider.setAttribute('data-testid', 'grain-slider');

  const uploadInput = document.createElement('input');
  uploadInput.type = 'file';
  uploadInput.accept = 'image/*';
  uploadInput.setAttribute('data-testid', 'photo-upload');
  uploadInput.addEventListener('change', () => {
    const file = uploadInput.files?.[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const ctx = sourceCanvas.getContext('2d')!;
      ctx.clearRect(0, 0, W, H);
      // Cover-fit the uploaded photo into the fixed canvas size.
      const scale = Math.max(W / img.width, H / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      pipeline.updateSource(sourceCanvas);
      rerender();
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  });

  const label = (text: string, el: HTMLElement) => {
    const wrap = document.createElement('label');
    wrap.style.display = 'block';
    wrap.style.marginBottom = '4px';
    wrap.textContent = text + ' ';
    wrap.appendChild(el);
    return wrap;
  };

  controls.append(
    label('Photo', uploadInput),
    label('Blur', blurCheckbox),
    label('Brightness', brightnessSlider),
    label('Grain', grainSlider),
  );

  function rerender() {
    const passes: FilterPass[] = [];
    if (blurCheckbox.checked) passes.push({ name: 'blur', uniforms: { uTexelSize: [1 / W, 1 / H] } });
    passes.push({ name: 'curves', uniforms: { uBrightness: Number(brightnessSlider.value), uContrast: 1.0 } });
    if (Number(grainSlider.value) > 0) passes.push({ name: 'grain', uniforms: { uAmount: Number(grainSlider.value) } });
    pipeline.render(passes);
  }

  for (const el of [blurCheckbox, brightnessSlider, grainSlider]) {
    el.addEventListener('input', rerender);
  }

  root.append(outputCanvas, controls);
  rerender();

  (root as HTMLElement & { __pipeline?: FilterPipeline }).__pipeline = pipeline;
}

export default mount;
