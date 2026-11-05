import { ALGORITHMS, COLOR_PALETTE, dither, toTone, blendTones, blendBits, isDiffusion, isScreen } from './dither.js';
import { exportImage, exportVideo } from './export.js';

const MB = 1024 * 1024;
const LIMITS = { image: 25 * MB, video: 500 * MB, videos: 2, images: 24 };
const MAX_SIDE = { image: 4096, video: 1920 };
const LAYER_TONE = { brightness: 0, contrast: 0.1, gamma: 1 }; // starting tone for each new layer

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ── state ───────────────────────────────────────────────
const S = {
  mode: null,          // 'image' | 'video'
  images: [],          // image layers
  active: 0,           // selected image
  videos: [],          // video layers (max 2)
  sel: 0,              // layer being adjusted (A/B)
  get layers() { return this.mode === 'image' ? [this.images[this.active]].filter(Boolean) : this.videos; },
  get layer() { return this.layers[this.sel] || this.layers[0]; },
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
function status(msg, err = false) {
  statusEl.innerHTML = '';
  const s = document.createElement(err ? 'span' : 'i');
  if (err) s.className = 'err';
  s.textContent = msg;
  statusEl.append(s);
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

// Every dither cell becomes a whole number of output pixels, so the export is an
// exact enlargement of the preview grid (a fractional cell size, e.g. pixel 1 at ½×,
// would drop or double rows and columns unevenly).
function exportSize() {
  const { gw, gh } = dims();
  const cell = Math.max(1, Math.round(S.dither.pixel * S.exp.scale));
  let w = gw * cell, h = gh * cell;
  // H.264 needs even sizes: trim the odd last row / column rather than stretch the image
  if (S.exp.format === 'mp4' || S.exp.format === 'mov') { w = w > 1 ? w - (w & 1) : 2; h = h > 1 ? h - (h & 1) : 2; }
  return { w, h, cell };
}

// ── rendering ───────────────────────────────────────────
// Jitter: a small random shift of the whole picture, new on every output frame.
// It's seeded by the frame number, so playback and export shake identically.
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

// colour-mode inks as ImageData words (little-endian ABGR)
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
  // black & white: one plane from luminance; colour: one plane each for R, G, B
  const channels = d.color ? [0, 1, 2] : ['luma'];
  const planes = channels.map((ch) => {
    const tones = layers.map((L, i) => toTone(pixels[i], L, L.invert, ch));
    if (tones.length === 1) return dither(tones[0], gw, gh, d);
    if (S.blend.when === 'before') return dither(blendTones(tones[0], tones[1], S.blend.mode, S.blend.mix), gw, gh, d);
    return blendBits(dither(tones[0], gw, gh, d), dither(tones[1], gw, gh, d), gw, S.blend.mode, S.blend.mix);
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

let pending = false;
function requestRender() {
  if (pending || S.playing) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
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
  let obj = parts[0] === 'layer' ? S.layer : S[parts[0]];
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
  if (S.crop && p.startsWith('frame.')) relockCrop();
  if (p === 'time.length') {
    for (const L of S.videos) L.start = clamp(L.start, 0, Math.max(0, L.dur - S.time.length));
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
  const two = vid && S.videos.length === 2;
  const panel = $('#panel');
  panel.setAttribute('aria-disabled', String(!has));

  const show = {
    video: vid, double: two, layer0: vid, layer1: two,
    diffusion: isDiffusion(S.dither.algo), screen: isScreen(S.dither.algo),
    jitter: vid && S.dither.jitter,
    jpg: S.exp.format === 'jpg',
  };
  for (const el of $$('[data-show]')) el.hidden = !show[el.dataset.show];

  // time ranges
  if (vid) {
    const maxLen = Math.min(...S.videos.map((L) => L.dur));
    const len = $('[data-k="time.length"]');
    len.max = maxLen.toFixed(2);
    S.videos.forEach((L, i) => { $(`[data-k="layers.${i}.start"]`).max = Math.max(0, L.dur - S.time.length).toFixed(2); });
    $('#timeNote').textContent = `longest possible clip: ${maxLen.toFixed(2)}s`;
    $('#scrub').max = S.time.length;
  }

  // frame size
  const max = MAX_SIDE[S.mode] || 4096;
  for (const k of ['w', 'h']) $(`[data-k="frame.${k}"]`).max = max;
  if (has) {
    const { W, H } = dims();
    if (S.frame.aspect !== 'custom') { S.frame.w = W; S.frame.h = H; }
  }
  $('[data-k="frame.h"]').disabled = S.frame.aspect !== 'custom';

  // export formats
  const fmts = vid ? [['mp4', 'MP4 · H.264'], ['mov', 'MOV · QuickTime'], ['gif', 'GIF']] : [['png', 'PNG'], ['jpg', 'JPG']];
  const fmtSel = $('#fmt');
  if (fmtSel.dataset.mode !== S.mode) {
    fmtSel.innerHTML = fmts.map(([v, l]) => `<option value="${v}">${l.toLowerCase()}</option>`).join('');
    fmtSel.dataset.mode = S.mode;
    if (!fmts.some(([v]) => v === S.exp.format)) S.exp.format = fmts[0][0];
    show.jpg = S.exp.format === 'jpg';
    $('[data-show="jpg"]').hidden = !show.jpg;
  }
  if (has) {
    const { w, h } = exportSize();
    const { gw, gh } = dims();
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

  $('#btnClear').disabled = !has || S.busy;
  $('#btnExport').disabled = !has || S.busy;
  for (const b of $$('#files button')) b.disabled = S.busy;
  $('#btnSwap').disabled = S.busy;
}

// ── files ───────────────────────────────────────────────
const isVideo = (f) => f.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|mkv)$/i.test(f.name);
const isImage = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(f.name);
const fmtSize = (b) => (b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);

async function handleFiles(list) {
  if (S.busy) return;
  const files = [...list];
  const imgs = files.filter(isImage);
  const vids = files.filter(isVideo);
  const notes = [];

  if (!imgs.length && !vids.length) return status('Those files are not images or videos.', true);
  if (imgs.length && vids.length) return status('Choose images or videos — not both at once.', true);

  const want = imgs.length ? 'image' : 'video';
  if (S.mode && S.mode !== want) clearAll();

  if (want === 'image') {
    const ok = imgs.filter((f) => {
      if (f.size > LIMITS.image) { notes.push(`${f.name} is ${fmtSize(f.size)} — the limit is 25 MB.`); return false; }
      return true;
    }).slice(0, LIMITS.images - S.images.length);
    for (const f of ok) {
      if (S.images.length >= LIMITS.images) break; // another drop may have filled the room while this one loaded
      try {
        const bmp = await createImageBitmap(f);
        S.images.push({ kind: 'image', name: f.name, size: f.size, src: bmp, w: bmp.width, h: bmp.height, crop: { x: 0, y: 0, w: 1, h: 1 }, ...LAYER_TONE, zoom: 1, panX: 0, panY: 0, invert: false, url: URL.createObjectURL(f) });
      } catch {
        notes.push(`${f.name} could not be read by this browser.`);
      }
    }
    if (!S.images.length) return status(notes.join(' ') || 'No image loaded.', true);
    const first = !S.mode;
    S.mode = 'image';
    if (first) { S.active = 0; resetFrame(); } else S.active = S.images.length - 1;
  } else {
    const room = LIMITS.videos - S.videos.length;
    if (vids.length > room) notes.push(`Only ${LIMITS.videos} videos at a time${room < vids.length && room > 0 ? ` — kept the first ${room}` : ''}.`);
    const ok = vids.filter((f) => {
      if (f.size > LIMITS.video) { notes.push(`${f.name} is ${fmtSize(f.size)} — the limit is 500 MB.`); return false; }
      return true;
    }).slice(0, Math.max(0, room));
    for (const f of ok) {
      status(`Reading ${f.name}…`);
      try { S.videos.push(await loadVideo(f)); } catch (e) { notes.push(e.message); }
    }
    if (!S.videos.length) return status(notes.join(' ') || 'No video loaded.', true);
    const first = !S.mode;
    S.mode = 'video';
    if (first) resetFrame();
    const maxLen = Math.min(...S.videos.map((L) => L.dur));
    if (first || S.time.length > maxLen) S.time.length = Math.min(maxLen, 10);
    for (const L of S.videos) L.start = clamp(L.start, 0, Math.max(0, L.dur - S.time.length));
    S.time.playhead = 0;
    seekAll(0);
  }

  showStage();
  syncUI();
  requestRender();
  status(notes.join(' '), notes.length > 0);
}

function loadVideo(f) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('video');
    el.muted = true; el.playsInline = true; el.preload = 'auto';
    const url = URL.createObjectURL(f);
    el.onloadeddata = () => {
      el.onloadeddata = el.onerror = null;
      if (!el.videoWidth || !Number.isFinite(el.duration)) { URL.revokeObjectURL(url); return reject(new Error(`${f.name}: could not read its frames.`)); }
      el.addEventListener('seeked', () => { if (!S.busy) requestRender(); });
      resolve({ kind: 'video', name: f.name, size: f.size, src: el, w: el.videoWidth, h: el.videoHeight, dur: el.duration, start: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, ...LAYER_TONE, zoom: 1, panX: 0, panY: 0, invert: false, url });
    };
    el.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${f.name}: this browser can't decode that video (HEVC/ProRes often fail — try H.264 MP4).`)); };
    el.src = url;
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

function clearAll() {
  exitCrop(false);
  pause();
  for (const L of [...S.images, ...S.videos]) {
    URL.revokeObjectURL(L.url);
    if (L.kind === 'video') { L.src.removeAttribute('src'); L.src.load(); } else L.src.close?.();
  }
  S.images = []; S.videos = []; S.mode = null; S.active = 0; S.sel = 0;
  $('#fmt').dataset.mode = '';
  showStage();
  syncUI();
  status('Cleared.');
}

function removeLayer(i) {
  if (S.busy) return;
  const arr = S.mode === 'image' ? S.images : S.videos;
  const L = arr[i];
  exitCrop(false);
  if (arr.length === 1) return clearAll();
  pause();
  URL.revokeObjectURL(L.url);
  if (L.kind === 'video') { L.src.removeAttribute('src'); L.src.load(); } else L.src.close?.();
  arr.splice(i, 1);
  if (S.mode === 'image') {
    if (i < S.active) S.active--; // keep showing the same picture
    S.active = clamp(S.active, 0, S.images.length - 1);
  }
  S.sel = 0;
  if (S.mode === 'video') onChange('time.length');
  showStage(); syncUI(); requestRender();
}

// swap which video clip is layer A and which is layer B
function swapAB() {
  if (S.mode !== 'video' || S.videos.length !== 2 || S.busy) return;
  exitCrop(true);
  const wasPlaying = S.playing;
  pause();
  S.videos.reverse();
  onChange('time.length');
  showStage(); syncUI(); requestRender();
  if (wasPlaying) play();
}
$('#btnSwap').onclick = swapAB;

function showStage() {
  const has = S.layers.length > 0;
  $('#drop').hidden = has;
  $('#canvasWrap').hidden = !has;
  $('#transport').hidden = S.mode !== 'video';
  $('#tray').hidden = !(S.mode === 'image' && S.images.length > 1);

  // tray
  $('#tray').innerHTML = '';
  S.images.forEach((L, i) => {
    const b = document.createElement('button');
    b.style.backgroundImage = `url("${L.url}")`;
    b.title = L.name;
    b.className = i === S.active ? 'on' : '';
    b.onclick = () => { exitCrop(true); S.active = i; showStage(); syncUI(); requestRender(); };
    $('#tray').append(b);
  });

  $('#swapRow').hidden = !(S.mode === 'video' && S.videos.length === 2);

  // file list
  const list = $('#files');
  list.innerHTML = '';
  const arr = S.mode === 'image' ? S.images : S.videos;
  if (!arr.length) list.innerHTML = '<li class="muted"><i>Nothing loaded.</i></li>';
  arr.forEach((L, i) => {
    const li = document.createElement('li');
    const meta = L.kind === 'video' ? `${L.w}×${L.h} · ${L.dur.toFixed(1)}s` : `${L.w}×${L.h} · ${fmtSize(L.size)}`;
    li.innerHTML = `<span class="name"></span><button class="link" title="Remove">remove</button><span></span><span class="meta"></span>`;
    li.querySelector('.name').textContent = L.name;
    li.querySelector('.meta').textContent = meta;
    li.querySelector('.name').style.fontStyle = S.mode === 'image' && i === S.active ? 'italic' : '';
    li.querySelector('button').onclick = () => removeLayer(i);
    list.append(li);
  });
  if (S.mode === 'video' && S.videos.length < 2) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.innerHTML = '<i>Add a second video for a double exposure.</i>';
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
  for (const L of S.videos) L.src.currentTime = Math.min(L.start + t, L.dur - 0.001);
}

function updateTimecode() {
  $('#scrub').value = S.time.playhead;
  $('#timecode').textContent = `${S.time.playhead.toFixed(2)} / ${S.time.length.toFixed(2)}`;
}

// Every play() gets a new id; pause() invalidates it. A loop only keeps running
// while its id is current, so quick pause/play presses can never leave two
// render loops running at once.
let loopId = 0;
let restarting = false;
const playAll = () => Promise.all(S.videos.map((L) => L.src.play().catch(() => {})));

async function play() {
  if (S.mode !== 'video' || S.busy || S.playing) return;
  const id = ++loopId;
  S.playing = true; // set now so the button / space bar toggles to pause while seeking
  if (S.time.playhead >= S.time.length - 0.05) S.time.playhead = 0;
  $('#btnPlay').textContent = 'Pause';
  await Promise.all(S.videos.map((L) => seek(L.src, L.start + S.time.playhead)));
  if (id !== loopId) return;
  await playAll();
  if (id === loopId) loop(id);
}

function pause() {
  loopId++;
  S.playing = false;
  restarting = false;
  for (const L of S.videos) { L.src.pause(); L.src.playbackRate = 1; }
  $('#btnPlay').textContent = 'Play';
}

// Back to the start: stop, wait until every clip has finished seeking, then
// start them together. (Seeking while playing lets the clips drift apart.)
async function restart(id) {
  restarting = true;
  for (const L of S.videos) { L.src.pause(); L.src.playbackRate = 1; }
  await Promise.all(S.videos.map((L) => seek(L.src, L.start)));
  if (id !== loopId) return;
  await playAll();
  if (id === loopId) restarting = false;
}

function loop(id) {
  if (id !== loopId) return;
  if (!restarting) {
    const [A, ...rest] = S.videos;
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
      // hold the last good frame while a clip is seeking, rather than drawing a stale one
      if (!S.videos.some((L) => L.src.seeking)) render();
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
  syncUI();
  if (S.playing) return;
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
  syncUI();
  requestRender();
}, { passive: false });

$$('.layer-pick .chip').forEach((c) => c.onclick = () => { const wasCropping = !!S.crop; exitCrop(true); S.sel = +c.dataset.layer; syncUI(); if (wasCropping) enterCrop(); });

// ── crop ────────────────────────────────────────────────
// S.crop = { L, saved, rn } while the cropper is open. Crop rects are
// normalised to the source (0–1). `rn` is the locked width/height ratio in
// normalised units, or null when the crop is free.
const cropper = $('#cropper');
const cropSrc = $('#cropSrc');
const cropBox = $('#cropBox');
const FULL = () => ({ x: 0, y: 0, w: 1, h: 1 });
const MIN_CROP = 0.02;

// Layer A with a "source" aspect crops freely (it defines the output shape);
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
  const who = S.mode === 'video' && S.videos.length === 2 ? `layer ${'ab'[S.layers.indexOf(L)]} · ` : '';
  const lock = S.crop.rn ? 'ratio locked to the output' : 'hold shift to keep the ratio';
  $('#cropInfo').textContent = `${who}${pw} × ${ph}px · ${lock}`;
  drawTrim();
}

// ── trim (crop mode, videos) ────────────────────────────
// The bar spans the whole clip; the window between the notches is what's used.
// Length is shared by both videos, so the out notch can't run past the other clip's end.
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
  const room = Math.min(Infinity, ...S.videos.filter((o) => o !== L).map((o) => o.dur - o.start));
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
  syncUI();
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
  // lock every setting while exporting (inert also blocks keyboard focus); only Cancel stays live
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
        await Promise.all(S.videos.map((L) => seek(L.src, Math.min(L.start + t, L.dur - 0.001))));
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
  // Enter on a focused button (cancel, reset…) should press that button, not apply the crop
  if (S.crop && e.key === 'Enter' && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); return exitCrop(true); }
  if (S.crop && e.key === 'Escape') { e.preventDefault(); return exitCrop(false); }
  if (e.code !== 'Space' || S.mode !== 'video') return;
  if (/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName)) return;
  e.preventDefault();
  S.playing ? pause() : play();
});

syncUI();
