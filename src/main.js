import { ALGORITHMS, COLOR_PALETTE, dither, toTone, blendTones, blendBits, isDiffusion, isScreen } from './dither.js';
import { exportImage, exportVideo } from './export.js';

const MB = 1024 * 1024;
// videos: layers allowed once a video is loaded (two videos, or a video and one image)
const LIMITS = { image: 25 * MB, video: 500 * MB, videos: 2, images: 24 };
const MAX_SIDE = { image: 4096, video: 1920 };
const LAYER_TONE = { brightness: 0, contrast: 0.1, gamma: 1 }; // starting tone for each new layer

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ── state ───────────────────────────────────────────────
const S = {
  mode: null,          // 'image' | 'video'
  images: [],          // strip items: an image layer, or a pair { kind: 'pair', layers: [a, b], blend }
  active: 0,           // item shown in the editor
  picks: [],           // up to two single images picked in the strip, waiting to be combined
  videos: [],          // video-mode layers (max 2): videos, plus at most one still image
  sel: 0,              // layer being adjusted (a/b)
  get item() { return this.mode === 'image' ? this.images[this.active] : null; },
  get layers() {
    if (this.mode !== 'image') return this.videos;
    const it = this.item;
    return !it ? [] : it.kind === 'pair' ? it.layers : [it];
  },
  get layer() { return this.layers[this.sel] || this.layers[0]; },
  // exposure settings: each image pair keeps its own; the two videos use the shared one
  get blendCur() { return this.item?.kind === 'pair' ? this.item.blend : this.blend; },
  frame: { aspect: 'source', w: 1200, h: 1200 },
  time: { length: 5, fps: 24, playhead: 0 },
  dither: { color: false, algo: 'bayer4', pixel: 2, threshold: 0.5, strength: 1, serpentine: true, cell: 6, angle: 45, jitter: false, jitterAmt: 2 },
  tone: { invert: false },   // brightness / contrast / gamma live on each layer
  blend: { when: 'before', mode: 'screen', mix: 1 },
  exp: { format: 'png', scale: 1, quality: 0.92 },
  playing: false,
  busy: false,
  cancel: false,
};

// snapshot of the starting settings, restored by the "clear" button
const SETTINGS = ['frame', 'time', 'dither', 'tone', 'blend', 'exp'];
const DEFAULTS = structuredClone(Object.fromEntries(SETTINGS.map((k) => [k, S[k]])));
function resetSettings() {
  for (const k of SETTINGS) S[k] = structuredClone(DEFAULTS[k]);
}

// ── elements ────────────────────────────────────────────
const view = $('#view');
const vctx = view.getContext('2d');
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
const fileInput = $('#file');

// algorithm list
$('#algo').innerHTML = ALGORITHMS.map((g) =>
  `<optgroup label="${g.group}">${g.items.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</optgroup>`
).join('');

// native dropdown menus ignore css text-transform, so lowercase their text directly
for (const o of $$('option')) o.textContent = o.textContent.toLowerCase();
for (const g of $$('optgroup')) g.label = g.label.toLowerCase();

// ── status ──────────────────────────────────────────────
const statusEl = $('#status');
let flashTimer = 0;
function status(msg, err = false) {
  clearTimeout(flashTimer);
  statusEl.innerHTML = '';
  const s = document.createElement(err ? 'span' : 'i');
  if (err) s.className = 'err';
  s.textContent = msg;
  statusEl.append(s);
}

// a status message that clears itself after a few seconds
// (unless something else has been shown in the meantime)
function flash(msg, ms = 5000) {
  status(msg);
  flashTimer = setTimeout(() => { statusEl.innerHTML = ''; }, ms);
}

// ── geometry ────────────────────────────────────────────
function aspectRatio() {
  const a = S.frame.aspect;
  if (a === 'source') { const L = S.layers[0]; return (L.w * L.crop.w) / (L.h * L.crop.h); }
  if (a === 'custom') return S.frame.w / S.frame.h;
  const [x, y] = a.split(':').map(Number);
  return x / y;
}

function dims() {
  const max = MAX_SIDE[S.mode];
  let W = clamp(Math.round(S.frame.w) || 16, 16, max);
  let H;
  if (S.frame.aspect === 'custom') H = clamp(Math.round(S.frame.h) || 16, 16, max);
  else {
    const ar = aspectRatio();
    H = Math.round(W / ar);
    if (H > max) { H = max; W = Math.round(H * ar); }
    H = Math.max(16, H);
  }
  const px = S.dither.pixel;
  const gw = Math.max(1, Math.round(W / px));
  const gh = Math.max(1, Math.round(H / px));
  return { gw, gh, W: gw * px, H: gh * px };
}

// cover-fit the layer's crop region into the grid (then zoom)
function cover(L, gw, gh) {
  const cw = L.w * L.crop.w, ch = L.h * L.crop.h;
  const s = Math.max(gw / cw, gh / ch) * L.zoom;
  return { dw: cw * s, dh: ch * s, s };
}

// every dither cell becomes a whole number of output pixels, so the export is an
// exact enlargement of the preview grid (a fractional cell size, e.g. pixel 1 at ½×,
// would drop or double rows and columns unevenly).
function exportSize() {
  const { gw, gh } = dims();
  const cell = Math.max(1, Math.round(S.dither.pixel * S.exp.scale));
  let w = gw * cell, h = gh * cell;
  // h.264 needs even sizes: trim the odd last row / column rather than stretch the image
  if (S.exp.format === 'mp4' || S.exp.format === 'mov') { w = w > 1 ? w - (w & 1) : 2; h = h > 1 ? h - (h & 1) : 2; }
  return { w, h, cell };
}

