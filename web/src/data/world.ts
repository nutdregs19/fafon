// The whole-world forecast (25 km) comes in 30° x 30° tiles, and only the tiles under the
// part of the map being looked at are downloaded — roaming data abroad is expensive.
// `Weather` puts it together with the fine regional forecast (Thailand, 9 km).
import { FrameStore, sample, type Box, type Field, type Frame, type Grid, type Manifest, type Source } from './store';

const BASE = 'data/';
const KEEP_TILES = 260;   // raw tiles kept in memory (~115 KB each)
const PREFETCH = 24;      // frames fetched ahead around the time being viewed

type Px = Uint8ClampedArray;
type Key = 'u' | 'v' | 't' | 'p' | 'c';

function luts(m: Manifest): Record<Key, Float32Array> {
  const e = m.enc, lin = (r: [number, number]) => Float32Array.from({ length: 256 }, (_, b) => r[0] + (b / 255) * (r[1] - r[0]));
  return { u: lin(e.u), v: lin(e.v), t: lin(e.t), c: lin(e.c), p: Float32Array.from({ length: 256 }, (_, b) => (b / 255) ** 2 * e.p.max) };
}

function bracket(fr: Frame[], t: number): [Frame, Frame, number] {
  if (t <= fr[0].t) return [fr[0], fr[0], 0];
  for (let i = 0; i < fr.length - 1; i++) if (t < fr[i + 1].t) return [fr[i], fr[i + 1], (t - fr[i].t) / (fr[i + 1].t - fr[i].t)];
  const last = fr[fr.length - 1];
  return [last, last, 0];
}

export class TiledStore {
  private cache = new Map<string, Px>();   // insertion order = least recently used first
  private pending = new Map<string, Promise<Px>>();
  private queue: string[] = [];
  private active = 0;
  private lut: Record<Key, Float32Array>;
  private T: number; private NX: number; private NY: number;
  private grids = new Map<string, Grid>(); // same tiles -> same Grid object (the map layer caches by it)
  private mix: Field | null = null;
  private mixKey = '';
  onLoaded: () => void = () => {};

  constructor(m: Manifest, public src: Source) {
    this.lut = luts(m);
    this.T = src.tile!;
    this.NX = Math.round(src.grid.w / this.T);
    this.NY = Math.round(src.grid.h / this.T);
  }

  /** Tile columns/rows covering a box (columns may run past the date line; they wrap). */
  private span(b: Box) {
    const deg = this.T * this.src.grid.dlon, g = this.src.grid;
    const x0 = Math.floor((b.w - g.lon0) / deg);
    const x1 = Math.min(x0 + this.NX - 1, Math.floor((b.e - g.lon0 - 1e-9) / deg));
    const row = (lat: number) => Math.max(0, Math.min(this.NY - 1, Math.floor((g.lat0 - lat) / deg)));
    return { x0, x1, y0: row(b.n), y1: row(b.s) };
  }

  private tileUrl(f: Frame, x: number, y: number) {
    return `${f.f}/${((x % this.NX) + this.NX) % this.NX}_${y}.png`;
  }

  private tiles(f: Frame, sp: ReturnType<TiledStore['span']>) {
    const out: string[] = [];
    for (let y = sp.y0; y <= sp.y1; y++) for (let x = sp.x0; x <= sp.x1; x++) out.push(this.tileUrl(f, x, y));
    return out;
  }

  private get(k: string) {
    const px = this.cache.get(k);
    if (px) { this.cache.delete(k); this.cache.set(k, px); }
    return px;
  }

  /** Blended field over the tiles under `box` at time t, or null while they're downloading. */
  at(t: number, box: Box): Field | null {
    const [a, b, w0] = bracket(this.src.frames, t);
    const sp = this.span(box);
    const ta = this.tiles(a, sp), pa = ta.map((k) => this.get(k));
    if (pa.some((p) => !p)) { ta.forEach((k) => this.load(k).catch(() => {})); return null; }
    let pb: (Px | undefined)[] | null = null, w = w0;
    if (b.f !== a.f && w > 0) {
      const tb = this.tiles(b, sp);
      pb = tb.map((k) => this.get(k));
      if (pb.some((p) => !p)) { tb.forEach((k) => this.load(k).catch(() => {})); pb = null; w = 0; }
    }
    const gk = `${sp.x0},${sp.x1},${sp.y0},${sp.y1}`;
    const key = `${gk}|${a.f}|${pb ? b.f : ''}|${w.toFixed(4)}`;
    if (key === this.mixKey && this.mix) return this.mix;
    let g = this.grids.get(gk);
    if (!g) {
      const s = this.src.grid, deg = this.T * s.dlon;
      g = { w: (sp.x1 - sp.x0 + 1) * this.T, h: (sp.y1 - sp.y0 + 1) * this.T, lat0: s.lat0 - sp.y0 * deg, lon0: s.lon0 + sp.x0 * deg, dlat: s.dlat, dlon: s.dlon };
      this.grids.set(gk, g);
    }
    if (!this.mix || this.mix.g !== g) {
      const n = g.w * g.h;
      this.mix = { g, u: new Float32Array(n), v: new Float32Array(n), t: new Float32Array(n), p: new Float32Array(n), c: new Float32Array(n), feather: 0 };
    }
    this.compose(this.mix, sp, pa as Px[], pb as Px[] | null, w);
    this.mixKey = key;
    this.mix.src = `${gk}|${a.f}|${pb ? b.f : ''}`;
    return this.mix;
  }

