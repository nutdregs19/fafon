// Bottom sheet for one spot: now, 10 day cards, and an hour-by-hour chart (Open-Meteo).
import { describe } from './weather-codes';
import { HOUR, dateShort, hourLabel, isToday, weekday } from '../util/time';

const MODEL: Record<string, string> = { ecmwf: 'ecmwf_ifs025', gfs: 'gfs_seamless' };
const HOURLY = ['temperature_2m', 'precipitation', 'precipitation_probability', 'wind_speed_10m', 'wind_direction_10m', 'weather_code'];
const DAILY = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'precipitation_probability_max', 'wind_speed_10m_max'];
const CURRENT = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'weather_code', 'wind_speed_10m', 'precipitation'];

export interface Spot { lat: number; lon: number; name?: string }

type Series = Record<string, (number | null)[]>;
interface Data { hourly: Series & { time: number[] }; daily: Series & { time: number[] }; current: Record<string, number | null> }

const cache = new Map<string, Promise<any>>();

async function fetchPoint(s: Spot): Promise<any> {
  const key = `${s.lat.toFixed(2)},${s.lon.toFixed(2)}`;
  if (!cache.has(key)) {
    const q = new URLSearchParams({
      latitude: s.lat.toFixed(3), longitude: s.lon.toFixed(3),
      hourly: HOURLY.join(','), daily: DAILY.join(','), current: CURRENT.join(','),
      models: Object.values(MODEL).join(','), timezone: 'auto', forecast_days: '10', timeformat: 'unixtime',
      wind_speed_unit: 'kmh',
    });
    const p = fetch('https://api.open-meteo.com/v1/forecast?' + q).then((r) => {
      if (!r.ok) throw new Error('open-meteo ' + r.status);
      return r.json();
    });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key)!;
}

/** Pick one model's columns out of a multi-model response (names end in _<model>). */
function pick(raw: any, model: string): Data {
  const take = (block: any, names: string[]) => {
    const out: any = { time: (block.time as number | number[]) };
    for (const n of names) {
      const own = block[`${n}_${model}`];
      const others = Object.values(MODEL).map((m) => block[`${n}_${m}`]);
      // fall back to the other model where this one has no value (e.g. rain chance)
      out[n] = Array.isArray(own)
        ? own.map((v: any, i: number) => v ?? others.map((o) => o?.[i]).find((x) => x != null) ?? null)
        : own ?? others.find((x) => x != null) ?? block[n] ?? null;
    }
    return out;
  };
  const fixTime = (b: any) => { if (Array.isArray(b.time)) b.time = b.time.map((t: number) => t * 1000); return b; };
  return {
    hourly: fixTime(take(raw.hourly, HOURLY)),
    daily: fixTime(take(raw.daily, DAILY)),
    current: take(raw.current, CURRENT),
  };
}

const r0 = (v: number | null | undefined) => (v == null ? '–' : Math.round(v).toString());
const r1 = (v: number | null | undefined) => (v == null ? '–' : v < 10 ? v.toFixed(1) : Math.round(v).toString());
const compass = (deg: number | null) => deg == null ? '' : ['เหนือ', 'ตอ.เฉียงเหนือ', 'ตะวันออก', 'ตอ.เฉียงใต้', 'ใต้', 'ตต.เฉียงใต้', 'ตะวันตก', 'ตต.เฉียงเหนือ'][Math.round(deg / 45) % 8];

export class Sheet {
  private body: HTMLElement;
  private spot: Spot | null = null;
  private token = 0;
  onSave: (s: Spot) => void = () => {};
  isSaved: (s: Spot) => boolean = () => false;

  constructor(private el: HTMLElement, public source: string) {
    this.body = el.querySelector('#sheet-body')!;
    const handle = el.querySelector('.sheet-handle') as HTMLElement;
    handle.onclick = () => this.close();
    let y0 = 0;
    handle.addEventListener('pointerdown', (e) => { y0 = e.clientY; });
    handle.addEventListener('pointerup', (e) => { if (e.clientY - y0 > 40) this.close(); });
  }