// ── rendering ───────────────────────────────────────────
// jitter: a small random shift of the whole picture, new on every output frame.
// it's seeded by the frame number, so playback and export shake identically.
const hash = (n, k) => { const x = Math.sin(n * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
function jitter() {
  if (S.mode !== 'video' || !S.dither.jitter) return { jx: 0, jy: 0, a: 0 };
  const n = Math.round(S.time.playhead * S.time.fps);
  const a = S.dither.jitterAmt / S.dither.pixel; // output px -> grid cells
  return { jx: (hash(n, 1) * 2 - 1) * a, jy: (hash(n, 2) * 2 - 1) * a, a };
}

function sample(L, gw, gh, jit = { jx: 0, jy: 0, a: 0 }) {
  if (work.width !== gw) work.width = gw;
  if (work.height !== gh) work.height = gh;
  wctx.fillStyle = '#808080';
  wctx.fillRect(0, 0, gw, gh);
  const ready = L.kind === 'image' || L.src.readyState >= 2;
  if (ready) {
    let { dw, dh } = cover(L, gw, gh);
    // when jittering, enlarge just enough that a shift never shows an empty edge
    const m = jit.a ? Math.max((dw + 2 * jit.a) / dw, (dh + 2 * jit.a) / dh) : 1;
    const ex = (dw * m - dw) / 2, ey = (dh * m - dh) / 2;
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = 'high';
    const c = L.crop;
    wctx.drawImage(L.src, c.x * L.w, c.y * L.h, c.w * L.w, c.h * L.h,
      ((gw - dw) / 2) * (1 + L.panX) - ex + jit.jx, ((gh - dh) / 2) * (1 + L.panY) - ey + jit.jy, dw * m, dh * m);
  }
  return wctx.getImageData(0, 0, gw, gh).data;
}

// color-mode inks as imagedata words (little-endian abgr)
const INKS = COLOR_PALETTE.map(([r, g, b]) => (0xff000000 | b << 16 | g << 8 | r) >>> 0);

let imgData = null;
function render() {
  const layers = S.layers;
  if (!layers.length) return;
  if (S.crop) return drawCropper();
  const { gw, gh } = dims();
  if (view.width !== gw || view.height !== gh) {
    view.width = gw; view.height = gh;
    imgData = null;
    fitView();
  }
  const d = S.dither;
  const jit = jitter();
  const pixels = layers.map((L) => sample(L, gw, gh, jit));
  // black & white: one plane from luminance; color: one plane each for r, g, b
  const channels = d.color ? [0, 1, 2] : ['luma'];
  const B = S.blendCur;
  const planes = channels.map((ch) => {
    const tones = layers.map((L, i) => toTone(pixels[i], L, L.invert, ch));
    if (tones.length === 1) return dither(tones[0], gw, gh, d);
    if (B.when === 'before') return dither(blendTones(tones[0], tones[1], B.mode, B.mix), gw, gh, d);
    return blendBits(dither(tones[0], gw, gh, d), dither(tones[1], gw, gh, d), gw, B.mode, B.mix);
  });

  if (!imgData) imgData = vctx.createImageData(gw, gh);
  const u32 = new Uint32Array(imgData.data.buffer);
  const flip = S.tone.invert ? 1 : 0;
  if (planes.length === 1) {
    const bits = planes[0];
    for (let i = 0; i < bits.length; i++) u32[i] = bits[i] ^ flip ? 0xffffffff : 0xff000000;
  } else {
    const [r, g, b] = planes;
    const f = flip * 7; // invert turns every channel bit over
    for (let i = 0; i < r.length; i++) u32[i] = INKS[(r[i] << 2 | g[i] << 1 | b[i]) ^ f];
  }
  vctx.putImageData(imgData, 0, 0);
}

// while playing, the loop renders; a change just marks the frame as needing a redraw.
// videos also mark it whenever they present a new frame, so the loop only re-dithers
// when something actually changed (not on every screen refresh: a 24 fps clip on a
// 120 hz display was being dithered five times per frame).
const RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
let frameDirty = true;
let pending = false;
function requestRender() {
  if (S.playing) { frameDirty = true; return; }
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}

// syncui touches every control; during drags and scrolling, run it once per frame at most
let syncPending = false;
function requestSync() {
  if (syncPending) return;
  syncPending = true;
  requestAnimationFrame(() => { syncPending = false; syncUI(); });
}

function fitView() {
  const wrap = $('#canvasWrap');
  if (wrap.hidden) return;
  const cs = getComputedStyle(wrap);
  const aw = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (S.crop) return fitCropper(aw, ah);
  let k = Math.min(aw / view.width, ah / view.height);
  if (k >= 1) k = Math.floor(k); // whole-number zoom keeps pixels square and crisp
  view.style.width = `${Math.max(1, view.width * k)}px`;
  view.style.height = `${Math.max(1, view.height * k)}px`;
}
new ResizeObserver(fitView).observe($('#canvasWrap'));

// ── binding ─────────────────────────────────────────────
function resolve(path) {
  const parts = path.split('.');
  let obj = parts[0] === 'layer' ? S.layer : parts[0] === 'blend' ? S.blendCur : S[parts[0]];
  for (let i = 1; i < parts.length - 1; i++) obj = obj?.[parts[i]];
  return [obj, parts[parts.length - 1]];
}
const get = (p) => { const [o, k] = resolve(p); return o?.[k]; };
const set = (p, v) => { const [o, k] = resolve(p); if (o) o[k] = v; };

const FMT = {
  x: (v) => `${(+v).toFixed(2)}×`,
  pct: (v) => `${Math.round(v * 100)}%`,
  s: (v) => `${(+v).toFixed(2)}s`,
  px: (v) => `${+v}px`,
  deg: (v) => `${+v}°`,
  signed: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`,
  n2: (v) => (+v).toFixed(2),
};

for (const el of $$('[data-k]')) {
  const ev = el.type === 'range' ? 'input' : 'change';
  el.addEventListener(ev, () => {
    const p = el.dataset.k;
    let v = el.type === 'checkbox' ? el.checked
      : 'bool' in el.dataset ? el.value === 'true'
      : el.type === 'range' || el.type === 'number' || 'num' in el.dataset ? parseFloat(el.value)
      : el.value;
    if (typeof v === 'number' && Number.isNaN(v)) return;
    set(p, v);
    onChange(p);
  });
}

function onChange(p) {
  if (p === 'frame.aspect' && S.frame.aspect === 'custom') {
    const { W, H } = dims();
    S.frame.w = W; S.frame.h = H;
  }
  // keep typed sizes inside the limits, so the field never shows a size that isn't used
  if (p === 'frame.w' || p === 'frame.h') {
    const k = p.slice(6);
    S.frame[k] = clamp(Math.round(S.frame[k]) || 16, 16, MAX_SIDE[S.mode] || 4096);
  }
  if (S.crop && p.startsWith('frame.')) relockCrop();
  if (p === 'dither.color' && S.dither.color) flash('Colors look more saturated in the editor than in the exported file.');
  if (p === 'time.length') {
    for (const L of clips()) L.start = clamp(L.start, 0, Math.max(0, L.dur - S.time.length));
    S.time.playhead = clamp(S.time.playhead, 0, S.time.length);
  }
  if (p.startsWith('layers.') || p === 'time.length') {
    if (!S.playing) seekAll(S.time.playhead);
  }
  syncUI();
  requestRender();
}

function syncUI() {
  const has = S.layers.length > 0;
  const vid = S.mode === 'video';
  const two = S.layers.length === 2; // two videos, or an image pair
  const panel = $('#panel');
  panel.setAttribute('aria-disabled', String(!has));

  const D = has ? dims() : null;

  const show = {
    video: vid, double: two,
    layer0: vid && S.videos[0]?.kind === 'video', layer1: vid && S.videos[1]?.kind === 'video', // start sliders: videos only
    diffusion: isDiffusion(S.dither.algo), screen: isScreen(S.dither.algo),
    jitter: vid && S.dither.jitter,
    jpg: S.exp.format === 'jpg',
  };
  for (const el of $$('[data-show]')) el.hidden = !show[el.dataset.show];

  // time ranges
  if (vid) {
    const maxLen = Math.min(...clips().map((L) => L.dur));
    const len = $('[data-k="time.length"]');
    len.max = maxLen.toFixed(2);
    S.videos.forEach((L, i) => { if (L.kind === 'video') $(`[data-k="layers.${i}.start"]`).max = Math.max(0, L.dur - S.time.length).toFixed(2); });
    $('#timeNote').textContent = `longest possible clip: ${maxLen.toFixed(2)}s`;
    $('#scrub').max = S.time.length;
  }

  // frame size
  const max = MAX_SIDE[S.mode] || 4096;
  for (const k of ['w', 'h']) $(`[data-k="frame.${k}"]`).max = max;
  // only the height follows the shape. the width the person typed is kept as-is
  // (dims() rounds it to whole dither cells); writing the rounded value back made it
  // creep a few px every time the pixel size changed.
  if (has && S.frame.aspect !== 'custom') S.frame.h = D.H;
  $('[data-k="frame.h"]').disabled = S.frame.aspect !== 'custom';

  // export formats
  const fmts = vid ? [['mp4', 'MP4 · H.264'], ['mov', 'MOV · QuickTime'], ['gif', 'GIF']] : [['png', 'PNG'], ['jpg', 'JPG']];
  const fmtSel = $('#fmt');
  // (dataset values are strings: compare as strings, or a null mode rebuilt the list on every sync)
  if (fmtSel.dataset.mode !== String(S.mode)) {
    fmtSel.innerHTML = fmts.map(([v, l]) => `<option value="${v}">${l.toLowerCase()}</option>`).join('');
    fmtSel.dataset.mode = String(S.mode);
    if (!fmts.some(([v]) => v === S.exp.format)) S.exp.format = fmts[0][0];
    show.jpg = S.exp.format === 'jpg';
    $('[data-show="jpg"]').hidden = !show.jpg;
  }
  if (has) {
    const { w, h } = exportSize();
    const { gw, gh } = D;
    const frames = vid ? ` · ${Math.max(1, Math.round(S.time.length * S.time.fps))} frames` : '';
    $('#outSize').textContent = `Output ${w} × ${h}px · grid ${gw} × ${gh}${frames}`;
  }

  // layer chips
  for (const p of $$('.layer-pick')) p.hidden = !two;
  $$('.layer-pick .chip').forEach((c) => c.classList.toggle('on', +c.dataset.layer === S.sel));

  // write values back to controls
  for (const el of $$('[data-k]')) {
    const v = get(el.dataset.k);
    if (v === undefined) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el || el.type === 'range') el.value = v;
    const out = el.parentElement.querySelector('output');
    if (out) out.textContent = FMT[out.dataset.f]?.(v) ?? v;
  }
  // show the width actually used (whole dither cells)
  const wIn = $('[data-k="frame.w"]');
  if (has && document.activeElement !== wIn) wIn.value = D.W;

  $('#btnClear').disabled = !has || S.busy;
  $('#btnExport').disabled = !has || S.busy;
  for (const b of $$('#files button')) b.disabled = S.busy;
  $('#btnSwap').disabled = S.busy;
}

// ── files ───────────────────────────────────────────────
const isVideo = (f) => f.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|mkv)$/i.test(f.name);
const isImage = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(f.name);
const fmtSize = (b) => (b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);

// one batch of files at a time: a second drop while the first is still being read
// could pass the same limit checks and end up with three layers.
let loading = false;
async function handleFiles(list) {
  if (S.busy) return;
  if (loading) return status('Still reading the previous files. Try again in a moment.', true);
  loading = true;
  try { await addFiles(list); } finally { loading = false; }
}

async function addFiles(list) {
  const files = [...list];
  const imgs = files.filter(isImage);
  const vids = files.filter(isVideo);
  const notes = [];

  if (!imgs.length && !vids.length) return status('Those files are not images or videos.', true);

  // any video (or anything added while a video is loaded) means video mode: two layers
  // at most, either two videos or one video and one still image.
  const want = vids.length || S.mode === 'video' ? 'video' : 'image';
  if (want === 'video' && S.mode === 'image') {
    // a single loaded image comes along as a layer; a bigger collection starts over
    const lone = S.images.length === 1 && S.images[0].kind !== 'pair' ? S.images[0] : null;
    if (lone) {
      exitCrop(false);
      S.images = []; S.picks = []; S.active = 0; S.mode = null;
      S.videos = [lone];
    } else {
      clearAll();
      notes.push('The images were cleared: with a video, only one image can be added.');
    }
  }

  if (want === 'image') {
    const ok = imgs.filter((f) => {
      if (f.size > LIMITS.image) { notes.push(`${f.name} is ${fmtSize(f.size)} — the limit is 25 MB.`); return false; }
      return true;
    }).slice(0, LIMITS.images - imageLayers().length);
    for (const f of ok) {
      if (imageLayers().length >= LIMITS.images) break; // another drop may have filled the room while this one loaded
      try { S.images.push(await loadImage(f)); } catch (e) { notes.push(e.message); }
    }
    if (!S.images.length) return status(notes.join(' ') || 'No image loaded.', true);
    const first = !S.mode;
    S.mode = 'image';
    if (first) { S.active = 0; resetFrame(); } else S.active = S.images.length - 1;
  } else {
    const first = S.mode !== 'video';
    for (const f of vids) {
      if (S.videos.length >= LIMITS.videos) { notes.push(`Only two layers at a time — ${f.name} was left out.`); continue; }
      if (f.size > LIMITS.video) { notes.push(`${f.name} is ${fmtSize(f.size)} — the limit is 500 MB.`); continue; }
      status(`Reading ${f.name}…`);
      try { S.videos.push(await loadVideo(f)); } catch (e) { notes.push(e.message); }
    }
    for (const f of imgs) {
      if (S.videos.length >= LIMITS.videos || S.videos.some((L) => L.kind === 'image')) {
        notes.push(`With a video, only one image can be added — ${f.name} was left out.`);
        continue;
      }
      if (f.size > LIMITS.image) { notes.push(`${f.name} is ${fmtSize(f.size)} — the limit is 25 MB.`); continue; }
      try { S.videos.push(await loadImage(f)); } catch (e) { notes.push(e.message); }
    }
    if (!clips().length) {
      // no video could be read: fall back to plain image editing with whatever image there is
      S.images = S.videos; S.videos = []; S.active = 0;
      if (!S.images.length) { S.mode = null; showStage(); syncUI(); return status(notes.join(' ') || 'No video loaded.', true); }
      S.mode = 'image';
      resetFrame();
    } else {
      S.mode = 'video';
      if (first) resetFrame();
      const maxLen = Math.min(...clips().map((L) => L.dur));
      if (first || S.time.length > maxLen) S.time.length = Math.min(maxLen, 10);
      for (const L of clips()) L.start = clamp(L.start, 0, Math.max(0, L.dur - S.time.length));
      S.time.playhead = 0;
      seekAll(0);
    }
  }

  showStage();
  syncUI();
  requestRender();
  status(notes.join(' '), notes.length > 0);
}

async function loadImage(f) {
  let bmp;
  try { bmp = await createImageBitmap(f); } catch { throw new Error(`${f.name} could not be read by this browser.`); }
  return { kind: 'image', name: f.name, size: f.size, src: bmp, w: bmp.width, h: bmp.height, crop: { x: 0, y: 0, w: 1, h: 1 }, ...LAYER_TONE, zoom: 1, panX: 0, panY: 0, invert: false, url: URL.createObjectURL(f) };
}

function loadVideo(f) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('video');
    el.muted = true; el.playsInline = true; el.preload = 'auto';
    const url = URL.createObjectURL(f);
    el.onloadeddata = async () => {
      el.onloadeddata = el.onerror = null;
      // webm files saved by browsers (mediarecorder) often report an infinite duration
      // until something seeks past the end; do that once to get the real length
      if (el.duration === Infinity) await findDuration(el);
      if (!el.videoWidth || !Number.isFinite(el.duration)) { URL.revokeObjectURL(url); return reject(new Error(`${f.name}: could not read its frames.`)); }
      el.addEventListener('seeked', () => { if (!S.busy) requestRender(); });
      if (RVFC) {
        const tick = () => { frameDirty = true; el.requestVideoFrameCallback(tick); };
        el.requestVideoFrameCallback(tick);
      }
      resolve({ kind: 'video', name: f.name, size: f.size, src: el, w: el.videoWidth, h: el.videoHeight, dur: el.duration, start: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, ...LAYER_TONE, zoom: 1, panX: 0, panY: 0, invert: false, url });
    };
    el.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${f.name}: this browser can't decode that video (HEVC/ProRes often fail — try H.264 MP4).`)); };
    el.src = url;
  });
}

