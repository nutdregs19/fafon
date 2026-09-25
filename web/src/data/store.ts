// Loads manifest + PNG frames written by pipeline/render.py and turns them
// back into numbers. Pixel ranges must match pipeline/common.py ENC.

export interface Grid { w: number; h: number; lat0: number; lon0: number; dlat: number; dlon: number }
interface Enc { u: [number, number]; v: [number, number]; t: [number, number]; p: { max: number }; c: [number, number] }
export interface Frame { t: number; f: string }
/** `tile`: the source is cut into square tiles of this many px (the world); frame paths are folders. */
export interface Source { key: string; label: string; credit: string; run: number; grid: Grid; frames: Frame[]; tile?: number }
export interface Manifest { generated: number; enc: Enc; sources: Record<string, Source> }

/** One forecast moment on its source's grid. u/v m/s, t deg C, p mm/h, c %.
 *  `feather`: degrees over which a regional field fades into the coarser world one (0 = world). */
export interface Field { g: Grid; u: Float32Array; v: Float32Array; t: Float32Array; p: Float32Array; c: Float32Array; feather: number;
  /** which frames/tiles it was made from (not the blend weight): a change means a redraw */
  src?: string }

/** A lon/lat box. West may be > 180 or east < -180 past the date line (map world copies). */
export interface Box { w: number; s: number; e: number; n: number }

const BASE = 'data/';
const KEEP = 48;      // frames kept in memory (raw pixels, ~1 MB each at 9 km)
const PREFETCH = 36;  // frames downloaded ahead around the time being viewed

