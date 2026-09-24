// Radar nowcast, like Windy's "next 1 h": take the newest radar picture, measure how the
// rain moved over the last 30 minutes, and keep sliding it that way. Detailed like radar,
// but it only moves existing rain — it can't grow or kill storms — so it's used for the
// first hour and faded into the model forecast over the second.
import type { Map as MLMap, CanvasSource } from 'maplibre-gl';
import { fetchDbzTile, paintDbz } from './radar-colors';

const MIN = 60_000;
const TILE = 256;
const PAIR_GAP = 30 * MIN;  // motion measured between the newest picture and the one 30 min before
const MAX_TILES = 16;       // per picture, to stay well inside RainViewer's 100 requests/minute
// motion search, on a 1/4 resolution copy: blocks of 8 px (= 32 full px), shifts up to 5 px (= 20 full px / 30 min)
const DS = 4, BS = 8, R = 5;

const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const x2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const y2lat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

export interface RadarFrame { t: number; url: string } // url has {z}/{x}/{y}

export class Nowcast {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private img: ImageData | null = null;
  private source?: CanvasSource;
  private key = '';
  private wanted = '';
  private base: Uint8Array | null = null;   // newest radar picture, dBZ
  private vx: Float32Array | null = null;   // motion, full px per minute
  private vy: Float32Array | null = null;
  private W = 0; private H = 0;
  private drawn = '';
  private visible = false;
  onReady: () => void = () => {};

  constructor(private map: MLMap, beforeId?: string) {
    this.canvas.width = this.canvas.height = TILE;
    map.addSource('nowcast', { type: 'canvas', canvas: this.canvas, animate: false, coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] });
    map.addLayer({ id: 'nowcast', type: 'raster', source: 'nowcast', layout: { visibility: 'none' },
      paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, beforeId);
    this.source = map.getSource('nowcast') as CanvasSource;
  }

  get ready() { return this.base !== null && this.key === this.wanted; }

  /** Make sure motion is measured for the area in view; runs in the background. */
  prepare(frames: RadarFrame[]) {
    if (frames.length < 2) return;
    const newest = frames[frames.length - 1];
    const older = [...frames].reverse().find((f) => newest.t - f.t >= PAIR_GAP - 5 * MIN) ?? frames[0];
    const b = this.map.getBounds();
    let z = Math.max(3, Math.min(6, Math.floor(this.map.getZoom())));
    let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    for (; z >= 3; z--) {
      x0 = Math.floor(lon2x(b.getWest(), z)); x1 = Math.floor(lon2x(b.getEast(), z));
      y0 = Math.floor(lat2y(Math.min(85, b.getNorth()), z)); y1 = Math.floor(lat2y(Math.max(-85, b.getSouth()), z));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES) break;
    }
    const key = `${z}/${x0}/${x1}/${y0}/${y1}/${newest.t}/${older.t}`;
    if (key === this.wanted) return;
    this.wanted = key;
    this.compute(key, z, x0, x1, y0, y1, newest, older).catch(() => { /* radar is optional */ });
  }

  private async compute(key: string, z: number, x0: number, x1: number, y0: number, y1: number, newest: RadarFrame, older: RadarFrame) {
    const nx = x1 - x0 + 1, ny = y1 - y0 + 1, W = nx * TILE, H = ny * TILE;
    const mosaic = async (f: RadarFrame) => {
      const out = new Uint8Array(W * H);
      const jobs: Promise<void>[] = [];
      for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
        const url = f.url.replace('{z}', String(z)).replace('{x}', String(x0 + tx)).replace('{y}', String(y0 + ty));
        jobs.push(fetchDbzTile(url).then(({ z: d }) => {
          for (let r = 0; r < TILE; r++) out.set(d.subarray(r * TILE, r * TILE + TILE), (ty * TILE + r) * W + tx * TILE);
        }).catch(() => { /* missing tile = no rain */ }));
      }
      await Promise.all(jobs);
      return out;
    };
    const [a, b] = await Promise.all([mosaic(older), mosaic(newest)]);
    if (this.wanted !== key) return; // the view moved on meanwhile
    const minutes = (newest.t - older.t) / MIN;
    const { vx, vy } = motion(a, b, W, H, minutes);
    this.base = b; this.vx = vx; this.vy = vy; this.W = W; this.H = H; this.key = key;
    this.canvas.width = W; this.canvas.height = H;
    this.img = this.ctx.createImageData(W, H);
    this.source!.setCoordinates([
      [x2lon(x0, z), y2lat(y0, z)], [x2lon(x1 + 1, z), y2lat(y0, z)],
      [x2lon(x1 + 1, z), y2lat(y1 + 1, z)], [x2lon(x0, z), y2lat(y1 + 1, z)],
    ]);
    this.drawn = '';
    this.onReady();
  }

  /** Show the picture `leadMin` minutes after the newest radar image. */
  show(leadMin: number, opacity: number) {
    if (!this.ready || !this.img) { this.hide(); return; }
    const lead = Math.round(leadMin), key = `${this.key}|${lead}|${opacity.toFixed(2)}`;
    if (!this.visible) { this.map.setLayoutProperty('nowcast', 'visibility', 'visible'); this.visible = true; }
    if (key === this.drawn) return;
    this.drawn = key;
    const W = this.W, H = this.H, base = this.base!, vx = this.vx!, vy = this.vy!;
    const warped = new Uint8Array(W * H);
    // semi-Lagrangian: each pixel looks back along the motion to where its rain came from
    for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
      const sx = Math.round(x - vx[i] * lead), sy = Math.round(y - vy[i] * lead);
      if (sx >= 0 && sy >= 0 && sx < W && sy < H) warped[i] = base[sy * W + sx];
    }
    paintDbz(warped, this.img.data, opacity);
    this.ctx.putImageData(this.img, 0, 0);
    const src = this.source!;
    src.play();
    this.map.triggerRepaint();
    this.map.once('render', () => src.pause());
  }

  hide() {
    if (this.visible) { this.map.setLayoutProperty('nowcast', 'visibility', 'none'); this.visible = false; }
  }
}