function findDuration(el) {
  return new Promise((res) => {
    const done = () => { clearTimeout(timer); el.removeEventListener('durationchange', check); el.currentTime = 0; res(); };
    const check = () => { if (Number.isFinite(el.duration)) done(); };
    const timer = setTimeout(done, 5000);
    el.addEventListener('durationchange', check);
    el.currentTime = 1e101;
  });
}

function resetFrame() {
  const L = S.layers[0];
  const cap = S.mode === 'video' ? 1080 : 1600;
  S.frame.aspect = 'source';
  S.frame.w = Math.min(L.w, cap);
  S.frame.h = Math.round(S.frame.w * L.h / L.w);
  S.sel = 0;
}

// every image layer, including both halves of each pair
const imageLayers = () => S.images.flatMap((it) => (it.kind === 'pair' ? it.layers : [it]));
// in video mode, the layers that actually move (the other one may be a still image)
const clips = () => S.videos.filter((L) => L.kind === 'video');

function dispose(L) {
  URL.revokeObjectURL(L.url);
  if (L.kind === 'video') { L.src.removeAttribute('src'); L.src.load(); } else L.src.close?.();
}

function clearAll() {
  exitCrop(false);
  pause();
  for (const L of [...imageLayers(), ...S.videos]) dispose(L);
  S.images = []; S.videos = []; S.picks = []; S.mode = null; S.active = 0; S.sel = 0;
  $('#fmt').dataset.mode = '';
  showStage();
  syncUI();
  status('Cleared.');
}