export async function loadManifest(): Promise<Manifest> {
  const r = await fetch(BASE + 'manifest.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('manifest ' + r.status);
  const m = await r.json();
  const sources: Record<string, Source> = {};
  for (const [key, s] of Object.entries<any>(m.sources)) {
    sources[key] = {
      key, label: s.label, credit: s.credit, run: Date.parse(s.run), grid: s.grid ?? m.grid, tile: s.tile,
      frames: s.frames.map((f: any) => ({ t: Date.parse(f.t), f: f.f })),
    };
  }
  return { generated: Date.parse(m.generated), enc: m.enc, sources };
}

export class FrameStore {
  private cache = new Map<string, Uint8ClampedArray>(); // insertion order = least recently used first
  private pending = new Map<string, Promise<Uint8ClampedArray>>();
  private mix: Field;
  private mixKey = '';
  private queue: Frame[] = [];
  private active = 0;
  private lut: Record<'u' | 'v' | 't' | 'p' | 'c', Float32Array>;
  onLoaded: () => void = () => {};

  constructor(m: Manifest, public src: Source) {
    const g = src.grid, n = g.w * g.h;
    this.mix = { g, u: new Float32Array(n), v: new Float32Array(n), t: new Float32Array(n), p: new Float32Array(n), c: new Float32Array(n), feather: 1.5 };
    const e = m.enc, lin = (r: [number, number]) => Float32Array.from({ length: 256 }, (_, b) => r[0] + (b / 255) * (r[1] - r[0]));
    this.lut = { u: lin(e.u), v: lin(e.v), t: lin(e.t), c: lin(e.c), p: Float32Array.from({ length: 256 }, (_, b) => (b / 255) ** 2 * e.p.max) };
  }

  /** Frames on either side of time t, and the blend weight toward the later one. */
  bracket(t: number): [Frame, Frame, number] {
    const fr = this.src.frames;
    if (t <= fr[0].t) return [fr[0], fr[0], 0];
    for (let i = 0; i < fr.length - 1; i++) {
      if (t < fr[i + 1].t) return [fr[i], fr[i + 1], (t - fr[i].t) / (fr[i + 1].t - fr[i].t)];
    }
    const last = fr[fr.length - 1];
    return [last, last, 0];
  }

  private get(f: Frame) {
    const px = this.cache.get(f.f);
    if (px) { this.cache.delete(f.f); this.cache.set(f.f, px); }
    return px;
  }

  /** Blended field at time t, or null while its frames are still downloading. */
  at(t: number): Field | null {
    const [a, b, w0] = this.bracket(t);
    const pa = this.get(a);
    if (!pa) {
      this.load(a).catch(() => {});
      if (b.f !== a.f) this.load(b).catch(() => {});
      return null;
    }
    let pb: Uint8ClampedArray | undefined, w = w0;
    if (b.f !== a.f && w > 0) {
      pb = this.get(b);
      if (!pb) { this.load(b).catch(() => {}); w = 0; } // show the current frame while the next loads
    }
    const key = `${a.f}|${pb ? b.f : ''}|${w.toFixed(4)}`;
    if (key === this.mixKey) return this.mix;
    this.decodeInto(pa, pb, w);
    this.mixKey = key;
    this.mix.src = `${a.f}|${pb ? b.f : ''}`;
    return this.mix;
  }

  /** Unpack PNG pixels (top half u/v/t, bottom half rain/cloud) and blend two frames. */
  private decodeInto(pa: Uint8ClampedArray, pb: Uint8ClampedArray | undefined, w: number) {
    const o = this.mix, L = this.lut, n = o.g.w * o.g.h, k = 1 - w;
    for (let i = 0; i < n; i++) {
      const a = i * 4, b = (i + n) * 4;
      if (pb) {
        o.u[i] = L.u[pa[a]] * k + L.u[pb[a]] * w;
        o.v[i] = L.v[pa[a + 1]] * k + L.v[pb[a + 1]] * w;
        o.t[i] = L.t[pa[a + 2]] * k + L.t[pb[a + 2]] * w;
        o.p[i] = L.p[pa[b]] * k + L.p[pb[b]] * w;
        o.c[i] = L.c[pa[b + 1]] * k + L.c[pb[b + 1]] * w;
      } else {
        o.u[i] = L.u[pa[a]]; o.v[i] = L.v[pa[a + 1]]; o.t[i] = L.t[pa[a + 2]];
        o.p[i] = L.p[pa[b]]; o.c[i] = L.c[pa[b + 1]];
      }
    }
  }

  /** Background-download the frames nearest to time t. */
  prefetch(t: number) {
    this.queue = [...this.src.frames].sort((x, y) => Math.abs(x.t - t) - Math.abs(y.t - t)).slice(0, PREFETCH);
    this.pump();
  }

  private pump() {
    while (this.active < 3 && this.queue.length) {
      const f = this.queue.shift()!;
      if (this.cache.has(f.f) || this.pending.has(f.f)) continue;
      this.active++;
      this.load(f).catch(() => {}).finally(() => { this.active--; this.pump(); });
    }
  }

  load(f: Frame): Promise<Uint8ClampedArray> {
    const hit = this.cache.get(f.f);
    if (hit) return Promise.resolve(hit);
    let p = this.pending.get(f.f);
    if (!p) {
      p = this.decode(f.f).then((px) => {
        this.cache.set(f.f, px);
        while (this.cache.size > KEEP) this.cache.delete(this.cache.keys().next().value!);
        this.pending.delete(f.f);
        this.onLoaded();
        return px;
      }, (e) => { this.pending.delete(f.f); throw e; });
      this.pending.set(f.f, p);
    }
    return p;
  }

  private async decode(path: string): Promise<Uint8ClampedArray> {
    const { w, h } = this.src.grid;
    const blob = await (await fetch(BASE + path)).blob();
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const cv = new OffscreenCanvas(w, h * 2);
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return ctx.getImageData(0, 0, w, h * 2).data;
  }
}

/** Bilinear sample of one grid array at lon/lat; NaN outside the grid. */
export function sample(g: Grid, arr: Float32Array, lon: number, lat: number): number {
  const x = (lon - g.lon0) / g.dlon, y = (lat - g.lat0) / g.dlat;
  if (x < 0 || y < 0 || x > g.w - 1 || y > g.h - 1) return NaN;
  const x0 = Math.min(Math.floor(x), g.w - 2), y0 = Math.min(Math.floor(y), g.h - 2);
  const fx = x - x0, fy = y - y0, i = y0 * g.w + x0;
  const top = arr[i] * (1 - fx) + arr[i + 1] * fx;
  const bot = arr[i + g.w] * (1 - fx) + arr[i + g.w + 1] * fx;
  return top * (1 - fy) + bot * fy;
}
