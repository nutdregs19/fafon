// RainViewer's free tiles come in one fixed palette ("Universal Blue"). Every opaque
// pixel maps to exactly one dBZ value, so we decode each tile back to dBZ and repaint
// it with the same Windy-style rain palette the forecast layer uses.
// Table: https://www.rainviewer.com/files/rainviewer_api_colors_table.csv (rain rows, alpha 255)
import { addProtocol } from 'maplibre-gl';
import { RAMPS, cachedLut, lutIndex, mmhFromDbz } from '../map/palettes';

const UNIVERSAL_BLUE =
  '15:88ddee 16:6cd1eb 17:51c5e8 18:36bae5 19:1baee2 20:00a3e0 21:009ad5 22:0091ca 23:0088bf 24:007fb4 ' +
  '25:0077aa 26:0070a3 27:00699c 28:006295 29:005b8e 30:005588 31:005180 32:004e78 33:004a70 34:004768 ' +
  '35:ffee00 36:ffe000 37:ffd200 38:ffc500 39:ffb700 40:ffaa00 41:ff9f00 42:ff9500 43:ff8b00 44:ff8100 ' +
  '45:ff4400 46:f23600 47:e62800 48:d91b00 49:cd0d00 50:c10000 51:a80000 52:8f0000 53:760000 54:5d0000 ' +
  '55:ffaaff 56:ff9fff 57:ff95ff 58:ff8bff 59:ff81ff 60:ff77ff 61:ff6cff 62:ff62ff 63:ff58ff 64:ff4eff 65:ffffff';

export const PROTOCOL = 'rvc';

let registered = false;

export function registerRadarProtocol() {
  if (registered) return;
  registered = true;
  // packed 0xRRGGBB -> dBZ, and dBZ -> our palette colour
  const toDbz = new Map<number, number>();
  for (const pair of UNIVERSAL_BLUE.split(' ')) {
    const [d, hex] = pair.split(':');
    toDbz.set(parseInt(hex, 16), Number(d));
  }
  const lut = cachedLut(RAMPS.rain), paint = new Uint8ClampedArray(81 * 4);
  for (let d = 0; d <= 80; d++) {
    const k = lutIndex(RAMPS.rain, mmhFromDbz(d));
    paint.set([lut[k], lut[k + 1], lut[k + 2], d < 15 ? 0 : lut[k + 3]], d * 4);
  }
  const med = new Float32Array(9);

  addProtocol(PROTOCOL, async (params, abort) => {
    const url = 'https://' + params.url.slice(PROTOCOL.length + 3);
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw new Error('radar tile ' + res.status);
    const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const w = cv.width, h = cv.height, img = ctx.getImageData(0, 0, w, h), d = img.data;
    // semi-transparent pixels are the palette's drizzle/noise range below 15 dBZ: count as none
    const z = new Float32Array(w * h), o = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < z.length; i++, p += 4) {
      z[i] = d[p + 3] === 255 ? toDbz.get((d[p] << 16) | (d[p + 1] << 8) | d[p + 2]) ?? 0 : 0;
    }
    // Clean-up in a 3x3 window, counting only rainy neighbours (zoomed out, rain arrives as
    // sparse dots, so a plain median would erase it all):
    //  - 3+ rainy cells around: median of those -> fills pinholes, joins dots into smooth cells
    //  - a lone rainy pixel (clutter spike, the stray pink dots): dropped
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy));
        const v = z[yy * w + xx];
        if (v > 0) med[n++] = v;
      }
      const self = z[y * w + x];
      let m = 0;
      if (n >= 3) {
        const s = med.subarray(0, n).sort();
        m = s[n >> 1];
      } else if (n === 2 && self > 0) m = self;
      o[y * w + x] = Math.min(80, Math.round(m));
    }
    // Radar-site clutter (e.g. the magenta ring near Tanintharyi): very strong echoes with no
    // moderate rain anywhere around them. Real storm cores are always wrapped in moderate rain.
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
    for (let i = 0, p = 0; i < o.length; i++, p += 4) {
      const v = o[i];
      d[p] = paint[v * 4]; d[p + 1] = paint[v * 4 + 1]; d[p + 2] = paint[v * 4 + 2]; d[p + 3] = paint[v * 4 + 3];
    }
    ctx.putImageData(img, 0, 0);
    return { data: await createImageBitmap(cv) };
  });
}
