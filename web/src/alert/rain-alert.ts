// "Rain in ~20 min, heavy, for about 40 min" for one spot.
// Shared by the app (banner at the top) and the alert server (phone notifications), so
// both always say the same thing. Pure code: no DOM, no map.
//
// How: take the newest radar picture, and look upwind of the spot along the steering wind
// (the mid-level wind storms drift with). Whatever rain lies X km upwind arrives in X/speed
// minutes. Past the radar's 2 hours, the model's hourly forecast takes over.
// It can't foresee a storm that pops up out of clear sky — only rain that already exists.
import { mmhFromDbz } from '../map/palettes';

export const RADAR_Z = 6;       // ~2.3 km per pixel over Thailand
const STEP = 5;                 // minutes between checks along the path
export const HORIZON = 120;     // radar look-ahead, minutes after the radar picture
const WET_DBZ = 15;             // where the rain colours start
const WET_FRAC = 0.3;           // share of the circle that must be rainy
const STALE = 45;               // radar older than this (min) isn't trusted
const LATER_HOURS = 12;

export const LEVEL_TH = ['ฝนเบา', 'ฝนปานกลาง', 'ฝนหนัก', 'ฝนหนักมาก'] as const;
/** mm per hour -> 0 light, 1 moderate, 2 heavy, 3 very heavy (thunderstorm) */
export const levelOf = (mmh: number) => (mmh < 2.5 ? 0 : mmh < 10 ? 1 : mmh < 35 ? 2 : 3);

// ---------- where to look ----------

const worldPx = (lat: number, lon: number, z: number) => {
  const s = 256 * 2 ** z, r = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * s, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s };
};
const kmPerPx = (lat: number, z: number) => (40075.017 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** z);

interface Probe { lead: number; x: number; y: number; r: number }

/** Circles to read, one every 5 min of lead: walking upwind, widening as the guess gets rougher. */
function probes(lat: number, lon: number, u: number, v: number): Probe[] {
  const p = worldPx(lat, lon, RADAR_Z), kpp = kmPerPx(lat, RADAR_Z);
  const vx = u / 60 / kpp, vy = -v / 60 / kpp; // px per minute (screen y points down)
  const out: Probe[] = [];
  for (let lead = 0; lead <= HORIZON; lead += STEP) {
    out.push({ lead, x: p.x - vx * lead, y: p.y - vy * lead, r: 2 + lead / 30 });
  }
  return out;
}

/** Radar tiles (x, y at RADAR_Z) the path needs. */
export function tilesFor(lat: number, lon: number, u: number, v: number): { z: number; x: number; y: number }[] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of probes(lat, lon, u, v)) {
    x0 = Math.min(x0, p.x - p.r); x1 = Math.max(x1, p.x + p.r);
    y0 = Math.min(y0, p.y - p.r); y1 = Math.max(y1, p.y + p.r);
  }
  const out = [];
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor(y1 / 256); ty++)
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor(x1 / 256); tx++) out.push({ z: RADAR_Z, x: tx, y: ty });
  return out;
}

export interface PathSample { lead: number; frac: number; dbz: number }

/** Rain the steering wind will carry over the spot, per 5 min of lead after the radar picture.
 *  `dbzAt(gx, gy)` reads the radar picture at a world pixel (0 = dry or unknown). */
export function tracePath(dbzAt: (gx: number, gy: number) => number, lat: number, lon: number, u: number, v: number): PathSample[] {
  return probes(lat, lon, u, v).map(({ lead, x, y, r }) => {
    const wet: number[] = [];
    let n = 0;
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      n++;
      const d = dbzAt(Math.floor(x + dx), Math.floor(y + dy));
      if (d >= WET_DBZ) wet.push(d);
    }
    wet.sort((a, b) => a - b);
    // typical strength of the rain in the circle, not its single worst pixel
    return { lead, frac: n ? wet.length / n : 0, dbz: wet.length ? wet[Math.floor(wet.length * 0.8)] : 0 };
  });
}

// ---------- the model forecast (Open-Meteo, European model) ----------

export function forecastUrl(lat: number, lon: number) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lon.toFixed(3),
    hourly: ['precipitation', 'precipitation_probability',
      'wind_speed_850hPa', 'wind_direction_850hPa', 'wind_speed_700hPa', 'wind_direction_700hPa',
      'wind_speed_500hPa', 'wind_direction_500hPa'].join(','),
    // 9 km for rain; its open data has no upper-air wind, the 25 km run does
    models: 'ecmwf_ifs,ecmwf_ifs025', forecast_hours: String(LATER_HOURS + 2), past_hours: '1',
    timeformat: 'unixtime', wind_speed_unit: 'kmh', timezone: 'auto', // (for the local clock abroad)
  });
  return 'https://api.open-meteo.com/v1/forecast?' + q;
}

