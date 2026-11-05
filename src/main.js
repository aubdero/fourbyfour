import { ALGORITHMS, dither, toTone, blendTones, blendBits, isDiffusion, isScreen } from './dither.js';
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
  dither: { algo: 'atkinson', pixel: 2, threshold: 0.5, strength: 1, serpentine: true, cell: 6, angle: 45 },
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

function exportSize() {
  const { W, H } = dims();
  let w = Math.round(W * S.exp.scale), h = Math.round(H * S.exp.scale);
  if (S.exp.format === 'mp4' || S.exp.format === 'mov') { w += w & 1; h += h & 1; }
  return { w, h };
}

// ── rendering ───────────────────────────────────────────
function sample(L, gw, gh) {
  if (work.width !== gw) work.width = gw;
  if (work.height !== gh) work.height = gh;
  wctx.fillStyle = '#808080';
  wctx.fillRect(0, 0, gw, gh);
  const ready = L.kind === 'image' || L.src.readyState >= 2;
  if (ready) {
    const { dw, dh } = cover(L, gw, gh);
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = 'high';
    const c = L.crop;
    wctx.drawImage(L.src, c.x * L.w, c.y * L.h, c.w * L.w, c.h * L.h,
      ((gw - dw) / 2) * (1 + L.panX), ((gh - dh) / 2) * (1 + L.panY), dw, dh);
  }
  return wctx.getImageData(0, 0, gw, gh).data;
}

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
  const tones = layers.map((L) => toTone(sample(L, gw, gh), L, L.invert));
  let bits;
  if (tones.length === 1) bits = dither(tones[0], gw, gh, d);
  else if (S.blend.when === 'before') bits = dither(blendTones(tones[0], tones[1], S.blend.mode, S.blend.mix), gw, gh, d);
  else bits = blendBits(dither(tones[0], gw, gh, d), dither(tones[1], gw, gh, d), gw, S.blend.mode, S.blend.mix);

  if (!imgData) imgData = vctx.createImageData(gw, gh);
  const u32 = new Uint32Array(imgData.data.buffer);
  const paper = S.tone.invert ? 0xff000000 : 0xffffffff;
  const ink = S.tone.invert ? 0xffffffff : 0xff000000;
  for (let i = 0; i < bits.length; i++) u32[i] = bits[i] ? paper : ink;
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

  $('#btnClear').disabled = !has;
  $('#btnExport').disabled = !has || S.busy;
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
  status(notes.length ? notes.join(' ') : `${S.layers.length === 2 ? 'Double exposure ready.' : 'Loaded.'}`, notes.length > 0);
}

function loadVideo(f) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('video');
    el.muted = true; el.playsInline = true; el.preload = 'auto'; el.crossOrigin = 'anonymous';
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
  const arr = S.mode === 'image' ? S.images : S.videos;
  const L = arr[i];
  exitCrop(false);
  if (arr.length === 1) return clearAll();
  pause();
  URL.revokeObjectURL(L.url);
  if (L.kind === 'video') { L.src.removeAttribute('src'); L.src.load(); } else L.src.close?.();
  arr.splice(i, 1);
  S.active = clamp(S.active, 0, S.images.length - 1);
  S.sel = 0;
  if (S.mode === 'video') onChange('time.length');
  showStage(); syncUI(); requestRender();
}

function showStage() {
  const has = S.layers.length > 0;
  $('#drop').hidden = has;
  $('#canvasWrap').hidden = !has;
  $('#hint').hidden = !has;
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
  S.crop = { L, saved, rn: null };
  L.crop = r;
  S.crop.rn = lockRatio(L);
  L.crop = fitRatio(r, S.crop.rn);
  $('#view').hidden = true;
  cropper.hidden = false;
  $('#cropBar').hidden = false;
  $('#hint').hidden = true;
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
  const { L, saved } = S.crop;
  if (!apply) Object.assign(L, saved);
  S.crop = null;
  cropper.hidden = true;
  $('#cropBar').hidden = true;
  $('#view').hidden = false;
  $('#hint').hidden = !S.layers.length;
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
}

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
  const n = S.layers[0]?.name || 'derother';
  return `${n.replace(/\.[^.]+$/, '')}_derother`;
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
  syncUI();
}

$('#btnCancel').onclick = () => { S.cancel = true; };

$('#btnExport').onclick = async () => {
  if (!S.layers.length || S.busy) return;
  exitCrop(true);
  const fmt = S.exp.format;
  const { w, h } = exportSize();
  render();
  try {
    if (S.mode === 'image') {
      await exportImage(view, { w, h, format: fmt, quality: S.exp.quality, name: baseName() });
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
      w, h, format: fmt, fps, frames, name: baseName(),
      renderFrame: async (i) => {
        const t = i / fps;
        await Promise.all(S.videos.map((L) => seek(L.src, Math.min(L.start + t, L.dur - 0.001))));
        render();
        S.time.playhead = t;
        updateTimecode();
      },
      onProgress: (p) => {
        $('#progress div').style.width = `${(p * 100).toFixed(1)}%`;
        status(`Rendering… ${Math.round(p * 100)}%`);
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
  if (S.crop && e.key === 'Enter') { e.preventDefault(); return exitCrop(true); }
  if (S.crop && e.key === 'Escape') { e.preventDefault(); return exitCrop(false); }
  if (e.code !== 'Space' || S.mode !== 'video') return;
  if (/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName)) return;
  e.preventDefault();
  S.playing ? pause() : play();
});

syncUI();