/** Block matching on a reduced copy: where did each patch of rain in `a` end up in `b`? */
function motion(a: Uint8Array, b: Uint8Array, W: number, H: number, minutes: number) {
  const w = W / DS, h = H / DS;
  const shrink = (src: Uint8Array) => {
    const o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < DS; dy++) for (let dx = 0; dx < DS; dx++) s += src[(y * DS + dy) * W + x * DS + dx];
      o[y * w + x] = s / (DS * DS);
    }
    return o;
  };
  const sa = shrink(a), sb = shrink(b);
  const bw = Math.floor(w / BS), bh = Math.floor(h / BS);
  const bx = new Float32Array(bw * bh), by = new Float32Array(bw * bh), ok = new Uint8Array(bw * bh);
  for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
    const X = i * BS, Y = j * BS;
    let rainy = 0;
    for (let y = 0; y < BS; y++) for (let x = 0; x < BS; x++) if (sb[(Y + y) * w + X + x] >= 15) rainy++;
    if (rainy < BS * BS * 0.15) continue; // not enough rain here to track
    let best = Infinity, bdx = 0, bdy = 0, zero = Infinity;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      let cost = 0, n = 0;
      for (let y = 0; y < BS; y++) {
        const ya = Y + y - dy;
        if (ya < 0 || ya >= h) continue;
        for (let x = 0; x < BS; x++) {
          const xa = X + x - dx;
          if (xa < 0 || xa >= w) continue;
          cost += Math.abs(sb[(Y + y) * w + X + x] - sa[ya * w + xa]); n++;
        }
      }
      if (n < BS * BS * 0.5) continue;
      cost /= n;
      if (dx === 0 && dy === 0) zero = cost;
      if (cost < best) { best = cost; bdx = dx; bdy = dy; }
    }
    if (best < zero * 0.95 || (bdx === 0 && bdy === 0)) {
      const k = j * bw + i;
      bx[k] = bdx; by[k] = bdy; ok[k] = 1;
    }
  }
  // blocks without rain take the average motion of the ones that had it, then smooth
  let mx = 0, my = 0, cnt = 0;
  for (let k = 0; k < ok.length; k++) if (ok[k]) { mx += bx[k]; my += by[k]; cnt++; }
  if (cnt) { mx /= cnt; my /= cnt; }
  for (let k = 0; k < ok.length; k++) if (!ok[k]) { bx[k] = mx; by[k] = my; }
  for (let pass = 0; pass < 2; pass++) {
    const tx = bx.slice(), ty = by.slice();
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
      let sx = 0, sy = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= bw || jj >= bh) continue;
        sx += tx[jj * bw + ii]; sy += ty[jj * bw + ii]; n++;
      }
      bx[j * bw + i] = sx / n; by[j * bw + i] = sy / n;
    }
  }
  // per full-resolution pixel, bilinear between block centres; reduced px per gap -> full px per minute
  const scale = DS / minutes;
  const vx = new Float32Array(W * H), vy = new Float32Array(W * H);
  const cell = BS * DS;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(bh - 1, Math.max(0, y / cell - 0.5)), j0 = Math.min(bh - 2, Math.floor(fy)), wy = bh > 1 ? fy - j0 : 0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(bw - 1, Math.max(0, x / cell - 0.5)), i0 = Math.min(bw - 2, Math.floor(fx)), wx = bw > 1 ? fx - i0 : 0;
      const k = Math.max(0, j0) * bw + Math.max(0, i0);
      const k1 = bw > 1 ? k + 1 : k, k2 = bh > 1 ? k + bw : k, k3 = bw > 1 && bh > 1 ? k + bw + 1 : k;
      const i = y * W + x;
      vx[i] = ((bx[k] * (1 - wx) + bx[k1] * wx) * (1 - wy) + (bx[k2] * (1 - wx) + bx[k3] * wx) * wy) * scale;
      vy[i] = ((by[k] * (1 - wx) + by[k1] * wx) * (1 - wy) + (by[k2] * (1 - wx) + by[k3] * wx) * wy) * scale;
    }
  }
  return { vx, vy };
}