export interface Forecast {
  time: number[];                 // ms, start of each hour
  precip: (number | null)[];      // mm in that hour
  prob: (number | null)[];        // %
  u: number[]; v: number[];       // steering wind, km/h towards east / north
  tz: number;                     // the spot's offset from UTC, seconds
}

export function parseForecast(j: any): Forecast {
  const h = j.hourly;
  const col = (n: string) => (h[`${n}_ecmwf_ifs`] ?? h[`${n}_ecmwf_ifs025`] ?? h[n] ?? []) as (number | null)[];
  const wind = (n: string) => (h[`${n}_ecmwf_ifs025`] ?? h[n] ?? []) as (number | null)[];
  const time = (h.time as number[]).map((t) => t * 1000);
  const u: number[] = [], v: number[] = [];
  // storms drift with the mean wind of the middle of the atmosphere
  const levels: [string, number][] = [['850hPa', 0.3], ['700hPa', 0.4], ['500hPa', 0.3]];
  for (let i = 0; i < time.length; i++) {
    let su = 0, sv = 0, sw = 0;
    for (const [lv, w] of levels) {
      const s = wind(`wind_speed_${lv}`)[i], d = wind(`wind_direction_${lv}`)[i];
      if (s == null || d == null) continue;
      const rad = (d * Math.PI) / 180; // direction the wind comes FROM
      su += -s * Math.sin(rad) * w; sv += -s * Math.cos(rad) * w; sw += w;
    }
    u.push(sw ? su / sw : 0); v.push(sw ? sv / sw : 0);
  }
  return { time, precip: col('precipitation'), prob: col('precipitation_probability'), u, v, tz: Number(j.utc_offset_seconds ?? 7 * 3600) };
}

/** Steering wind at time t (nearest hour). */
export function steerAt(f: Forecast, t: number) {
  let best = 0;
  for (let i = 0; i < f.time.length; i++) if (Math.abs(f.time[i] - t) < Math.abs(f.time[best] - t)) best = i;
  return { u: f.u[best] ?? 0, v: f.v[best] ?? 0 };
}

// ---------- verdict ----------

export interface RainAlert {
  kind: 'now' | 'soon' | 'later' | 'none';
  level: number;        // index into LEVEL_TH
  inMin?: number;       // minutes until it starts (soon, later)
  forMin?: number;      // how long it lasts (now: until it stops)
  longer?: boolean;     // still raining at the end of what we can see
  prob?: number;        // later: model's chance of rain, %
  at?: number;          // later: start of that hour, ms
  radarT?: number;      // time of the radar picture used
  tz?: number;          // the spot's offset from UTC, seconds (local clock times, quiet hours)
}

const wet = (s: PathSample) => s.frac >= WET_FRAC;
const round5 = (m: number) => Math.max(5, Math.round(m / 5) * 5);

export function decide(path: PathSample[] | null, radarT: number | null, now: number, fc: Forecast | null): RainAlert {
  return { ...verdict(path, radarT, now, fc), tz: fc?.tz };
}

function verdict(path: PathSample[] | null, radarT: number | null, now: number, fc: Forecast | null): RainAlert {
  let laterFrom = now;
  if (path && radarT != null && now - radarT <= STALE * 60_000) {
    const age = (now - radarT) / 60_000;
    // from "now" onwards; minutes counted from now, not from the radar picture
    const ahead = path.filter((s) => s.lead >= age - STEP / 2).map((s) => ({ ...s, m: s.lead - age }));
    laterFrom = radarT + HORIZON * 60_000;
    if (ahead.length) {
      const runFrom = (i: number) => {
        let j = i, peak = 0;
        // the run ends at two dry checks in a row (one dry gap inside a storm doesn't count)
        while (j < ahead.length && (wet(ahead[j]) || (j + 1 < ahead.length && wet(ahead[j + 1])))) {
          peak = Math.max(peak, ahead[j].dbz); j++;
        }
        const level = levelOf(mmhFromDbz(peak));
        return j >= ahead.length
          ? { longer: true, forMin: round5(ahead[ahead.length - 1].m - ahead[i].m), level }
          : { longer: false, forMin: round5(ahead[j].m - Math.max(0, ahead[i].m)), level };
      };
      if (wet(ahead[0])) return { kind: 'now', radarT, ...runFrom(0) };
      const i = ahead.findIndex(wet);
      if (i >= 0) return { kind: 'soon', radarT, inMin: round5(ahead[i].m), ...runFrom(i) };
    }
  }
  if (fc) {
    for (let i = 0; i < fc.time.length; i++) {
      const t = fc.time[i];
      if (t + 3600_000 <= laterFrom || t > now + LATER_HOURS * 3600_000) continue;
      const mm = fc.precip[i] ?? 0, prob = fc.prob[i];
      if (mm >= 0.5 && (prob == null || prob >= 40)) {
        const at = Math.max(t, now);
        return { kind: 'later', level: levelOf(mm), at, inMin: Math.round((at - now) / 60_000), prob: prob ?? undefined, radarT: radarT ?? undefined };
      }
    }
  }
  return { kind: 'none', level: 0, radarT: radarT ?? undefined };
}