function removeLayer(i) {
  if (S.busy) return;
  const arr = S.mode === 'image' ? S.images : S.videos;
  const it = arr[i];
  exitCrop(false);
  if (arr.length === 1) return clearAll();
  pause();
  for (const L of it.kind === 'pair' ? it.layers : [it]) dispose(L);
  arr.splice(i, 1);
  S.picks = S.picks.filter((p) => p !== it);
  // removing the video from a video + image pairing leaves a plain image
  if (S.mode === 'video' && !clips().length) {
    S.images = S.videos; S.videos = []; S.mode = 'image'; S.active = 0;
    resetFrame();
  }
  if (S.mode === 'image') {
    if (i < S.active) S.active--; // keep showing the same picture
    S.active = clamp(S.active, 0, S.images.length - 1);
  }
  S.sel = 0;
  if (S.mode === 'video') onChange('time.length');
  showStage(); syncUI(); requestRender();
}

// swap which layer is a and which is b (two videos, or an image pair)
function swapAB() {
  if (S.layers.length !== 2 || S.busy) return;
  exitCrop(true);
  if (S.mode === 'image') {
    S.item.layers.reverse();
    showStage(); syncUI(); requestRender();
    return;
  }
  const wasPlaying = S.playing;
  pause();
  S.videos.reverse();
  onChange('time.length');
  showStage(); syncUI(); requestRender();
  if (wasPlaying) play();
}

