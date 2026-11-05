import {
  Output, Mp4OutputFormat, MovOutputFormat, BufferTarget, CanvasSource,
  canEncodeVideo, QUALITY_VERY_HIGH,
} from 'mediabunny';
import { GIFEncoder } from 'gifenc';

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Nearest-neighbour upscale of the 1-bit preview canvas into a fresh canvas. */
export function scaleCanvas(src, w, h, target) {
  const c = target || document.createElement('canvas');
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

export async function exportImage(src, { w, h, format, quality, name }) {
  const c = scaleCanvas(src, w, h);
  const type = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise((r) => c.toBlob(r, type, quality));
  if (!blob) throw new Error('The browser could not encode this image (it may be too large).');
  download(blob, `${name}.${format}`);
}

/**
 * Renders `frames` frames by calling `renderFrame(i)` (which must update `src`),
 * then encodes them into MP4 / MOV / GIF.
 */
export async function exportVideo(src, { w, h, format, fps, frames, name, renderFrame, onProgress, isCancelled }) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  if (format === 'gif') {
    const gif = GIFEncoder();
    const palette = [[0, 0, 0], [255, 255, 255]];
    const delay = Math.round(1000 / fps);
    const idx = new Uint8Array(w * h);
    for (let i = 0; i < frames; i++) {
      if (isCancelled()) return false;
      await renderFrame(i);
      scaleCanvas(src, w, h, canvas);
      const px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
      for (let j = 0, p = 0; j < idx.length; j++, p += 4) idx[j] = px[p] > 127 ? 1 : 0;
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
  let codec = 'avc';
  if (!(await canEncodeVideo('avc', { width: w, height: h }))) {
    if (format === 'mp4' && (await canEncodeVideo('vp9', { width: w, height: h }))) codec = 'vp9';
    else throw new Error(`H.264 encoding at ${w}×${h} is not supported here. Try a smaller size, or GIF.`);
  }

  const output = new Output({
    format: format === 'mov' ? new MovOutputFormat() : new Mp4OutputFormat(),
    target: new BufferTarget(),
  });
  const source = new CanvasSource(canvas, { codec, bitrate: QUALITY_VERY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  for (let i = 0; i < frames; i++) {
    if (isCancelled()) { await output.cancel(); return false; }
    await renderFrame(i);
    scaleCanvas(src, w, h, canvas);
    await source.add(i / fps, 1 / fps);
    onProgress((i + 1) / frames);
  }
  await output.finalize();
  const type = format === 'mov' ? 'video/quicktime' : 'video/mp4';
  download(new Blob([output.target.buffer], { type }), `${name}.${format}`);
  return true;
}