  get isOpen() { return this.el.classList.contains('open'); }

  close() {
    this.el.classList.remove('open');
    this.el.setAttribute('aria-hidden', 'true');
  }

  async open(s: Spot) {
    this.spot = s;
    this.el.classList.add('open');
    this.el.setAttribute('aria-hidden', 'false');
    await this.render();
  }

  setSource(src: string) { this.source = src; if (this.isOpen) this.render(); }

  setName(name: string) {
    if (!this.spot) return;
    this.spot.name = name;
    const h = this.body.querySelector('.sheet-title h2');
    if (h) h.textContent = name;
  }

  private async render() {
    const s = this.spot!, my = ++this.token;
    const title = s.name ?? `${s.lat.toFixed(2)}°, ${s.lon.toFixed(2)}°`;
    this.body.innerHTML = `${this.header(title)}<div class="loading">กำลังโหลดพยากรณ์…</div>`;
    this.bindHeader();
    let d: Data;
    try {
      d = pick(await fetchPoint(s), MODEL[this.source]);
    } catch {
      if (my === this.token) this.body.querySelector('.loading')!.textContent = 'โหลดข้อมูลไม่ได้ ลองใหม่อีกครั้ง';
      return;
    }
    if (my !== this.token) return;
    this.body.innerHTML = this.header(this.spot!.name ?? title) + this.now(d) + this.days(d) + this.chart(d) +
      `<p class="note">ข้อมูลจุดนี้: Open-Meteo · แบบจำลอง${this.source === 'ecmwf' ? 'ยุโรป (ECMWF)' : 'อเมริกา (GFS)'}</p>`;
    this.bindHeader();
    this.body.querySelectorAll<HTMLElement>('.day').forEach((el) => {
      el.onclick = () => {
        const chart = this.body.querySelector('.chart-scroll') as HTMLElement;
        const x = Number(el.dataset.x);
        chart.scrollTo({ left: Math.max(0, x - 8), behavior: 'smooth' });
      };
    });
  }

  private header(title: string) {
    const saved = this.spot && this.isSaved(this.spot);
    return `<div class="sheet-title"><div><h2>${title}</h2>
      <small>${this.spot!.lat.toFixed(3)}°N, ${this.spot!.lon.toFixed(3)}°E</small></div>
      <button class="save ${saved ? 'on' : ''}" aria-label="บันทึกเป็นที่ประจำ">
        <svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>
        <span>${saved ? 'บันทึกแล้ว' : 'บันทึกที่นี่'}</span></button></div>`;
  }

  private bindHeader() {
    const b = this.body.querySelector('.save') as HTMLButtonElement | null;
    if (b && this.spot) b.onclick = () => { this.onSave(this.spot!); this.render(); };
  }

  private now(d: Data) {
    const c = d.current, w = describe(c.weather_code as number);
    return `<div class="now"><div class="now-main">${w.icon}<span class="big">${r0(c.temperature_2m)}°</span></div>
      <div class="now-side"><b>${w.text}</b>
      <span>รู้สึกเหมือน ${r0(c.apparent_temperature)}° · ความชื้น ${r0(c.relative_humidity_2m)}%</span>
      <span>ลม ${r0(c.wind_speed_10m)} กม./ชม. · ฝน ${r1(c.precipitation)} มม.</span></div></div>`;
  }