// ── image pairs ─────────────────────────────────────────
// clicking a thumbnail shows it and picks it (a, then b). clicking a picked one
// un-picks it. with two picked, a popup offers to combine them into one pair item.
// pairs can't be picked themselves, so no more than two images are ever layered.
function pickItem(i) {
  if (S.busy) return;
  exitCrop(true);
  const it = S.images[i];
  if (it.kind === 'pair') {
    S.active = i;
  } else if (S.picks.includes(it)) {
    S.picks = S.picks.filter((p) => p !== it);
  } else {
    if (S.picks.length === 2) S.picks.shift(); // a third pick replaces the oldest
    S.picks.push(it);
    S.active = i;
  }
  S.sel = 0;
  showStage(); syncUI(); requestRender();
}

function combinePicks() {
  if (S.picks.length !== 2 || S.busy) return;
  exitCrop(true);
  const [A, B] = S.picks;
  const at = Math.min(S.images.indexOf(A), S.images.indexOf(B));
  const pair = { kind: 'pair', layers: [A, B], blend: structuredClone(DEFAULTS.blend) };
  S.images = S.images.filter((it) => it !== A && it !== B);
  S.images.splice(at, 0, pair);
  S.active = at;
  S.picks = [];
  S.sel = 0;
  showStage(); syncUI(); requestRender();
  status('Double exposure made. Use separate in the source list to split it again.');
}

function separatePair(i) {
  if (S.busy) return;
  exitCrop(true);
  const pair = S.images[i];
  S.images.splice(i, 1, ...pair.layers);
  S.active = i;
  S.sel = 0;
  showStage(); syncUI(); requestRender();
}

$('#pairGo').onclick = combinePicks;
$('#pairNo').onclick = () => { S.picks = []; showStage(); };
$('#btnSwap').onclick = swapAB;

function showStage() {
  const has = S.layers.length > 0;
  $('#drop').hidden = has;
  $('#canvasWrap').hidden = !has;
  $('#transport').hidden = S.mode !== 'video';
  $('#tray').hidden = !(S.mode === 'image' && imageLayers().length > 1);

  // tray
  const tray = $('#tray');
  tray.innerHTML = '';
  S.images.forEach((it, i) => {
    const b = document.createElement('button');
    b.className = i === S.active ? 'on' : '';
    if (it.kind === 'pair') {
      b.classList.add('pair');
      b.title = `${it.layers[0].name} + ${it.layers[1].name} (double exposure)`;
      for (const L of it.layers) {
        const s = document.createElement('span');
        s.style.backgroundImage = `url("${L.url}")`;
        b.append(s);
      }
    } else {
      b.style.backgroundImage = `url("${it.url}")`;
      b.title = it.name;
      const k = S.picks.indexOf(it);
      if (k >= 0) { b.classList.add('picked'); b.dataset.pick = 'ab'[k]; }
    }
    b.onclick = () => pickItem(i);
    tray.append(b);
  });

  // "double expose these two?" popup, sitting just above the strip
  const pop = $('#pairPop');
  pop.hidden = !(S.mode === 'image' && S.picks.length === 2);
  if (!pop.hidden) {
    const [A, B] = S.picks;
    $$('#pairThumb span').forEach((s, k) => { s.style.backgroundImage = `url("${[A, B][k].url}")`; });
    $('#pairNames').textContent = `${A.name} + ${B.name}`;
    pop.style.bottom = `${tray.offsetHeight + 10}px`;
  }

  $('#swapRow').hidden = S.layers.length !== 2;

  // file list
  const list = $('#files');
  list.innerHTML = '';
  // videos are lettered (they are layers a and b); images are numbered, so the list
  // doesn't clash with the a / b tags on picked thumbnails
  list.classList.toggle('numbered', S.mode === 'image');
  const arr = S.mode === 'image' ? S.images : S.videos;
  if (!arr.length) list.innerHTML = '<li class="muted"><i>Nothing loaded.</i></li>';
  arr.forEach((it, i) => {
    const li = document.createElement('li');
    const pair = it.kind === 'pair';
    const meta = pair ? 'double exposure'
      : it.kind === 'video' ? `${it.w}×${it.h} · ${it.dur.toFixed(1)}s` : `${it.w}×${it.h} · ${fmtSize(it.size)}`;
    li.innerHTML = `<span class="name"></span><button class="link" title="Remove">remove</button><span></span><span class="meta"></span>`;
    li.querySelector('.name').textContent = pair ? `${it.layers[0].name} + ${it.layers[1].name}` : it.name;
    li.querySelector('.meta').textContent = meta;
    li.querySelector('.name').style.fontStyle = S.mode === 'image' && i === S.active ? 'italic' : '';
    li.querySelector('button').onclick = () => removeLayer(i);
    if (pair) {
      const sep = Object.assign(document.createElement('button'), { className: 'link', textContent: 'separate', title: 'Split back into two images' });
      sep.onclick = () => separatePair(i);
      li.append(sep);
    }
    list.append(li);
  });
  const hint = S.mode === 'video' && S.videos.length < 2 ? 'Add a second video, or one image, for a double exposure.'
    : S.mode === 'image' && S.images.filter((it) => it.kind !== 'pair').length >= 2 && S.picks.length < 2
      ? 'Click two thumbnails to double expose them.' : '';
  if (hint) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.innerHTML = `<i>${hint}</i>`;
    list.append(li);
  }
  requestAnimationFrame(fitView);
}

// ── video playback ──────────────────────────────────────
function seek(el, t) {
  return new Promise((res) => {
    if (Math.abs(el.currentTime - t) < 0.0005 && el.readyState >= 2) return res();
    const done = () => { clearTimeout(timer); el.removeEventListener('seeked', done); res(); };
    const timer = setTimeout(done, 4000);
    el.addEventListener('seeked', done);
    el.currentTime = t;
  });
}

function seekAll(t) {
  for (const L of clips()) L.src.currentTime = Math.min(L.start + t, L.dur - 0.001);
}

function updateTimecode() {
  $('#scrub').value = S.time.playhead;
  $('#timecode').textContent = `${S.time.playhead.toFixed(2)} / ${S.time.length.toFixed(2)}`;
}

