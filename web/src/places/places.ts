// GPS position + saved places (kept on this device only).
import type { Spot } from '../sheet/sheet';

const KEY = 'fafon.places';

export function loadPlaces(): Spot[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function savePlaces(list: Spot[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ }
}

const same = (a: Spot, b: Spot) => Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01;

export const isSaved = (s: Spot) => loadPlaces().some((p) => same(p, s));

export function toggleSaved(s: Spot) {
  const list = loadPlaces();
  const i = list.findIndex((p) => same(p, s));
  if (i >= 0) list.splice(i, 1);
  else list.push({ lat: s.lat, lon: s.lon, name: s.name ?? `${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}` });
  savePlaces(list);
}

/** Turn rain alerts for a saved place on or off. */
export function setPlaceAlert(i: number, on: boolean) {
  const list = loadPlaces();
  if (!list[i]) return;
  list[i].alert = on;
  savePlaces(list);
}

export function removePlace(i: number) {
  const list = loadPlaces();
  list.splice(i, 1);
  savePlaces(list);
}

export function gps(): Promise<Spot> {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('no gps'));
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
      rej,
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 10 * 60_000 },
    );
  });
}

/** Thai place name for a point (free, no key). */
export async function placeName(s: Spot): Promise<string | null> {
  try {
    const q = new URLSearchParams({ latitude: String(s.lat), longitude: String(s.lon), localityLanguage: 'th' });
    const r = await fetch('https://api.bigdatacloud.net/data/reverse-geocode-client?' + q);
    if (!r.ok) return null;
    const j = await r.json();
    const parts = [j.locality || j.city, j.principalSubdivision].filter(Boolean);
    const uniq = parts.filter((p: string, i: number) => parts.indexOf(p) === i);
    return uniq.join(', ') || j.countryName || null;
  } catch { return null; }
}
