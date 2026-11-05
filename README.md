# four by four

A one-bit dithering press for images and video, in the browser: black & white, or colour (one bit per RGB channel, eight muted inks).

```
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

- **Images** (≤ 25 MB each, up to 24 at once) → PNG / JPG
- **Videos** (≤ 500 MB each, max two) → MP4 / MOV (H.264 via WebCodecs) / GIF
- Two videos are trimmed to the same length and framed to the same width × height, then combined as a double exposure: either blend tones then dither, or dither each and combine the bits.

Source layout: `src/dither.js` (algorithms), `src/export.js` (encoders), `src/main.js` (UI/state).