// every play() gets a new id; pause() invalidates it. a loop only keeps running
// while its id is current, so quick pause/play presses can never leave two
// render loops running at once.
let loopId = 0;
let restarting = false;
let lastJitter = -1;
const playAll = () => Promise.all(clips().map((L) => L.src.play().catch(() => {})));

async function play() {
  if (S.mode !== 'video' || S.busy || S.playing) return;
  const id = ++loopId;
  S.playing = true; // set now so the button / space bar toggles to pause while seeking
  if (S.time.playhead >= S.time.length - 0.05) S.time.playhead = 0;
  $('#btnPlay').textContent = 'Pause';
  await Promise.all(clips().map((L) => seek(L.src, L.start + S.time.playhead)));
  if (id !== loopId) return;
  await playAll();
  if (id === loopId) loop(id);
}

function pause() {
  loopId++;
  S.playing = false;
  restarting = false;
  for (const L of clips()) { L.src.pause(); L.src.playbackRate = 1; }
  $('#btnPlay').textContent = 'Play';
}

// back to the start: stop, wait until every clip has finished seeking, then
// start them together. (seeking while playing lets the clips drift apart.)
async function restart(id) {
  restarting = true;
  for (const L of clips()) { L.src.pause(); L.src.playbackRate = 1; }
  await Promise.all(clips().map((L) => seek(L.src, L.start)));
  if (id !== loopId) return;
  await playAll();
  if (id === loopId) restarting = false;
}

function loop(id) {
  if (id !== loopId) return;
  if (!restarting) {
    const [A, ...rest] = clips();
    const t = A.src.currentTime - A.start;
    if (t >= S.time.length || A.src.ended || (A.src.paused && !A.src.seeking)) {
      restart(id);
    } else {
      for (const L of rest) {
        const target = L.start + t;
        if (L.src.seeking) continue; // let a seek finish instead of starting another
        const drift = L.src.currentTime - target;
        if (Math.abs(drift) > 0.3) { L.src.playbackRate = 1; L.src.currentTime = target; }
        else L.src.playbackRate = clamp(1 - drift * 2, 0.9, 1.1); // nudge gently back into sync
        if (L.src.paused && target < L.dur) L.src.play().catch(() => {});
      }
      S.time.playhead = clamp(t, 0, S.time.length);
      updateTimecode();
      // re-dither only for a new video frame, a changed setting, or a new jitter step.
      // hold the last good frame while a clip is seeking, rather than drawing a stale one.
      const jf = S.dither.jitter ? Math.round(S.time.playhead * S.time.fps) : -1;
      if (!clips().some((L) => L.src.seeking) && (frameDirty || !RVFC || jf !== lastJitter)) {
        frameDirty = false;
        lastJitter = jf;
        render();
      }
    }
  }
  requestAnimationFrame(() => loop(id));
}

$('#btnPlay').onclick = () => (S.playing ? pause() : play());
$('#scrub').addEventListener('input', (e) => {
  pause();
  S.time.playhead = parseFloat(e.target.value);
  seekAll(S.time.playhead);
  updateTimecode();
});

// ── pan & zoom on canvas ────────────────────────────────
let drag = null;
view.addEventListener('pointerdown', (e) => {
  if (!S.layers.length || S.busy) return;
  view.setPointerCapture(e.pointerId);
  view.classList.add('grabbing');
  drag = { x: e.clientX, y: e.clientY };
});
view.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const L = S.layer;
  const { gw, gh } = dims();
  const { dw, dh } = cover(L, gw, gh);
  const k = gw / view.clientWidth;
  const dx = (e.clientX - drag.x) * k, dy = (e.clientY - drag.y) * k;
  drag = { x: e.clientX, y: e.clientY };
  if (dw - gw > 0.5) L.panX = clamp(L.panX + dx / ((gw - dw) / 2), -1, 1);
  if (dh - gh > 0.5) L.panY = clamp(L.panY + dy / ((gh - dh) / 2), -1, 1);
  requestSync();
  requestRender();
});
const endDrag = () => { drag = null; view.classList.remove('grabbing'); };
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);
view.addEventListener('wheel', (e) => {
  if (!S.layers.length || S.busy) return;
  e.preventDefault();
  const L = S.layer;
  L.zoom = clamp(L.zoom * Math.exp(-e.deltaY * 0.0015), 1, 4);
  requestSync();
  requestRender();
}, { passive: false });

$$('.layer-pick .chip').forEach((c) => c.onclick = () => { const wasCropping = !!S.crop; exitCrop(true); S.sel = +c.dataset.layer; syncUI(); if (wasCropping) enterCrop(); });

// ── crop ────────────────────────────────────────────────
// s.crop = { l, saved, rn } while the cropper is open. crop rects are
// normalised to the source (0–1). `rn` is the locked width/height ratio in
// normalised units, or null when the crop is free.
const cropper = $('#cropper');
const cropSrc = $('#cropSrc');
const cropBox = $('#cropBox');
const FULL = () => ({ x: 0, y: 0, w: 1, h: 1 });
const MIN_CROP = 0.02;

// layer a with a "source" aspect crops freely (it defines the output shape);
// every other case locks to the output's width/height so both videos match.
function lockRatio(L) {
  const free = S.frame.aspect === 'source' && S.layers.indexOf(L) === 0;
  if (free) return null;
  const { W, H } = dims();
  return (W / H) * (L.h / L.w);
}

function fitRatio(c, rn) {
  if (!rn) return c;
  let { x, y, w, h } = c;
  if (w / h > rn) { const nw = h * rn; x += (w - nw) / 2; w = nw; }
  else { const nh = w / rn; y += (h - nh) / 2; h = nh; }
  return { x, y, w, h };
}

function enterCrop() {
  if (!S.layers.length || S.busy || S.crop) return;
  pause();
  const L = S.layer;
  const saved = { crop: { ...L.crop }, zoom: L.zoom, panX: L.panX, panY: L.panY };
  // start from exactly what is visible now, so nothing jumps
  const { gw, gh } = dims();
  const { dw, dh, s } = cover(L, gw, gh);
  const ox = ((gw - dw) / 2) * (1 + L.panX), oy = ((gh - dh) / 2) * (1 + L.panY);
  const c = L.crop;
  let r = { x: c.x - ox / s / L.w, y: c.y - oy / s / L.h, w: gw / s / L.w, h: gh / s / L.h };
  r.w = Math.min(r.w, 1); r.h = Math.min(r.h, 1);
  r.x = clamp(r.x, 0, 1 - r.w); r.y = clamp(r.y, 0, 1 - r.h);
  L.zoom = 1; L.panX = 0; L.panY = 0;
  if (L.kind === 'video') saved.start = L.start;
  S.crop = { L, saved, rn: null, len: S.time.length };
  L.crop = r;
  S.crop.rn = lockRatio(L);
  L.crop = fitRatio(r, S.crop.rn);
  $('#view').hidden = true;
  cropper.hidden = false;
  $('#cropBar').hidden = false;
  $('#transport').hidden = true;
  $('#trim').hidden = L.kind !== 'video';
  if (L.kind === 'video') L.src.currentTime = Math.min(L.start + S.time.playhead, L.dur - 0.001);
  fitView();
  drawCropper();
  status('Drag the handles to crop. Double-click or press Enter when done, Esc to cancel.');
}

