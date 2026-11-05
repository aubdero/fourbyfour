# four by four

a one-bit dithering press for images and video, in the browser: black & white, or color (one bit per rgb channel, eight muted inks).

a rapid prototyping project built at impulse @ georgia tech. it's based on dithermark and on komal yadav's double exposure touchdesigner project.

```
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

- **images** (≤ 25 mb each, up to 24 at once) → png / jpg
- **videos** (≤ 500 mb each, max two) → mp4 / mov (h.264 via webcodecs) / gif
- two videos are trimmed to the same length and framed to the same width × height, then combined as a double exposure: either blend tones then dither, or dither each and combine the bits.
- a video can also be double exposed with one still image (with a video loaded, only one image can be added).
- images can be double exposed too: click two thumbnails in the strip, then combine. a pair can be split again with "separate".

play around with all the settings (method, pixel size, threshold, tone, blend mode) to get exactly the result you want. small changes can look very different.

found a bug? please open an issue, or send a pull request if you have a fix.

source layout: `src/dither.js` (algorithms), `src/export.js` (encoders), `src/main.js` (ui/state).
