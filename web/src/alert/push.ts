// Phone notifications for rain: this phone registers with the alert server (alert-server/),
// which checks the radar every 5 minutes and sends a notification when rain is coming.
// On iPhone this only works once the app is added to the Home Screen (iOS 16.4+).
import type { Spot } from '../sheet/sheet';

// the server's address; filled in once it's deployed to Cloudflare.
// localStorage 'fafon.alertServer' overrides it (for testing a local copy of the server).
const PROD_SERVER = '';
const SERVER = (() => { try { return localStorage.getItem('fafon.alertServer'); } catch { return null; } })()
  ?? (import.meta.env.DEV ? 'http://localhost:8787' : PROD_SERVER);
const VAPID_PUBLIC = 'BKSBZle35B2xpasZzkgzVwvAxOF0WEhOUIjPwR4_msb9JX1Q9dQZ4OrMYgfG6B8OVx_n1Fqx8PUztR2grFtnbQI';

export interface AlertSpot { id: string; lat: number; lon: number; name?: string }

export const serverReady = () => SERVER !== '';
export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
/** Can this browser receive notifications at all (as it is opened right now)? */
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(b64: string) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function current(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration(); // (ready would wait forever without one)
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function isOn(): Promise<boolean> {
  try { return (await current()) !== null && Notification.permission === 'granted'; } catch { return false; }
}

async function post(path: string, body: unknown) {
  const r = await fetch(SERVER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || 'server ' + r.status);
  return j;
}

/** Ask permission (must follow a tap), register, and send the spots to watch. */
export async function enable(spots: AlertSpot[]) {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('denied');
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) throw new Error('no service worker');
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC) });
  await post('/subscribe', { sub: sub.toJSON(), spots });
  lastSync = { key: spotsKey(spots), at: Date.now() };
}

export async function disable() {
  const sub = await current();
  if (!sub) return;
  await post('/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

export async function sendTest() {
  const sub = await current();
  if (!sub) throw new Error('off');
  return post('/test', { endpoint: sub.endpoint });
}

let lastSync = { key: '', at: 0 };
const spotsKey = (s: AlertSpot[]) => s.map((p) => `${p.id}:${p.lat.toFixed(2)},${p.lon.toFixed(2)}`).join('|');

/** Keep the server's list up to date (new GPS position, stars changed). Cheap to call often. */
export async function sync(spots: AlertSpot[]) {
  if (!serverReady()) return;
  const sub = await current().catch(() => null);
  if (!sub || Notification.permission !== 'granted') return;
  const key = spotsKey(spots);
  // the free server allows ~1000 saves a day: only when something moved, or twice an hour
  if (key === lastSync.key && Date.now() - lastSync.at < 30 * 60_000) return;
  lastSync = { key, at: Date.now() };
  await post('/subscribe', { sub: sub.toJSON(), spots }).catch(() => { lastSync.at = 0; });
}

export const gpsSpot = (s: Spot): AlertSpot => ({ id: 'gps', lat: s.lat, lon: s.lon, name: s.name || 'ตำแหน่งล่าสุด' });
