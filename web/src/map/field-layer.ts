// Paints the active weather layer into a canvas laid out in Web-Mercator,
// then hands it to MapLibre as a canvas source under the borders and labels.
import type { Map as MLMap, CanvasSource } from 'maplibre-gl';
import type { Field, Grid } from '../data/store';
import { RAMPS, cachedLut, lutIndex, type LayerKey } from './palettes';

const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unmerc = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;

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

export class FieldLayer {
  readonly canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private edge: Float32Array; // soft fade at the region border, per canvas pixel
  private lats: Float32Array;  // latitude of each canvas row
  private lons: Float32Array;  // longitude of each canvas column
  // resampling taps for the grid currently in use (sources can differ: 9 km vs 25 km)
  private g!: Grid;
  private colT!: { idx: Int32Array; wt: Float32Array };
  private rowT!: { idx: Int32Array; wt: Float32Array };
  private scalar!: Float32Array;
  private pass!: Float32Array;  // grid rows x canvas columns
  private up: Float32Array;    // canvas-sized, the active value
  private upRain: Float32Array; // canvas-sized, rain under the cloud layer
  private source?: CanvasSource;

  /** `area` fixes the painted region; every source grid must cover the same area. */
  constructor(private map: MLMap, area: Grid, beforeId?: string) {
    const lon0 = area.lon0, lat0 = area.lat0;
    const lonE = area.lon0 + area.dlon * (area.w - 1), latS = area.lat0 + area.dlat * (area.h - 1);
    const W = 680; // fixed canvas: about 0.05 deg per pixel, sharp enough for 9 km data
    const H = Math.round((W * (merc(lat0) - merc(latS))) / (((lonE - lon0) * Math.PI) / 180));
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(W, H);
    this.lats = new Float32Array(H); this.lons = new Float32Array(W);
    const yTop = merc(lat0), yBot = merc(latS);
    for (let r = 0; r < H; r++) this.lats[r] = unmerc(yTop + ((r + 0.5) / H) * (yBot - yTop));
    for (let c = 0; c < W; c++) this.lons[c] = lon0 + ((c + 0.5) / W) * (lonE - lon0);
    const fade = 1.5; // degrees
    this.edge = new Float32Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const d = Math.min(lat0 - this.lats[r], this.lats[r] - latS, this.lons[c] - lon0, lonE - this.lons[c]);
      const s = Math.min(1, Math.max(0, d / fade));
      this.edge[r * W + c] = s * s * (3 - 2 * s);
    }
    this.up = new Float32Array(W * H);
    this.upRain = new Float32Array(W * H);

    map.addSource('field', {
      type: 'canvas', canvas: this.canvas, animate: false,
      coordinates: [[lon0, lat0], [lonE, lat0], [lonE, latS], [lon0, latS]],
    });
    map.addLayer({
      id: 'field', type: 'raster', source: 'field',
      paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
    }, beforeId);
    this.source = map.getSource('field') as CanvasSource;
  }

  private useGrid(g: Grid) {
    if (this.g === g) return;
    this.g = g;
    const rows = Float32Array.from(this.lats, (la) => (la - g.lat0) / g.dlat);
    const cols = Float32Array.from(this.lons, (lo) => (lo - g.lon0) / g.dlon);
    this.colT = cubicTaps(cols, g.w);
    this.rowT = cubicTaps(rows, g.h);
    this.scalar = new Float32Array(g.w * g.h);
    this.pass = new Float32Array(g.h * this.canvas.width);
  }

  /** Smooth (bicubic) resample of a grid array onto the canvas, in two separable passes. */
  private upsample(src: Float32Array, dst: Float32Array, floor0: boolean) {
    const { w, h } = this.g, W = this.canvas.width, H = this.canvas.height;
    const { idx: ci, wt: cw } = this.colT, { idx: ri, wt: rw } = this.rowT, pass = this.pass;
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

  setVisible(on: boolean) {
    this.map.setLayoutProperty('field', 'visibility', on ? 'visible' : 'none');
  }

  draw(f: Field, layer: LayerKey) {
    this.useGrid(f.g);
    const g = this.g, n = g.w * g.h, s = this.scalar;
    if (layer === 'wind') for (let i = 0; i < n; i++) s[i] = Math.hypot(f.u[i], f.v[i]) * 3.6;
    else if (layer === 'temp') s.set(f.t);
    else if (layer === 'rain') s.set(f.p);
    else s.set(f.c);
    this.upsample(s, this.up, layer !== 'temp');
    if (layer === 'clouds') this.upsample(f.p, this.upRain, true);

    const out = this.img.data, up = this.up, upRain = this.upRain, edge = this.edge;
    const ramp = RAMPS[layer], lut = cachedLut(ramp);
    const rainRamp = RAMPS.rain, rainLut = cachedLut(rainRamp);
    for (let i = 0, o = 0; i < up.length; i++, o += 4) {
      let k = lutIndex(ramp, up[i]);
      let R = lut[k], G = lut[k + 1], B = lut[k + 2], A = lut[k + 3];
      if (layer === 'clouds') {
        // rain shows through the cloud deck, as on Windy's cloud layer
        const pv = upRain[i];
        if (pv > 0.2) {
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
      out[o] = R; out[o + 1] = G; out[o + 2] = B; out[o + 3] = A * edge[i];
    }
    this.ctx.putImageData(this.img, 0, 0);
    // copy the canvas to the GPU once, then stop
    const src = this.source!;
    src.play();
    this.map.triggerRepaint();
    this.map.once('render', () => src.pause());
  }
}