function relockCrop() {
  const L = S.crop.L;
  S.crop.rn = lockRatio(L);
  L.crop = fitRatio(L.crop, S.crop.rn);
  drawCropper();
}

function exitCrop(apply = true) {
  if (!S.crop) return;
  const { L, saved, len } = S.crop;
  if (!apply) { Object.assign(L, saved); S.time.length = len; }
  S.crop = null;
  cropper.hidden = true;
  $('#cropBar').hidden = true;
  $('#trim').hidden = true;
  $('#transport').hidden = S.mode !== 'video';
  if (S.mode === 'video') {
    S.time.playhead = clamp(S.time.playhead, 0, S.time.length);
    seekAll(S.time.playhead);
    updateTimecode();
  }
  $('#view').hidden = false;
  syncUI();
  fitView();
  requestRender();
  status(apply ? 'Cropped.' : 'Crop cancelled.');
}

function fitCropper(aw, ah) {
  const L = S.crop.L;
  const k = Math.min(aw / L.w, ah / L.h);
  const w = Math.max(1, Math.floor(L.w * k)), h = Math.max(1, Math.floor(L.h * k));
  cropper.style.width = `${w}px`;
  cropper.style.height = `${h}px`;
  const dpr = window.devicePixelRatio || 1;
  cropSrc.width = Math.round(w * dpr);
  cropSrc.height = Math.round(h * dpr);
  drawCropper();
}

