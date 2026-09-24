// Colour ramps in the spirit of Windy: value stops -> RGBA, baked into 512-entry lookup tables.

export type LayerKey = 'rain' | 'clouds' | 'wind' | 'temp';
type Stop = [number, number, number, number, number]; // value, r, g, b, alpha 0-1

export interface Ramp {
  unit: string;
  stops: Stop[];
  /** value -> 0..1 position in the lookup table */
  pos: (v: number) => number;
  legend: number[];
}

const lin = (lo: number, hi: number) => (v: number) => (v - lo) / (hi - lo);

// Rain is coloured the way Windy colours radar: by reflectivity (dBZ), converted
// from mm/h with the Marshall-Palmer relation Z = 200 R^1.6. Colours were sampled
// from Windy's own radar legend. Radar tiles and model rain share this one scale.
export const dbzFromMmh = (r: number) => (r > 0 ? 10 * Math.log10(200 * Math.pow(r, 1.6)) : -99);
export const mmhFromDbz = (dbz: number) => Math.pow(Math.pow(10, dbz / 10) / 200, 1 / 1.6);
const DBZ_LO = 5, DBZ_HI = 62;
const WINDY_RADAR: [number, number, number, number, number][] = [
  // dBZ, r, g, b, alpha — nothing below ~11 dBZ (≈0.2 mm/h), then a quick fade-in
  // see-through like Windy: roads and towns stay visible under light rain, heavy rain is more solid
  [5, 31, 35, 158, 0], [11, 31, 35, 158, 0], [15, 37, 78, 157, 0.45], [20, 63, 142, 146, 0.52],
  [26.5, 86, 181, 125, 0.58], [30, 107, 200, 111, 0.62], [33, 160, 210, 87, 0.66], [36, 208, 215, 77, 0.7],
  [39.5, 233, 205, 70, 0.74], [42.5, 234, 181, 67, 0.77], [46, 228, 152, 68, 0.8], [49, 212, 116, 74, 0.82],
  [52, 191, 85, 85, 0.84], [55.5, 170, 58, 96, 0.86], [62, 143, 33, 106, 0.88],
];

export const RAMPS: Record<string, Ramp> = {
  rain: {
    unit: 'มม./ชม.',
    pos: (v) => (dbzFromMmh(v) - DBZ_LO) / (DBZ_HI - DBZ_LO),
    stops: WINDY_RADAR.map(([d, r, g, b, a]) => [mmhFromDbz(d), r, g, b, a] as Stop),
    legend: [0.5, 1, 2, 5, 10, 20, 50],
  },
  clouds: {
    unit: '%',
    pos: lin(0, 100),
    stops: [[0, 20, 25, 35, 0], [20, 170, 180, 195, 0.08], [50, 205, 212, 222, 0.35], [80, 230, 234, 240, 0.6], [100, 245, 247, 250, 0.72]],
    legend: [20, 40, 60, 80, 100],
  },
  wind: {
    unit: 'กม./ชม.',
    pos: lin(0, 110),
    stops: [
      [0, 40, 60, 140, 0.55], [8, 50, 100, 190, 0.6], [16, 40, 150, 180, 0.62], [25, 50, 170, 110, 0.65],
      [35, 150, 190, 60, 0.68], [45, 230, 200, 50, 0.7], [60, 240, 130, 40, 0.72], [80, 220, 50, 60, 0.75],
      [110, 200, 60, 200, 0.78],
    ],
    legend: [10, 20, 40, 60, 80, 100],
  },
  temp: {
    unit: '°C',
    pos: lin(-20, 45),
    stops: [
      [-20, 150, 80, 200, 0.7], [-5, 80, 90, 210, 0.7], [5, 60, 150, 220, 0.7], [15, 60, 190, 170, 0.7],
      [22, 120, 200, 90, 0.7], [27, 225, 210, 70, 0.72], [31, 240, 150, 50, 0.74], [35, 230, 70, 50, 0.76],
      [40, 180, 30, 60, 0.78], [45, 130, 20, 70, 0.8],
    ],
    legend: [0, 10, 20, 25, 30, 35, 40],
  },
};

const N = 512;

/** Lookup table: N entries x RGBA (alpha 0-255). */
export function buildLut(r: Ramp): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(N * 4);
  const ps = r.stops.map((s) => Math.min(1, Math.max(0, r.pos(s[0]))));
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    let k = 0;
    while (k < ps.length - 2 && x > ps[k + 1]) k++;
    const span = ps[k + 1] - ps[k] || 1;
    const f = Math.min(1, Math.max(0, (x - ps[k]) / span));
    const a = r.stops[k], b = r.stops[k + 1];
    lut[i * 4] = a[1] + (b[1] - a[1]) * f;
    lut[i * 4 + 1] = a[2] + (b[2] - a[2]) * f;
    lut[i * 4 + 2] = a[3] + (b[3] - a[3]) * f;
    lut[i * 4 + 3] = (a[4] + (b[4] - a[4]) * f) * 255;
  }
  return lut;
}

export function lutIndex(r: Ramp, v: number): number {
  const p = r.pos(v);
  return (p <= 0 ? 0 : p >= 1 ? N - 1 : (p * (N - 1)) | 0) * 4;
}

const lutCache = new Map<Ramp, Uint8ClampedArray>();
export function cachedLut(r: Ramp) {
  let l = lutCache.get(r);
  if (!l) { l = buildLut(r); lutCache.set(r, l); }
  return l;
}

export function cssColor(r: Ramp, v: number): string {
  const lut = cachedLut(r), i = lutIndex(r, v);
  return `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
}

/** Continuous CSS gradient for a legend bar, left = low, right = high. */
export function gradientCss(r: Ramp): string {
  const lut = cachedLut(r), steps = 32, parts: string[] = [];
  for (let s = 0; s <= steps; s++) {
    const i = Math.round((s / steps) * (N - 1)) * 4;
    parts.push(`rgba(${lut[i]},${lut[i + 1]},${lut[i + 2]},${(lut[i + 3] / 255).toFixed(2)}) ${((s / steps) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/** Legend tick position (0..1) of a value on its ramp. */
export const legendPos = (r: Ramp, v: number) => Math.min(1, Math.max(0, r.pos(v)));
