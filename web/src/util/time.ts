export const HOUR = 3600_000;

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('th-TH', o);
const fDayShort = fmt({ weekday: 'short', day: 'numeric' });
const fFull = fmt({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const fWeekday = fmt({ weekday: 'short' });
const fDate = fmt({ day: 'numeric', month: 'short' });
const fHour = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });

export const dayShort = (t: number) => fDayShort.format(t);
const WD = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
export const dayTick = (t: number) => { const d = new Date(t); return `${WD[d.getDay()]} ${d.getDate()}`; };
export const fullLabel = (t: number) => fFull.format(t).replace(' เวลา', '');
export const weekday = (t: number) => fWeekday.format(t);
export const dateShort = (t: number) => fDate.format(t);
export const hourLabel = (t: number) => fHour.format(t);

/** Local midnights strictly after `from`, up to `to`. */
export function midnights(from: number, to: number): number[] {
  const d = new Date(from);
  d.setHours(24, 0, 0, 0);
  const out: number[] = [];
  while (d.getTime() <= to) { out.push(d.getTime()); d.setDate(d.getDate() + 1); }
  return out;
}

export const isToday = (t: number) => new Date(t).toDateString() === new Date().toDateString();
