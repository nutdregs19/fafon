// ฟ้าฝน alert server (Cloudflare Worker, free plan).
// Every 5 minutes: for each phone that turned alerts on, check its spots (last GPS position +
// starred places) with the same rain check the app's banner uses, and push a notification
// when rain is about to arrive. Storage: two KV keys — "subs" (phones + spots) and "state"
// (what was last said per spot, so the same rain isn't announced twice).
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { alertText, checkSpot, localHour, type RainAlert } from '../../web/src/alert/rain-alert';
import { decodeRadarPng } from './png';

interface Env {
  SUBS: KVNamespace;
  VAPID_PRIVATE: string; // JWK as JSON text (wrangler secret)
}

interface SpotIn { id: string; lat: number; lon: number; name?: string }
interface Sub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  spots: SpotIn[];
  updated: number;
}
interface SpotState { kind: RainAlert['kind']; sentAt?: number; sentKind?: RainAlert['kind'] }
type State = Record<string, SpotState>; // key: endpoint hash + spot id

const ALLOWED = [/^https:\/\/nutdregs19\.github\.io$/, /^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/];
const MAX_SUBS = 8, MAX_SPOTS = 6;
const MIN = 60_000;
const APP_URL = 'https://nutdregs19.github.io/fafon/';

const cors = (req: Request) => {
  const o = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED.some((r) => r.test(o)) ? o : APP_URL.slice(0, -7),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
};

async function hash(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const loadSubs = async (env: Env) => ((await env.SUBS.get('subs', 'json')) as Sub[] | null) ?? [];

// quiet at night, by the clock where the spot is (Thailand, or wherever the traveller is)
const quiet = (t: number, tz?: number) => { const h = localHour(t, tz); return h >= 22 || h < 6; };

/** VAPID keys from the stored JWK: public = raw point (0x04 | x | y), private = d. Both base64url. */
function vapidKeys(env: Env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE);
  const b = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const raw = new Uint8Array([4, ...b(jwk.x), ...b(jwk.y)]);
  const pub = btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Apple wants aes128gcm (RFC 8291) + the "vapid" scheme; this library sends exactly that
  return { subject: APP_URL, publicKey: pub, privateKey: jwk.d as string };
}

async function push(env: Env, sub: Sub, title: string, body: string, tag: string): Promise<number> {
  const payload = await buildPushPayload(
    { data: { title, body, tag, url: APP_URL }, options: { ttl: 1800, urgency: 'high', topic: tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'rain' } },
    { endpoint: sub.endpoint, expirationTime: null, keys: sub.keys },
    vapidKeys(env),
  );
  const r = await fetch(sub.endpoint, payload);
  return r.status;
}

/** Should this verdict become a notification, given what was said before? */
function worthSaying(a: RainAlert, prev: SpotState | undefined, now: number): boolean {
  const recent = prev?.sentAt != null && now - prev.sentAt < 90 * MIN;
  if (a.kind === 'soon') return a.inMin! <= 60 && !(recent && (prev!.sentKind === 'soon' || prev!.sentKind === 'now'));
  // rain started without an earlier warning (it popped up nearby)
  if (a.kind === 'now') return !recent && prev != null && prev.kind !== 'now' && prev.kind !== 'soon';
  // heavy rain in the model within 3 hours: at most once per 6 hours
  if (a.kind === 'later') {
    const said = prev?.sentKind === 'later' && now - (prev.sentAt ?? 0) < 6 * 60 * MIN;
    return a.level >= 2 && a.inMin! <= 180 && (a.prob ?? 0) >= 50 && !said;
  }
  return false;
}