  private days(d: Data) {
    const t = d.daily.time, hrs = d.hourly.time;
    const cards = t.map((day, i) => {
      const w = describe(d.daily.weather_code[i]);
      const prob = d.daily.precipitation_probability_max[i];
      const idx = hrs.findIndex((h) => h >= day);
      return `<button class="day" data-x="${Math.max(0, idx) * PX}">
        <span class="dname">${isToday(day) ? 'วันนี้' : weekday(day)}</span><span class="ddate">${dateShort(day)}</span>
        ${w.icon}
        <span class="dtemp"><b>${r0(d.daily.temperature_2m_max[i])}°</b> ${r0(d.daily.temperature_2m_min[i])}°</span>
        <span class="drain">${r1(d.daily.precipitation_sum[i])} มม.${prob != null ? ` · ${r0(prob)}%` : ''}</span>
      </button>`;
    });
    return `<div class="days">${cards.join('')}</div>`;
  }

  private chart(d: Data) {
    const h = d.hourly, n = h.time.length, W = n * PX, H = 170;
    const temps = h.temperature_2m.map((v) => v ?? NaN);
    const lo = Math.floor(Math.min(...temps.filter(isFinite)) - 1), hi = Math.ceil(Math.max(...temps.filter(isFinite)) + 1);
    const ty = (v: number) => 18 + (1 - (v - lo) / (hi - lo || 1)) * 62;
    const rainMax = Math.max(4, ...h.precipitation.map((v) => v ?? 0));
    let bars = '', line = '', labels = '', grid = '';
    for (let i = 0; i < n; i++) {
      const x = i * PX, t = h.time[i];
      const p = h.precipitation[i] ?? 0;
      if (p > 0.05) {
        const bh = Math.max(2, Math.sqrt(p / rainMax) * 42);
        bars += `<rect x="${x + 1}" y="${130 - bh}" width="${PX - 2}" height="${bh}" rx="1.5"/>`;
      }
      if (isFinite(temps[i])) line += `${line ? 'L' : 'M'}${x + PX / 2},${ty(temps[i]).toFixed(1)}`;
      const hr = new Date(t).getHours();
      if (hr === 0) grid += `<line x1="${x}" x2="${x}" y1="0" y2="${H}"/><text class="dayname" x="${x + 4}" y="12">${weekday(t)} ${dateShort(t)}</text>`;
      if (hr % 3 === 0) {
        if (isFinite(temps[i])) labels += `<text x="${x + PX / 2}" y="${ty(temps[i]) - 6}" class="tl">${r0(temps[i])}°</text>`;
        labels += `<text x="${x + PX / 2}" y="146" class="hl">${hourLabel(t).slice(0, 2)}</text>`;
        const ws = h.wind_speed_10m[i], wd = h.wind_direction_10m[i];
        if (ws != null && wd != null) {
          labels += `<g transform="translate(${x + PX / 2},160) rotate(${wd + 180})"><path class="arrow" d="M0,-5 L3,3 L0,1.5 L-3,3Z"/></g>`;
        }
      }
    }
    const nowX = Math.max(0, h.time.findIndex((t) => t > Date.now() - HOUR)) * PX;
    return `<div class="chart-head"><span><i class="k-t"></i>อุณหภูมิ</span><span><i class="k-r"></i>ฝน (มม./ชม.)</span><span>ลูกศร = ทิศลม</span></div>
      <div class="chart-scroll" data-now="${nowX}"><svg width="${W}" height="${H}" class="chart">
      <g class="grid">${grid}</g><g class="bars">${bars}</g><path class="tline" d="${line}"/>
      <line class="nowline" x1="${nowX}" x2="${nowX}" y1="0" y2="${H}"/>${labels}</svg></div>
      <div class="wind-note">ลมแรงสุดวันนี้ ${r0(d.daily.wind_speed_10m_max[0])} กม./ชม. จากทิศ${compass(h.wind_direction_10m[Math.round(nowX / PX)])}</div>`;
  }

  /** After render, scroll the chart so "now" sits near the left edge. */
  scrollToNow() {
    const el = this.body.querySelector('.chart-scroll') as HTMLElement | null;
    if (el) el.scrollLeft = Math.max(0, Number(el.dataset.now) - 30);
  }
}

const PX = 14; // chart pixels per hour
