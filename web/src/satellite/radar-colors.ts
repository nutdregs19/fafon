// RainViewer's free tiles come in one fixed palette ("Universal Blue"). Every opaque
// pixel maps to exactly one dBZ value, so we decode each tile back to dBZ and repaint
// it with the same Windy-style rain palette the forecast layer uses.
// Table: https://www.rainviewer.com/files/rainviewer_api_colors_table.csv (rain rows, alpha 255)
import { addProtocol } from 'maplibre-gl';
import { RAMPS, cachedLut, lutIndex, mmhFromDbz } from '../map/palettes';
import { decodeDbz } from '../alert/radar-table';

export { decodeDbz };
export const PROTOCOL = 'rvc';

let paintTable: Uint8ClampedArray | null = null;
/** dBZ (0..80) -> RGBA in our rain palette; nothing below 15 dBZ. */
function paint() {
  if (!paintTable) {
    const lut = cachedLut(RAMPS.rain);
    paintTable = new Uint8ClampedArray(81 * 4);
    for (let d = 0; d <= 80; d++) {
      const k = lutIndex(RAMPS.rain, mmhFromDbz(d));
      paintTable.set([lut[k], lut[k + 1], lut[k + 2], d < 15 ? 0 : lut[k + 3]], d * 4);
    }
  }
  return paintTable;
}

const med = new Uint8Array(9);
/**
 * Clean-up in a 3x3 window, counting only rainy neighbours (zoomed out, rain arrives as
 * sparse dots, so a plain median would erase it all):
 *  - 3+ rainy cells around: median of those -> fills pinholes, joins dots into smooth cells
 *  - a lone rainy pixel (clutter spike): dropped
 * Then radar-site clutter (e.g. the magenta ring near Tanintharyi): very strong echoes with
 * no moderate rain anywhere around them. Real storm cores are always wrapped in moderate rain.
 */
export function cleanDbz(z: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy));
      const v = z[yy * w + xx];
      if (v > 0) med[n++] = v;
    }
    const self = z[y * w + x];
    let m = 0;
    if (n >= 3) m = med.subarray(0, n).sort()[n >> 1];
    else if (n === 2 && self > 0) m = self;
    o[y * w + x] = Math.min(80, m);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (o[i] < 50) continue;
    let wrapped = false;
    for (let dy = -3; dy <= 3 && !wrapped; dy++) for (let dx = -3; dx <= 3; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const v = o[yy * w + xx];
      if (v >= 15 && v < 45) { wrapped = true; break; }
    }
    if (!wrapped) o[i] = 0;
  }
  return o;
}

/** dBZ -> RGBA pixels, scaled by an extra opacity factor. */
export function paintDbz(o: Uint8Array, out: Uint8ClampedArray, alpha = 1) {
  const t = paint();
  for (let i = 0, p = 0; i < o.length; i++, p += 4) {
    const k = o[i] * 4;
    out[p] = t[k]; out[p + 1] = t[k + 1]; out[p + 2] = t[k + 2]; out[p + 3] = t[k + 3] * alpha;
  }
}

/** Fetch one RainViewer tile (https URL) as cleaned dBZ. */
export async function fetchDbzTile(url: string, signal?: AbortSignal, clean = true): Promise<{ z: Uint8Array; w: number; h: number }> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('radar tile ' + res.status);
  const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const w = cv.width, h = cv.height;
  const raw = decodeDbz(ctx.getImageData(0, 0, w, h).data, w * h);
  return { z: clean ? cleanDbz(raw, w, h) : raw, w, h };
}

let registered = false;

export function registerRadarProtocol() {
  if (registered) return;
  registered = true;
  addProtocol(PROTOCOL, async (params, abort) => {
    const { z, w, h } = await fetchDbzTile('https://' + params.url.slice(PROTOCOL.length + 3), abort.signal);
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    paintDbz(z, img.data);
    ctx.putImageData(img, 0, 0);
    return { data: await createImageBitmap(cv) };
  });
}
