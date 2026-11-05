// Black-and-white dithering engine.
// Every function works on a Float32Array of tones (0 = black, 1 = white)
// and returns a Uint8Array of bits (1 = paper/white, 0 = ink/black).

export const ALGORITHMS = [
  { group: 'Threshold', items: [
    ['threshold', 'Threshold'],
    ['random', 'Random noise'],
  ]},
  { group: 'Ordered', items: [
    ['bayer2', 'Bayer 2×2'],
    ['bayer4', 'Bayer 4×4'],
    ['bayer8', 'Bayer 8×8'],
    ['bayer16', 'Bayer 16×16'],
    ['ign', 'Interleaved gradient'],
    ['halftone', 'Halftone dot'],
    ['lines', 'Line screen'],
  ]},
  { group: 'Error diffusion', items: [
    ['floyd', 'Floyd–Steinberg'],
    ['falsefloyd', 'False Floyd–Steinberg'],
    ['atkinson', 'Atkinson'],
    ['jarvis', 'Jarvis–Judice–Ninke'],
    ['stucki', 'Stucki'],
    ['burkes', 'Burkes'],
    ['sierra', 'Sierra'],
    ['sierra2', 'Two-row Sierra'],
    ['sierralite', 'Sierra Lite'],
  ]},
];

// [dx, dy, weight], divisor
const KERNELS = {
  floyd:      { div: 16, k: [[1,0,7],[-1,1,3],[0,1,5],[1,1,1]] },
  falsefloyd: { div: 8,  k: [[1,0,3],[0,1,3],[1,1,2]] },
  atkinson:   { div: 8,  k: [[1,0,1],[2,0,1],[-1,1,1],[0,1,1],[1,1,1],[0,2,1]] },
  jarvis:     { div: 48, k: [[1,0,7],[2,0,5],[-2,1,3],[-1,1,5],[0,1,7],[1,1,5],[2,1,3],[-2,2,1],[-1,2,3],[0,2,5],[1,2,3],[2,2,1]] },
  stucki:     { div: 42, k: [[1,0,8],[2,0,4],[-2,1,2],[-1,1,4],[0,1,8],[1,1,4],[2,1,2],[-2,2,1],[-1,2,2],[0,2,4],[1,2,2],[2,2,1]] },
  burkes:     { div: 32, k: [[1,0,8],[2,0,4],[-2,1,2],[-1,1,4],[0,1,8],[1,1,4],[2,1,2]] },
  sierra:     { div: 32, k: [[1,0,5],[2,0,3],[-2,1,2],[-1,1,4],[0,1,5],[1,1,4],[2,1,2],[-1,2,2],[0,2,3],[1,2,2]] },
  sierra2:    { div: 16, k: [[1,0,4],[2,0,3],[-2,1,1],[-1,1,2],[0,1,3],[1,1,2],[2,1,1]] },
  sierralite: { div: 4,  k: [[1,0,2],[-1,1,1],[0,1,1]] },
};

export const isDiffusion = (a) => a in KERNELS;
export const isScreen = (a) => a === 'halftone' || a === 'lines';

// Bayer matrices, normalised to (0,1)
const bayerCache = {};
function bayer(n) {
  if (bayerCache[n]) return bayerCache[n];
  let m = [[0]];
  while (m.length < n) {
    const s = m.length, next = [];
    for (let y = 0; y < s * 2; y++) {
      next.push(new Array(s * 2));
      for (let x = 0; x < s * 2; x++) {
        const q = [0, 2, 3, 1][(y >= s) * 2 + (x >= s)];
        next[y][x] = 4 * m[y % s][x % s] + q;
      }
    }
    m = next;
  }
  const flat = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) flat[y * n + x] = (m[y][x] + 0.5) / (n * n);
  return (bayerCache[n] = flat);
}
export const bayer8 = bayer(8);

/**
 * Convert RGBA pixels to tone values with brightness/contrast/gamma applied.
 */
export function toTone(rgba, tone, invert = false, out) {
  const n = rgba.length >> 2;
  const t = out && out.length === n ? out : new Float32Array(n);
  const c = Math.max(-0.99, Math.min(0.99, tone.contrast));
  const cf = (1 + c) / (1 - c);
  const b = tone.brightness;
  const ig = 1 / tone.gamma;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let v = (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) / 255;
    v = (v - 0.5) * cf + 0.5 + b;
    v = v <= 0 ? 0 : v >= 1 ? 1 : Math.pow(v, ig);
    t[i] = invert ? 1 - v : v;
  }
  return t;
}

