import {
  Output, Mp4OutputFormat, MovOutputFormat, BufferTarget, CanvasSource,
  canEncodeVideo, Quality,
} from 'mediabunny';
import { GIFEncoder } from 'gifenc';
import { COLOR_PALETTE } from './dither.js';

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Nearest-neighbour upscale of the 1-bit preview canvas: each grid cell becomes a
 * cell × cell block. Anything past w × h (an odd row/column trimmed for H.264) is cut off.
 */
function scaleCanvas(src, w, h, cell, target) {
  const c = target || document.createElement('canvas');
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, src.width * cell, src.height * cell);
  return c;
}

export async function exportImage(src, { w, h, cell, format, quality, name }) {
  const c = scaleCanvas(src, w, h, cell);
  const type = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise((r) => c.toBlob(r, type, quality));
  if (!blob) throw new Error('The browser could not encode this image (it may be too large).');
  download(blob, `${name}.${format}`);
}

/**
 * Renders `frames` frames by calling `renderFrame(i)` (which must update `src`),
 * then encodes them into MP4 / MOV / GIF.
 */
export async function exportVideo(src, { w, h, cell, format, fps, frames, name, color, renderFrame, onProgress, isCancelled }) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  if (format === 'gif') {
    const gif = GIFEncoder();
    // black & white: 2 colours; colour mode: the 8 muted inks (index = r·4 + g·2 + b)
    const palette = color ? COLOR_PALETTE : [[0, 0, 0], [255, 255, 255]];
    const delay = Math.round(1000 / fps);
    const idx = new Uint8Array(w * h);
    for (let i = 0; i < frames; i++) {
      if (isCancelled()) return false;
      await renderFrame(i);
      scaleCanvas(src, w, h, cell, canvas);
      const px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
      if (color) for (let j = 0, p = 0; j < idx.length; j++, p += 4) idx[j] = (px[p] > 127) << 2 | (px[p + 1] > 127) << 1 | (px[p + 2] > 127);
      else for (let j = 0, p = 0; j < idx.length; j++, p += 4) idx[j] = px[p] > 127 ? 1 : 0;
      gif.writeFrame(idx, w, h, i === 0 ? { palette, delay, repeat: 0 } : { delay });
      onProgress((i + 1) / frames);
      if (i % 4 === 0) await new Promise((r) => setTimeout(r)); // keep the UI breathing
    }
    gif.finish();
    download(new Blob([gif.bytes()], { type: 'image/gif' }), `${name}.gif`);
    return true;
  }

  if (typeof VideoEncoder === 'undefined') {
    throw new Error('This browser cannot encode video (WebCodecs missing). Try a recent Chrome, Edge or Safari, or export a GIF.');
  }
  // Dithered frames are pure high-frequency noise, the worst case for a video codec.
  // Under normal settings the encoder smooths the black/white dots into flat grey, and
  // flat grey looks much darker than the same dots do (a 50% dot pattern reads as light
  // grey; a 50% grey pixel is a dark one). So: a near-lossless quantizer, with a high
  // constant bitrate as the fallback for encoders that can't do quantizer mode, and the
  // "detail" hint that tells the encoder to keep edges rather than smooth motion.
  const bitrate = Math.round(Math.min(60e6, Math.max(12e6, w * h * fps * 1.5)));
  let codec = 'avc';
  if (!(await canEncodeVideo('avc', { width: w, height: h, bitrate }))) {
    if (format === 'mp4' && (await canEncodeVideo('vp9', { width: w, height: h, bitrate }))) codec = 'vp9';
    else throw new Error(`H.264 encoding at ${w}×${h} is not supported here. Try a smaller size, or GIF.`);
  }

  // The densest frames (colour dither, especially two videos blended) can come out so
  // large at a near-lossless quantizer that hardware encoders overflow their output
  // buffer and fail mid-export. When that happens, start over with the software
  // encoder, and failing that, a slightly coarser quantizer.
  const attempts = [
    { quantizer: 8, hw: 'no-preference', note: '' },
    { quantizer: 8, hw: 'prefer-software', note: 'Hardware encoder failed; retrying in software. ' },
    { quantizer: 16, hw: 'prefer-software', note: 'Encoder failed again; retrying at lower quality. ' },
  ];
  let lastError;
  for (const a of attempts) {
    const quality = new Quality({ quantizer: a.quantizer, bitrate, bitrateMode: 'constant' });
    const output = new Output({
      format: format === 'mov' ? new MovOutputFormat() : new Mp4OutputFormat(),
      target: new BufferTarget(),
    });
    try {
      const source = new CanvasSource(canvas, {
        codec, quality, contentHint: 'detail', keyFrameInterval: 2, hardwareAcceleration: a.hw,
      });
      output.addVideoTrack(source, { frameRate: fps });
      await output.start();
      for (let i = 0; i < frames; i++) {
        if (isCancelled()) { await output.cancel(); return false; }
        await renderFrame(i);
        scaleCanvas(src, w, h, cell, canvas);
        await source.add(i / fps, 1 / fps);
        onProgress((i + 1) / frames, a.note);
      }
      await output.finalize();
    } catch (e) {
      console.warn(`Encoding failed (quantizer ${a.quantizer}, ${a.hw}):`, e);
      lastError = e;
      try { await output.cancel(); } catch {}
      if (isCancelled()) return false;
      continue;
    }
    const type = format === 'mov' ? 'video/quicktime' : 'video/mp4';
    download(new Blob([output.target.buffer], { type }), `${name}.${format}`);
    return true;
  }
  throw new Error(`Video encoding failed (${lastError?.message || lastError}). Try a smaller size or scale, or GIF.`);
}
