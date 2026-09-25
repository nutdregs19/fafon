// Paints the active weather layer into a canvas laid out in Web-Mercator over the part of the
// world being looked at (plus a margin), then hands it to MapLibre as a canvas source under the
// borders and labels. Several forecasts can be drawn together: the coarse world one first, and a
// fine regional one on top that fades out towards its own edges.
import type { Map as MLMap, CanvasSource } from 'maplibre-gl';
import type { Box, Field, Grid } from '../data/store';
import { RAMPS, cachedLut, lutIndex, type LayerKey } from './palettes';

// Forecast rain below this rate is hidden (fades in over RAIN_FADE): models spread a thin
// drizzle haze over whole regions, which buries the real rain cells. Tapping still reads it.
const RAIN_MIN = 0.35, RAIN_FADE = 0.3; // mm/h
const MAX_LAT = 85;
const CANVAS_W = 720;   // px; about 0.05° per pixel over Thailand, one pixel per half degree for the world
const CANVAS_H_MAX = 1100;

const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unmerc = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;
const clampLat = (l: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, l));

/** Catmull-Rom taps for fractional positions: 4 clamped indices + 4 weights each. */
function cubicTaps(pos: Float32Array, n: number) {
  const idx = new Int32Array(pos.length * 4), wt = new Float32Array(pos.length * 4);
  for (let j = 0; j < pos.length; j++) {
    const p = pos[j], i0 = Math.floor(p), t = p - i0, t2 = t * t, t3 = t2 * t;
    const w = [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
    for (let k = 0; k < 4; k++) {
      idx[j * 4 + k] = Math.min(n - 1, Math.max(0, i0 - 1 + k));
      wt[j * 4 + k] = w[k];
    }
  }
  return { idx, wt };
}

/** Everything that depends on one grid under the current canvas. */
interface Taps {
  colT: { idx: Int32Array; wt: Float32Array };
  rowT: { idx: Int32Array; wt: Float32Array };
  pass: Float32Array;   // grid rows x canvas columns
  weight: Float32Array; // how much this grid counts at each canvas pixel (0..1)
  up: Float32Array;     // resampled value
  upRain: Float32Array; // resampled rain (for rain seen through the cloud layer)
  scalar: Float32Array; // grid-sized scratch
}

export class FieldLayer {
  readonly canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private img!: ImageData;
  private W = 0; private H = 0;
  private lats = new Float32Array(0);  // latitude of each canvas row
  private lons = new Float32Array(0);  // longitude of each canvas column
  private box: Box = { w: 0, s: 0, e: 0, n: 0 };
  private taps = new Map<Grid, Taps>();
  private val = new Float32Array(0);
  private valRain = new Float32Array(0);
  private cover = new Float32Array(0);
  private source?: CanvasSource;

  constructor(private map: MLMap, beforeId?: string) {
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.width = this.canvas.height = 1;
    map.addSource('field', { type: 'canvas', canvas: this.canvas, animate: false, coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] });
    map.addLayer({
      id: 'field', type: 'raster', source: 'field',
      paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
    }, beforeId);
    this.source = map.getSource('field') as CanvasSource;
  }

  /** The area the canvas covers (what the forecasts must supply). */
  get extent(): Box { return this.box; }

  /**
   * Make the canvas cover the map view, with a margin so small pans don't need a redraw.
   * Returns true when the canvas moved (everything must be drawn again).
   */
  fit(): boolean {
    const b = this.map.getBounds();
    const vw = b.getWest(), ve = b.getEast(), vn = clampLat(b.getNorth()), vs = clampLat(b.getSouth());
    const spanX = ve - vw, spanY = merc(vn) - merc(vs);
    const cur = this.box, curY = merc(cur.n) - merc(cur.s);
    const covers = vw >= cur.w && ve <= cur.e && vn <= cur.n && vs >= cur.s;
    // redo when the view left the canvas, or zoomed so far that the canvas is too coarse/wasteful
    const scale = (cur.e - cur.w) / Math.max(1e-6, spanX);
    if (covers && scale < 2.6 && scale > 1.2 && curY / Math.max(1e-6, spanY) < 2.6) return false;

    const mx = spanX * 0.4, my = spanY * 0.4;
    let w = vw - mx, e = ve + mx;
    if (e - w > 360) { const c = (vw + ve) / 2; w = c - 180; e = c + 180; }
    const n = clampLat(unmerc(merc(vn) + my)), s = clampLat(unmerc(merc(vs) - my));
    this.box = { w, s, e, n };

    let W = CANVAS_W, H = Math.round((W * (merc(n) - merc(s))) / (((e - w) * Math.PI) / 180));
    if (H > CANVAS_H_MAX) { W = Math.max(64, Math.round((W * CANVAS_H_MAX) / H)); H = CANVAS_H_MAX; }
    H = Math.max(16, H);
    this.W = W; this.H = H;
    this.canvas.width = W; this.canvas.height = H;
    this.img = this.ctx.createImageData(W, H);
    this.lats = new Float32Array(H); this.lons = new Float32Array(W);
    const yTop = merc(n), yBot = merc(s);
    for (let r = 0; r < H; r++) this.lats[r] = unmerc(yTop + ((r + 0.5) / H) * (yBot - yTop));
    for (let c = 0; c < W; c++) this.lons[c] = w + ((c + 0.5) / W) * (e - w);
    this.val = new Float32Array(W * H); this.valRain = new Float32Array(W * H); this.cover = new Float32Array(W * H);
    this.taps.clear();
    this.source!.setCoordinates([[w, n], [e, n], [e, s], [w, s]]);
    return true;
  }

  private tapsFor(f: Field): Taps {
    let t = this.taps.get(f.g);
    if (t) return t;
    const g = f.g, W = this.W, H = this.H;
    // a world grid is one copy of the globe: shift canvas longitudes onto it
    const shift = (lo: number) => { if (f.feather > 0) return lo; let x = lo; while (x < g.lon0) x += 360; while (x >= g.lon0 + 360) x -= 360; return x; };
    const cols = Float32Array.from(this.lons, (lo) => (shift(lo) - g.lon0) / g.dlon);
    const rows = Float32Array.from(this.lats, (la) => (la - g.lat0) / g.dlat);
    const weight = new Float32Array(W * H);
    const latN = g.lat0, latS = g.lat0 + g.dlat * (g.h - 1), lonW = g.lon0, lonE = g.lon0 + g.dlon * (g.w - 1);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const la = this.lats[r], lo = shift(this.lons[c]);
      const d = Math.min(latN - la, la - latS, lo - lonW, lonE - lo);
      let s: number;
      if (f.feather > 0) { s = Math.min(1, Math.max(0, d / f.feather)); s = s * s * (3 - 2 * s); }
      else s = d >= -0.5 ? 1 : 0; // (tile sets can stop just short of the canvas edge)
      weight[r * W + c] = s;
    }
    t = {
      colT: cubicTaps(cols, g.w), rowT: cubicTaps(rows, g.h), pass: new Float32Array(g.h * W), weight,
      up: new Float32Array(W * H), upRain: new Float32Array(W * H), scalar: new Float32Array(g.w * g.h),
    };
    if (this.taps.size > 6) this.taps.clear(); // old tile sets
    this.taps.set(f.g, t);
    return t;
  }

  /** Smooth (bicubic) resample of a grid array onto the canvas, in two separable passes. */
  private upsample(g: Grid, t: Taps, src: Float32Array, dst: Float32Array, floor0: boolean) {
    const { w, h } = g, W = this.W, H = this.H;
    const { idx: ci, wt: cw } = t.colT, { idx: ri, wt: rw } = t.rowT, pass = t.pass;
    for (let y = 0; y < h; y++) {
      const row = y * w, out = y * W;
      for (let c = 0, k = 0; c < W; c++, k += 4) {
        pass[out + c] = src[row + ci[k]] * cw[k] + src[row + ci[k + 1]] * cw[k + 1]
          + src[row + ci[k + 2]] * cw[k + 2] + src[row + ci[k + 3]] * cw[k + 3];
      }
    }
    for (let r = 0, k = 0; r < H; r++, k += 4) {
      const a = ri[k] * W, b = ri[k + 1] * W, c2 = ri[k + 2] * W, d = ri[k + 3] * W;
      const w0 = rw[k], w1 = rw[k + 1], w2 = rw[k + 2], w3 = rw[k + 3], out = r * W;
      for (let c = 0; c < W; c++) {
        const v = pass[a + c] * w0 + pass[b + c] * w1 + pass[c2 + c] * w2 + pass[d + c] * w3;
        dst[out + c] = floor0 && v < 0 ? 0 : v; // cubic overshoot can dip below zero
      }
    }
  }

  private opacity = 1;
  setOpacity(o: number) {
    if (Math.abs(o - this.opacity) < 0.01) return;
    this.opacity = o;
    this.map.setPaintProperty('field', 'raster-opacity', o);
  }

  setVisible(on: boolean) {
    this.map.setLayoutProperty('field', 'visibility', on ? 'visible' : 'none');
  }

  /** Draw the fields (coarse first, finer on top) for one layer. */
  draw(fields: Field[], layer: LayerKey) {
    if (!this.W) return;
    const N = this.W * this.H, val = this.val, valRain = this.valRain, cover = this.cover;
    val.fill(0); valRain.fill(0); cover.fill(0);
    for (const f of fields) {
      const t = this.tapsFor(f), g = f.g, n = g.w * g.h, s = t.scalar;
      if (layer === 'wind') for (let i = 0; i < n; i++) s[i] = Math.hypot(f.u[i], f.v[i]) * 3.6;
      else if (layer === 'temp') s.set(f.t);
      else if (layer === 'rain') s.set(f.p);
      else s.set(f.c);
      this.upsample(g, t, s, t.up, layer !== 'temp');
      if (layer === 'clouds') this.upsample(g, t, f.p, t.upRain, true);
      const wt = t.weight, up = t.up, ur = t.upRain;
      for (let i = 0; i < N; i++) {
        const w = wt[i];
        if (w <= 0) continue;
        val[i] = val[i] * (1 - w) + up[i] * w;
        if (layer === 'clouds') valRain[i] = valRain[i] * (1 - w) + ur[i] * w;
        cover[i] = cover[i] + w * (1 - cover[i]);
      }
    }

    const out = this.img.data;
    const ramp = RAMPS[layer], lut = cachedLut(ramp);
    const rainRamp = RAMPS.rain, rainLut = cachedLut(rainRamp);
    for (let i = 0, o = 0; i < N; i++, o += 4) {
      if (cover[i] <= 0) { out[o + 3] = 0; continue; }
      let k = lutIndex(ramp, val[i]);
      let R = lut[k], G = lut[k + 1], B = lut[k + 2], A = lut[k + 3];
      if (layer === 'rain') A *= Math.min(1, Math.max(0, (val[i] - RAIN_MIN) / RAIN_FADE));
      if (layer === 'clouds') {
        // rain shows through the cloud deck, as on Windy's cloud layer
        const pv = valRain[i];
        if (pv > RAIN_MIN + RAIN_FADE / 2) {
          k = lutIndex(rainRamp, pv);
          // straight-alpha "rain over cloud": weight the cloud's own RGB by its own
          // alpha too, so a near-invisible clear-sky pixel doesn't tint the rain colour
          const a2 = rainLut[k + 3] / 255, a1 = A / 255;
          const outA = a2 + a1 * (1 - a2);
          if (outA > 0) {
            R = (rainLut[k] * a2 + R * a1 * (1 - a2)) / outA;
            G = (rainLut[k + 1] * a2 + G * a1 * (1 - a2)) / outA;
            B = (rainLut[k + 2] * a2 + B * a1 * (1 - a2)) / outA;
          }
          A = outA * 255;
        }
      }
      out[o] = R; out[o + 1] = G; out[o + 2] = B; out[o + 3] = A * cover[i];
    }
    this.ctx.putImageData(this.img, 0, 0);
    // copy the canvas to the GPU once, then stop
    const src = this.source!;
    src.play();
    this.map.triggerRepaint();
    this.map.once('render', () => src.pause());
  }
}