export function blendTones(a, b, mode, mix) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    let r;
    switch (mode) {
      case 'screen': r = 1 - (1 - x) * (1 - y); break;
      case 'multiply': r = x * y; break;
      case 'difference': r = Math.abs(x - y); break;
      case 'lighten': r = x > y ? x : y; break;
      case 'darken': r = x < y ? x : y; break;
      default: r = (x + y) / 2;
    }
    out[i] = x + (r - x) * mix;
  }
  return out;
}

export function blendBits(a, b, w, mode, mix) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const x = i % w, y = (i / w) | 0;
    const take = bayer8[(y & 7) * 8 + (x & 7)] < mix;
    if (!take) { out[i] = a[i]; continue; }
    switch (mode) {
      case 'screen': case 'lighten': out[i] = a[i] | b[i]; break;
      case 'multiply': case 'darken': out[i] = a[i] & b[i]; break;
      case 'difference': out[i] = a[i] ^ b[i]; break;
      default: out[i] = b[i]; // average → interleave the two patterns
    }
  }
  return out;
}

/**
 * opts: { algo, threshold, strength, serpentine, cell, angle }
 */
export function dither(tone, w, h, opts) {
  const { algo } = opts;
  const bias = 0.5 - opts.threshold;
  const out = new Uint8Array(w * h);

  if (KERNELS[algo]) return diffuse(tone, w, h, KERNELS[algo], opts);

  if (algo === 'threshold') {
    for (let i = 0; i < out.length; i++) out[i] = tone[i] + bias > 0.5 ? 1 : 0;
    return out;
  }
  if (algo === 'random') {
    for (let i = 0; i < out.length; i++) out[i] = tone[i] + bias > Math.random() ? 1 : 0;
    return out;
  }
  if (algo.startsWith('bayer')) {
    const n = +algo.slice(5), m = bayer(n), mask = n - 1;
    for (let y = 0, i = 0; y < h; y++) {
      const row = (y & mask) * n;
      for (let x = 0; x < w; x++, i++) out[i] = tone[i] + bias > m[row + (x & mask)] ? 1 : 0;
    }
    return out;
  }
  if (algo === 'ign') {
    for (let y = 0, i = 0; y < h; y++)
      for (let x = 0; x < w; x++, i++) {
        const v = 52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1);
        out[i] = tone[i] + bias > v - Math.floor(v) ? 1 : 0;
      }
    return out;
  }
  if (algo === 'halftone' || algo === 'lines') {
    const cell = Math.max(2, opts.cell);
    const a = (opts.angle * Math.PI) / 180;
    const cs = Math.cos(a) / cell, sn = Math.sin(a) / cell;
    const TAU = Math.PI * 2;
    const dot = algo === 'halftone';
    for (let y = 0, i = 0; y < h; y++)
      for (let x = 0; x < w; x++, i++) {
        const u = (x + 0.5) * cs + (y + 0.5) * sn;
        const v = -(x + 0.5) * sn + (y + 0.5) * cs;
        const m = dot ? 0.5 + 0.25 * (Math.cos(TAU * u) + Math.cos(TAU * v)) : 0.5 + 0.5 * Math.cos(TAU * v);
        out[i] = tone[i] + bias > m ? 1 : 0;
      }
    return out;
  }
  return out;
}

function diffuse(tone, w, h, { div, k }, opts) {
  const buf = Float32Array.from(tone);
  const out = new Uint8Array(w * h);
  const t = opts.threshold;
  const s = opts.strength / div;
  for (let y = 0; y < h; y++) {
    const rev = opts.serpentine && (y & 1);
    for (let j = 0; j < w; j++) {
      const x = rev ? w - 1 - j : j;
      const i = y * w + x;
      const old = buf[i];
      const bit = old > t ? 1 : 0;
      out[i] = bit;
      const err = (old - bit) * s;
      for (let q = 0; q < k.length; q++) {
        const dx = rev ? -k[q][0] : k[q][0];
        const nx = x + dx, ny = y + k[q][1];
        if (nx < 0 || nx >= w || ny >= h) continue;
        buf[ny * w + nx] += err * k[q][2];
      }
    }
  }
  return out;
}