function drawCropper() {
  if (!S.crop) return;
  const L = S.crop.L;
  const ctx = cropSrc.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, cropSrc.width, cropSrc.height);
  if (L.kind === 'image' || L.src.readyState >= 2) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(L.src, 0, 0, cropSrc.width, cropSrc.height);
  }
  const c = L.crop;
  Object.assign(cropBox.style, {
    left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%`,
  });
  const pw = Math.round(c.w * L.w), ph = Math.round(c.h * L.h);
  const who = S.layers.length === 2 ? `layer ${'ab'[S.layers.indexOf(L)]} · ` : '';
  const lock = S.crop.rn ? 'ratio locked to the output' : 'hold shift to keep the ratio';
  $('#cropInfo').textContent = `${who}${pw} × ${ph}px · ${lock}`;
  drawTrim();
}

// ── trim (crop mode, videos) ────────────────────────────
// the bar spans the whole clip; the window between the notches is what's used.
// length is shared by both videos, so the out notch can't run past the other clip's end.
const trimTrack = $('#trimTrack');
const trimWin = $('.trim-win');
const MIN_LEN = 0.1;

function drawTrim() {
  const L = S.crop?.L;
  if (!L || L.kind !== 'video') return;
  const len = S.time.length;
  trimWin.style.left = `${(L.start / L.dur) * 100}%`;
  trimWin.style.width = `${(len / L.dur) * 100}%`;
  $('#trimInfo').textContent = `${L.start.toFixed(2)} – ${(L.start + len).toFixed(2)}s · ${len.toFixed(2)}s`;
}

let trimDrag = null;
trimTrack.addEventListener('pointerdown', (e) => {
  const t = e.target.closest('[data-t]');
  if (!t || !S.crop) return;
  e.preventDefault();
  trimTrack.setPointerCapture(e.pointerId);
  const L = S.crop.L;
  const room = Math.min(Infinity, ...clips().filter((o) => o !== L).map((o) => o.dur - o.start));
  trimDrag = { t: t.dataset.t, x: e.clientX, s0: L.start, e0: L.start + S.time.length, room };
});
trimTrack.addEventListener('pointermove', (e) => {
  if (!trimDrag) return;
  const L = S.crop.L;
  const { t, s0, e0, room } = trimDrag;
  const dt = ((e.clientX - trimDrag.x) / trimTrack.clientWidth) * L.dur;
  let s = s0, en = e0, show;
  if (t === 'in') { s = clamp(s0 + dt, Math.max(0, e0 - room), e0 - MIN_LEN); show = s; }
  else if (t === 'out') { en = clamp(e0 + dt, s0 + MIN_LEN, Math.min(L.dur, s0 + room)); show = en; }
  else { s = clamp(s0 + dt, 0, L.dur - (e0 - s0)); en = s + (e0 - s0); show = s; }
  L.start = s;
  S.time.length = en - s;
  S.time.playhead = clamp(S.time.playhead, 0, S.time.length);
  L.src.currentTime = Math.min(show, L.dur - 0.001); // preview the frame at the notch
  drawTrim();
  requestSync();
});
const endTrim = () => { trimDrag = null; };
trimTrack.addEventListener('pointerup', endTrim);
trimTrack.addEventListener('pointercancel', endTrim);

function dragCrop(handle, start, dx, dy, rn) {
  if (handle === 'move') {
    return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
  }
  let x1 = start.x, y1 = start.y, x2 = start.x + start.w, y2 = start.y + start.h;
  if (handle.includes('w')) x1 = clamp(x1 + dx, 0, x2 - MIN_CROP);
  if (handle.includes('e')) x2 = clamp(x2 + dx, x1 + MIN_CROP, 1);
  if (handle.includes('n')) y1 = clamp(y1 + dy, 0, y2 - MIN_CROP);
  if (handle.includes('s')) y2 = clamp(y2 + dy, y1 + MIN_CROP, 1);
  let w = x2 - x1, h = y2 - y1;
  if (!rn) return { x: x1, y: y1, w, h };

  // keep the ratio, anchored on the opposite edge / corner
  const W = handle.includes('w'), E = handle.includes('e'), N = handle.includes('n'), So = handle.includes('s');
  const ax = W ? x2 : E ? x1 : start.x + start.w / 2;
  const ay = N ? y2 : So ? y1 : start.y + start.h / 2;
  if (handle === 'n' || handle === 's') w = h * rn;
  else if (handle === 'e' || handle === 'w') h = w / rn;
  else if (w / h > rn) h = w / rn;
  else w = h * rn;
  const maxW = W ? ax : E ? 1 - ax : 2 * Math.min(ax, 1 - ax);
  const maxH = N ? ay : So ? 1 - ay : 2 * Math.min(ay, 1 - ay);
  const k = Math.min(1, maxW / w, maxH / h);
  w *= k; h *= k;
  return { x: W ? ax - w : E ? ax : ax - w / 2, y: N ? ay - h : So ? ay : ay - h / 2, w, h };
}

let cropDrag = null;
cropper.addEventListener('pointerdown', (e) => {
  const t = e.target.closest('[data-h]');
  if (!t || !S.crop) return;
  e.preventDefault();
  cropper.setPointerCapture(e.pointerId);
  if (t.tagName === 'B') t.classList.add('on');
  const c = S.crop.L.crop;
  cropDrag = { h: t.dataset.h, el: t, x: e.clientX, y: e.clientY, start: { ...c }, ratio: c.w / c.h };
});
cropper.addEventListener('pointermove', (e) => {
  if (!cropDrag) return;
  const dx = (e.clientX - cropDrag.x) / cropper.clientWidth;
  const dy = (e.clientY - cropDrag.y) / cropper.clientHeight;
  const rn = S.crop.rn || (e.shiftKey ? cropDrag.ratio : null);
  S.crop.L.crop = dragCrop(cropDrag.h, cropDrag.start, dx, dy, rn);
  drawCropper();
});
const endCropDrag = () => { cropDrag?.el.classList.remove('on'); cropDrag = null; };
cropper.addEventListener('pointerup', endCropDrag);
cropper.addEventListener('pointercancel', endCropDrag);
cropper.addEventListener('dblclick', () => exitCrop(true));
view.addEventListener('dblclick', enterCrop);

$('#cropDone').onclick = () => exitCrop(true);
$('#cropCancel').onclick = () => exitCrop(false);
$('#cropReset').onclick = () => { S.crop.L.crop = fitRatio(FULL(), S.crop.rn); drawCropper(); };
$('#btnCrop').onclick = enterCrop;
$('#btnCropClear').onclick = () => {
  if (S.crop) return $('#cropReset').click();
  const L = S.layer;
  if (!L) return;
  L.crop = FULL(); L.zoom = 1; L.panX = 0; L.panY = 0;
  syncUI(); requestRender();
};

// ── export ──────────────────────────────────────────────
function baseName() {
  const n = S.layers[0]?.name || 'fourbyfour';
  return `${n.replace(/\.[^.]+$/, '')}_fourbyfour`;
}

function setBusy(on) {
  S.busy = on;
  $('#btnCancel').hidden = !on;
  $('#progress').hidden = !on;
  $('#progress div').style.width = '0';
  $('#btnAdd').disabled = on;
  $('#btnClear').disabled = on;
  $('#btnPlay').disabled = on;
  $('#scrub').disabled = on;
  // lock every setting while exporting (inert also blocks keyboard focus); only cancel stays live
  const sections = $$('#panel > section');
  const exportSection = sections[sections.length - 1];
  for (const s of sections.slice(1, -1)) s.inert = on;
  for (const r of $$('.row', exportSection)) r.inert = on;
  syncUI();
}

$('#btnCancel').onclick = () => { S.cancel = true; };

$('#btnExport').onclick = async () => {
  if (!S.layers.length || S.busy) return;
  exitCrop(true);
  const fmt = S.exp.format;
  const { w, h, cell } = exportSize();
  render();
  try {
    if (S.mode === 'image') {
      await exportImage(view, { w, h, cell, format: fmt, quality: S.exp.quality, name: baseName() });
      status(`Saved ${w} × ${h} ${fmt.toUpperCase()}.`);
      return;
    }
    pause();
    S.cancel = false;
    setBusy(true);
    const fps = S.time.fps;
    const frames = Math.max(1, Math.round(S.time.length * fps));
    const started = performance.now();
    status(`Rendering ${frames} frames…`);
    const ok = await exportVideo(view, {
      w, h, cell, format: fmt, fps, frames, name: baseName(), color: S.dither.color,
      renderFrame: async (i) => {
        const t = i / fps;
        await Promise.all(clips().map((L) => seek(L.src, Math.min(L.start + t, L.dur - 0.001))));
        S.time.playhead = t; // before render(), so jitter uses this frame's number
        render();
        updateTimecode();
      },
      onProgress: (p, note = '') => {
        $('#progress div').style.width = `${(p * 100).toFixed(1)}%`;
        status(`${note}Rendering… ${Math.round(p * 100)}%`);
      },
      isCancelled: () => S.cancel,
    });
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    status(ok ? `Saved ${w} × ${h} ${fmt.toUpperCase()}, ${frames} frames, in ${secs}s.` : 'Export cancelled.');
  } catch (e) {
    console.error(e);
    status(e.message || 'Export failed.', true);
  } finally {
    if (S.busy) {
      setBusy(false);
      S.time.playhead = 0;
      seekAll(0);
      updateTimecode();
    }
  }
};

// ── input wiring ────────────────────────────────────────
$('#btnAdd').onclick = $('#btnChoose').onclick = () => fileInput.click();
fileInput.onchange = () => { handleFiles(fileInput.files); fileInput.value = ''; };
$('#btnClear').onclick = () => {
  clearAll();
  resetSettings();
  syncUI();
  updateTimecode();
};

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#stage').classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#stage').classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#stage').classList.remove('dragging');
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
});

window.addEventListener('keydown', (e) => {
  // enter on a focused button (cancel, reset…) should press that button, not apply the crop
  if (S.crop && e.key === 'Enter' && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); return exitCrop(true); }
  if (S.crop && e.key === 'Escape') { e.preventDefault(); return exitCrop(false); }
  if (e.key === 'Escape' && S.picks.length) { S.picks = []; return showStage(); }
  if (e.code !== 'Space' || S.mode !== 'video' || S.crop) return;
  if (/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName)) return;
  e.preventDefault();
  S.playing ? pause() : play();
});

syncUI();