  /** Unpack every tile (top half u/v/t, bottom half rain/cloud) into one grid, blending two frames. */
  private compose(o: Field, sp: ReturnType<TiledStore['span']>, pa: Px[], pb: Px[] | null, w: number) {
    const T = this.T, L = this.lut, W = o.g.w, k = 1 - w, nx = sp.x1 - sp.x0 + 1, n = T * T;
    for (let i = 0; i < pa.length; i++) {
      const ox = (i % nx) * T, oy = Math.floor(i / nx) * T, A = pa[i], B = pb?.[i];
      for (let r = 0; r < T; r++) for (let c = 0; c < T; c++) {
        const j = r * T + c, a = j * 4, b = (j + n) * 4, d = (oy + r) * W + ox + c;
        if (B) {
          o.u[d] = L.u[A[a]] * k + L.u[B[a]] * w; o.v[d] = L.v[A[a + 1]] * k + L.v[B[a + 1]] * w;
          o.t[d] = L.t[A[a + 2]] * k + L.t[B[a + 2]] * w;
          o.p[d] = L.p[A[b]] * k + L.p[B[b]] * w; o.c[d] = L.c[A[b + 1]] * k + L.c[B[b + 1]] * w;
        } else {
          o.u[d] = L.u[A[a]]; o.v[d] = L.v[A[a + 1]]; o.t[d] = L.t[A[a + 2]]; o.p[d] = L.p[A[b]]; o.c[d] = L.c[A[b + 1]];
        }
      }
    }
  }

  /** Background-download the view's tiles for the frames nearest to t. */
  prefetch(t: number, box: Box) {
    const sp = this.span(box);
    const near = [...this.src.frames].sort((x, y) => Math.abs(x.t - t) - Math.abs(y.t - t)).slice(0, PREFETCH);
    this.queue = near.flatMap((f) => this.tiles(f, sp));
    this.pump();
  }

  private pump() {
    while (this.active < 4 && this.queue.length) {
      const k = this.queue.shift()!;
      if (this.cache.has(k) || this.pending.has(k)) continue;
      this.active++;
      this.load(k).catch(() => {}).finally(() => { this.active--; this.pump(); });
    }
  }

  private load(k: string): Promise<Px> {
    const hit = this.cache.get(k);
    if (hit) return Promise.resolve(hit);
    let p = this.pending.get(k);
    if (!p) {
      p = this.decode(k).then((px) => {
        this.cache.set(k, px);
        while (this.cache.size > KEEP_TILES) this.cache.delete(this.cache.keys().next().value!);
        this.pending.delete(k);
        this.onLoaded();
        return px;
      }, (e) => { this.pending.delete(k); throw e; });
      this.pending.set(k, p);
    }
    return p;
  }

  private async decode(path: string): Promise<Px> {
    const T = this.T;
    const r = await fetch(BASE + path);
    if (!r.ok) throw new Error('tile ' + r.status);
    const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const cv = new OffscreenCanvas(T, T * 2);
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return ctx.getImageData(0, 0, T, T * 2).data;
  }
}

const inside = (g: Grid, b: Box, margin: number) => {
  const latS = g.lat0 + g.dlat * (g.h - 1), lonE = g.lon0 + g.dlon * (g.w - 1);
  return b.w >= g.lon0 + margin && b.e <= lonE - margin && b.n <= g.lat0 - margin && b.s >= latS + margin;
};
const overlaps = (g: Grid, b: Box) => {
  const latS = g.lat0 + g.dlat * (g.h - 1), lonE = g.lon0 + g.dlon * (g.w - 1);
  return b.e > g.lon0 && b.w < lonE && b.n > latS && b.s < g.lat0;
};

/** World (coarse, tiled) + region (fine) forecasts, handed out coarse first. */
export class Weather {
  private region: FrameStore | null = null;
  private world: TiledStore | null = null;
  onLoaded: () => void = () => {};

  constructor(m: Manifest) {
    for (const s of Object.values(m.sources)) {
      if (s.tile) { this.world = new TiledStore(m, s); this.world.onLoaded = () => this.onLoaded(); }
      else if (!this.region) { this.region = new FrameStore(m, s); this.region.onLoaded = () => this.onLoaded(); }
    }
  }

  /** Last forecast time available anywhere. */
  lastTime() {
    return Math.max(...[this.region, this.world].filter(Boolean).map((s) => s!.src.frames[s!.src.frames.length - 1].t));
  }

  /** What each part needs for this box: the world unless the box sits well inside the region. */
  private needs(box: Box) {
    const rg = this.region?.src.grid;
    const region = !!rg && overlaps(rg, box);
    const world = !!this.world && !(rg && inside(rg, box, 1.6));
    return { region, world };
  }

  fields(t: number, box: Box): Field[] {
    const n = this.needs(box), out: Field[] = [];
    if (n.world) { const f = this.world!.at(t, box); if (f) out.push(f); }
    if (n.region) { const f = this.region!.at(t); if (f) out.push(f); }
    return out;
  }

  prefetch(t: number, box: Box) {
    const n = this.needs(box);
    if (n.world) this.world!.prefetch(t, box);
    if (n.region) this.region!.prefetch(t);
  }
}

/** Value at a point from the finest field that covers it (NaN if none). */
export function sampleAt(fields: Field[], key: 'u' | 'v' | 't' | 'p' | 'c', lon: number, lat: number): number {
  for (let i = fields.length - 1; i >= 0; i--) {
    const f = fields[i];
    let x = lon;
    // the world grid is one copy of the globe; bring the point onto it
    if (f.feather === 0) { while (x < f.g.lon0) x += 360; while (x >= f.g.lon0 + 360) x -= 360; }
    const v = sample(f.g, f[key], x, lat);
    if (!Number.isNaN(v)) return v;
  }
  return NaN;
}