async function run(env: Env) {
  const now = Date.now();
  const subs = await loadSubs(env);
  if (!subs.length) return;
  const state = ((await env.SUBS.get('state', 'json')) as State | null) ?? {};
  let dirty = false;
  const gone = new Set<string>();
  // every spot of every phone asks for the same radar list: fetch it once per run
  const memo = new Map<string, Promise<any>>();
  const io = {
    json: (u: string) => {
      if (!memo.has(u)) memo.set(u, fetch(u, { cf: { cacheTtl: 60 } }).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }));
      return memo.get(u)!;
    },
    tile: async (u: string) => {
      const r = await fetch(u, { cf: { cacheTtl: 300 } });
      if (!r.ok) throw new Error(String(r.status));
      return decodeRadarPng(await r.arrayBuffer());
    },
  };
  for (const sub of subs) {
    const h = await hash(sub.endpoint);
    for (const s of sub.spots) {
      const key = `${h}:${s.id}`;
      let a: RainAlert;
      try { a = await checkSpot(s.lat, s.lon, now, io); } catch { continue; }
      const prev = state[key];
      console.log('spot', s.id, JSON.stringify(a));
      const next: SpotState = { ...prev, kind: a.kind };
      if (!quiet(now, a.tz) && worthSaying(a, prev, now)) {
        const { title, body } = alertText(a);
        const where = s.name ? `${s.name}: ` : '';
        try {
          const status = await push(env, sub, where + title, body, `rain-${s.id}`);
          if (status === 404 || status === 410) gone.add(sub.endpoint); // phone turned alerts off
          if (status < 300) { next.sentAt = now; next.sentKind = a.kind; }
          console.log('push', s.id, status, title);
        } catch (e) { console.log('push failed', s.id, String(e)); }
      }
      if (JSON.stringify(next) !== JSON.stringify(prev)) { state[key] = next; dirty = true; }
    }
  }
  if (dirty) await env.SUBS.put('state', JSON.stringify(state));
  if (gone.size) await env.SUBS.put('subs', JSON.stringify(subs.filter((s) => !gone.has(s.endpoint))));
}

function validSpot(s: any): s is SpotIn {
  return s && typeof s.id === 'string' && s.id.length <= 40 && Number.isFinite(s.lat) && Number.isFinite(s.lon)
    && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180 && (s.name == null || (typeof s.name === 'string' && s.name.length <= 80));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const headers = cors(req);
    if (req.method === 'OPTIONS') return new Response(null, { headers });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
    if (req.method !== 'POST') return json({ ok: true, service: 'fafon-alert' });

    let b: any;
    try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    const endpoint = b?.sub?.endpoint ?? b?.endpoint;
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 1000) return json({ error: 'bad endpoint' }, 400);
    const subs = await loadSubs(env);

    if (url.pathname === '/subscribe') {
      const keys = b.sub?.keys;
      if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return json({ error: 'bad keys' }, 400);
      const spots = (Array.isArray(b.spots) ? b.spots : []).filter(validSpot).slice(0, MAX_SPOTS)
        .map((s: SpotIn) => ({ id: s.id, lat: +s.lat.toFixed(3), lon: +s.lon.toFixed(3), name: s.name }));
      const rest = subs.filter((s) => s.endpoint !== endpoint);
      const next: Sub = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, spots, updated: Date.now() };
      // newest first; the oldest phones drop off past the limit
      await env.SUBS.put('subs', JSON.stringify([next, ...rest].slice(0, MAX_SUBS)));
      return json({ ok: true, spots: spots.length });
    }
    if (url.pathname === '/unsubscribe') {
      await env.SUBS.put('subs', JSON.stringify(subs.filter((s) => s.endpoint !== endpoint)));
      return json({ ok: true });
    }
    if (url.pathname === '/test') {
      const sub = subs.find((s) => s.endpoint === endpoint);
      if (!sub) return json({ error: 'not subscribed' }, 404);
      try {
        const status = await push(env, sub, 'ทดสอบการแจ้งเตือนฝน', 'ถ้าเห็นข้อความนี้ แปลว่าแจ้งเตือนใช้งานได้แล้ว', 'test');
        return json({ ok: status < 300, status });
      } catch (e) { return json({ ok: false, error: String(e) }, 502); }
    }
    return json({ error: 'not found' }, 404);
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(run(env));
  },
};