// ---------- words ----------

// clock time at the spot (Thailand unless the forecast said otherwise)
const hhmm = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
const clock = (t: number, tz = 7 * 3600) => hhmm.format(t + tz * 1000);
/** Hour of day (0-23) at the spot. */
export const localHour = (t: number, tz = 7 * 3600) => new Date(t + tz * 1000).getUTCHours();

export function duration(min: number) {
  if (min < 60) return `${Math.max(5, Math.round(min / 5) * 5)} นาที`;
  const h = Math.round(min / 30) / 2;
  return Number.isInteger(h) ? `${h} ชม.` : `${Math.floor(h)} ชม. ครึ่ง`;
}

export function alertText(a: RainAlert): { title: string; body: string } {
  const lv = LEVEL_TH[a.level];
  switch (a.kind) {
    case 'now':
      return { title: `ฝนกำลังตกที่นี่ · ${lv}`,
        body: a.longer ? `น่าจะตกต่ออีกนานกว่า ${duration(a.forMin!)}` : `น่าจะหยุดในอีกราว ${duration(a.forMin!)}` };
    case 'soon':
      return { title: a.inMin! <= 5 ? `ฝนใกล้ถึงแล้ว · ${lv}` : `อีก ~${duration(a.inMin!)} ฝนจะมา · ${lv}`,
        body: a.longer ? `แล้วตกยาวเกิน ${duration(a.forMin!)}` : `ตกราว ${duration(a.forMin!)}` };
    case 'later':
      if (a.inMin! < 15) return { title: `ชั่วโมงนี้อาจมี${lv}`,
        body: `${a.prob != null ? `โอกาส ${a.prob}% ` : ''}(จากแบบจำลอง เรดาร์ยังไม่เห็นกลุ่มฝน)` };
      return { title: `ราว ${clock(a.at!, a.tz)} น. อาจมี${lv}`,
        body: `อีก ~${duration(a.inMin!)}${a.prob != null ? ` · โอกาส ${a.prob}%` : ''} (จากแบบจำลอง)` };
    default:
      return { title: `${LATER_HOURS} ชม. นี้ไม่น่ามีฝน`, body: '' };
  }
}

// ---------- one full check ----------

export const RADAR_LIST = 'https://api.rainviewer.com/public/weather-maps.json';

/** How to fetch things: the app decodes tiles with a canvas, the server with its own PNG reader. */
export interface Io {
  json: (url: string) => Promise<any>;
  /** one 256x256 radar tile: pixel index -> dBZ */
  tile: (url: string) => Promise<(i: number) => number>;
}

export async function checkSpot(lat: number, lon: number, now: number, io: Io): Promise<RainAlert> {
  const [fcR, listR] = await Promise.allSettled([io.json(forecastUrl(lat, lon)), io.json(RADAR_LIST)]);
  const fc = fcR.status === 'fulfilled' ? parseForecast(fcR.value) : null;
  let path: PathSample[] | null = null, radarT: number | null = null;
  const past = listR.status === 'fulfilled' ? listR.value?.radar?.past ?? [] : [];
  const last = past[past.length - 1];
  if (last) {
    const t = last.time * 1000;
    const { u, v } = fc ? steerAt(fc, t) : { u: 0, v: 0 };
    const got = new Map<string, (i: number) => number>();
    await Promise.all(tilesFor(lat, lon, u, v).map(async (k) => {
      try { got.set(`${k.x}/${k.y}`, await io.tile(`${listR.status === 'fulfilled' ? listR.value.host : ''}${last.path}/256/${k.z}/${k.x}/${k.y}/2/0_0.png`)); }
      catch { /* a missing tile reads as dry */ }
    }));
    if (got.size) {
      radarT = t;
      path = tracePath((gx, gy) => got.get(`${gx >> 8}/${gy >> 8}`)?.((gy & 255) * 256 + (gx & 255)) ?? 0, lat, lon, u, v);
    }
  }
  if (!fc && !path) throw new Error('no rain data');
  return decide(path, radarT, now, fc);
}
