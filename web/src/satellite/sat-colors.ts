// NASA GIBS serves Himawari infrared already painted in a rainbow "enhanced IR" scale
// (grey for warm/low cloud, then cyan -> blue -> green -> yellow -> red for ever colder,
// higher cloud tops, with the coldest storm cores going dark/grey again inside the red).
// Tiles are resampled, so colours can't be decoded exactly; instead we estimate how
// cold each pixel is from its hue and repaint the picture Windy-style: white cloud on
// a dark map, the higher the cloud the whiter and more solid, clear sky transparent.
import { addProtocol } from 'maplibre-gl';

export const SAT_PROTOCOL = 'gsat';

/** 0 = warm ground/sea, ~0.5 = low/mid cloud, 1 = coldest storm top. NaN = grey, decided later. */
function coldness(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === 0 || (max - min) / max < 0.18) return NaN;
  const d = max - min;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const v = max / 255;
  if (h >= 170 && h < 265) return 0.6 + 0.08 * (1 - v);                  // cyan -> navy
  if (h >= 75 && h < 170) return 0.7 + 0.06 * v;                         // greens
  if (h >= 20 && h < 75) return 0.82 + 0.06 * (1 - (h - 20) / 55);       // yellow -> orange
  return 0.92 + 0.06 * (1 - v);                                          // reds, dark reds
}

let registered = false;

export function registerSatelliteProtocol() {
  if (registered) return;
  registered = true;
  addProtocol(SAT_PROTOCOL, async (params, abort) => {
    const url = 'https://' + params.url.slice(SAT_PROTOCOL.length + 3);
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw new Error('satellite tile ' + res.status);
    const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const w = bmp.width, h = bmp.height;
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, w, h), d = img.data;
    const c = new Float32Array(w * h);
    const hot = new Uint8Array(w * h); // red-class pixels: the cold storm tops
    for (let i = 0, p = 0; i < c.length; i++, p += 4) {
      c[i] = coldness(d[p], d[p + 1], d[p + 2]);
      if (c[i] >= 0.9) hot[i] = 1;
    }
    // Grey pixels reachable from a red storm top through other grey pixels are the
    // coldest cores (the scale turns dark/grey again there). Storm tops are ringed by
    // yellow/green/blue, so the fill never leaks out into ordinary warm grey.
    // Capped at a few pixels in case a ring is broken and red touches warm grey directly.
    const MAX_REACH = 14;
    const queue: number[] = [], dist = new Uint8Array(w * h);
    for (let i = 0; i < hot.length; i++) if (hot[i]) queue.push(i);
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q], x = i % w, y = (i / w) | 0;
      if (dist[i] >= MAX_REACH) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (Number.isNaN(c[j])) { c[j] = 1; dist[j] = dist[i] + 1; queue.push(j); }
      }
    }
    // everything else grey: warm-to-cool grey scale
    for (let i = 0; i < c.length; i++) if (Number.isNaN(c[i])) c[i] = 0.1 + 0.4 * (d[i * 4] / 255);
    // soften the stair-stepped pixel edges: two passes of a 3x3 box blur
    const t = new Float32Array(c.length);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          s += c[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))];
        }
        t[y * w + x] = s / 9;
      }
      c.set(t);
    }
    for (let i = 0, p = 0; i < c.length; i++, p += 4) {
      const k = c[i];
      // clear sky transparent, low cloud faint, high cloud bright and solid
      const a = k < 0.3 ? 0 : k < 0.5 ? ((k - 0.3) / 0.2) * 0.45 : k < 0.6 ? 0.45 + ((k - 0.5) / 0.1) * 0.25 : 0.7 + ((k - 0.6) / 0.4) * 0.3;
      const v = Math.round(190 + 65 * Math.min(1, k));
      d[p] = v; d[p + 1] = v; d[p + 2] = Math.min(255, v + 6); d[p + 3] = Math.round(a * 255);
    }
    ctx.putImageData(img, 0, 0);
    return { data: await createImageBitmap(cv) };
  });
}
