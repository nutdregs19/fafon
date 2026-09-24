import { Map as MLMap, Marker, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { FrameStore, loadManifest, sample, type Field, type Manifest } from './data/store';
import { FieldLayer } from './map/field-layer';
import { RAMPS, gradientCss, legendPos, type LayerKey } from './map/palettes';
import { Particles } from './wind/particles';
import { Timeline } from './timeline/timeline';
import { Satellite } from './satellite/satellite';
import { Nowcast } from './satellite/nowcast';
import { Sheet, type Spot } from './sheet/sheet';
import { gps, isSaved, loadPlaces, placeName, removePlace, setPlaceAlert, toggleSaved } from './places/places';
import { HOUR, hourLabel } from './util/time';
import { RainBanner } from './alert/banner';
import * as rainPush from './alert/push';

setWorkerUrl(workerUrl);

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const pref = {
  get: (k: string) => { try { return localStorage.getItem('fafon.' + k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem('fafon.' + k, v); } catch { /* ignore */ } },
};

const LAYERS: { key: LayerKey; label: string; icon: string }[] = [
  { key: 'rain', label: 'ฝน', icon: '<path d="M12 3.5c3 4 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0c0-3 2.5-6 5.5-10Z"/>' },
  { key: 'clouds', label: 'เมฆ', icon: '<path d="M7 18.5h10.5a4 4 0 0 0 .4-8A6 6 0 0 0 6.4 12 3.3 3.3 0 0 0 7 18.5Z"/>' },
  { key: 'wind', label: 'ลม', icon: '<path d="M3 8.5h11a3 3 0 1 0-3-3M3 12.5h16a3 3 0 1 1-3 3M3 16.5h7"/>' },
  { key: 'temp', label: 'อุณหภูมิ', icon: '<path d="M10 14.2V5a2 2 0 1 1 4 0v9.2a4 4 0 1 1-4 0Z"/><path d="M12 11v5"/>' },
];

let layer = (pref.get('layer') as LayerKey) || 'rain';
let manifest: Manifest;
let stores: Record<string, FrameStore> = {};
let sourceKey = 'ecmwf';
let field: FieldLayer;
let particles: Particles;
let sat: Satellite;
let nowcast: Nowcast;
let timeline: Timeline;
let sheet: Sheet;
let nowT = Date.now();
let picked: Spot | null = null;
let pickerMarker: Marker | null = null;
let gpsMarker: Marker | null = null;
let here: Spot | null = null; // last GPS fix, for the alert strip and phone alerts
const banner = new RainBanner($('#rain-alert'));
banner.onTap = (s) => { map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 6) }); pick({ ...s }, true); };
let lastDraw = { t: NaN, layer: '', source: '' };

function toast(msg: string, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout((t as any)._h);
  (t as any)._h = setTimeout(() => (t.hidden = true), ms);
}

const map = new MLMap({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  center: [100.6, 13.5],
  zoom: 4.4,
  minZoom: 3,
  maxZoom: 11.5,
  maxBounds: [[70, -18], [140, 42]],
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  attributionControl: false,
  fadeDuration: 0,
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();

const manifestP = loadManifest();
manifestP.catch(() => {});

map.once('style.load', async () => {
  tuneBasemap();
  // residential areas are only drawn up to zoom 9 in this style; keep them when zooming further
  if (map.getLayer('landuse_residential')) map.setLayerZoomRange('landuse_residential', 0, 15);
  try {
    manifest = await manifestP;
  } catch {
    const loading = $('#app-loading');
    if (loading) loading.textContent = 'โหลดพยากรณ์ไม่สำเร็จ ตรวจอินเทอร์เน็ตแล้วลองเปิดใหม่';
    toast('โหลดข้อมูลพยากรณ์ไม่ได้ ตรวจอินเทอร์เน็ตแล้วเปิดใหม่', 8000);
    return;
  }
  if (!manifest.sources[sourceKey]) sourceKey = Object.keys(manifest.sources)[0];
  const before = map.getLayer('boundary_state') ? 'boundary_state' : undefined;
  field = new FieldLayer(map, Object.values(manifest.sources)[0].grid, before);
  sat = new Satellite(map, before);
  nowcast = new Nowcast(map, before);
  nowcast.onReady = () => scheduleRender(true);
  // Like Windy: the rain layer opens on the newest real radar picture (sharp, observed),
  // then press play / swipe right into the forecast. Only if the user hasn't moved yet.
  sat.onRadarReady = () => {
    const r = sat.latestRadar();
    if (r !== null && layer === 'rain' && timeline.t === nowT && r < nowT) timeline.set(r);
    scheduleRender();
  };
  particles = new Particles(map, $('#wind') as HTMLCanvasElement);
  sheet = new Sheet($('#sheet'), sourceKey);
  sheet.isSaved = isSaved;
  sheet.onSave = (s) => { toggleSaved(s); renderPlacesMenu(); toast(isSaved(s) ? 'บันทึกเป็นที่ประจำแล้ว' : 'เอาออกจากที่ประจำแล้ว'); };

  buildLayerButtons();
  timeline = new Timeline($('#timeline'), nowT - 12 * HOUR, nowT, lastFrameTime());
  timeline.tag = (t) => {
    const nc = nowcastFade(t);
    if (nc !== null) return nc === 1 ? 'ทำนายจากเรดาร์ (ระยะสั้น)' : 'ทำนายจากเรดาร์ → พยากรณ์';
    if (t >= nowT) return 'พยากรณ์';
    const r = sat.radarFor(t);
    if (r === null) return `ภาพดาวเทียมจริง · ถ่ายเมื่อ ${hourLabel(sat.frameFor(t))}`;
    return layer === 'rain' ? `เรดาร์ฝนจริง · ${hourLabel(r)}` : `ดาวเทียม + เรดาร์ฝน · ${hourLabel(r)}`;
  };
  timeline.onChange = (t) => { scheduleRender(); schedulePrefetch(t); };
  timeline.set(nowT, false);
  useSource(sourceKey);
  particles.start();

  map.on('click', (e) => pick({ lat: e.lngLat.lat, lon: e.lngLat.lng }, false));
  map.on('moveend', flipPicker);
  map.on('moveend', () => scheduleRender()); // the nowcast follows the view
  $('#place-chip').onclick = () => togglePlacesMenu();
  renderPlacesMenu();
  locate(true);
});

/** Borders and names stay above the weather colours; roads fade out at the zoom we use. */
function tuneBasemap() {
  for (const l of map.getStyle().layers) {
    if (l.type === 'symbol' && /^place_/.test(l.id)) {
      map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:th'], ['get', 'name:latin'], ['get', 'name']]);
      map.setPaintProperty(l.id, 'text-color', '#ffffff');
      map.setPaintProperty(l.id, 'text-halo-color', 'rgba(15,15,15,0.85)');
      map.setPaintProperty(l.id, 'text-halo-width', 1.4);
    }
    if (/^boundary_country/.test(l.id)) map.setPaintProperty(l.id, 'line-color', 'rgba(230,235,245,0.55)');
    if (l.id === 'water') map.setPaintProperty(l.id, 'fill-color', '#0a1220');
    if (l.id === 'background') map.setPaintProperty(l.id, 'background-color', '#141a24');
  }
}

// Windy draws rain on flat mid-grey (land and sea nearly the same), so the colours pop.
// Other layers cover the map with colour and keep the dark base.
type Theme = 'dark' | 'grey';
const fadeIn = (z0: number, z1: number, max: number) => ['interpolate', ['linear'], ['zoom'], z0, 0, z1, max];
const GREY: [RegExp, string, unknown][] = [
  [/^background$/, 'background-color', '#858585'],
  [/^water$/, 'fill-color', '#6d747d'],
  [/^waterway$/, 'line-color', '#666d76'],
  [/^(landcover|building|aeroway|road_area)/, 'fill-opacity', 0],
  [/^landuse_park$/, 'fill-opacity', 0],
  // towns and cities a shade darker than the countryside, appearing as you zoom in
  [/^landuse_residential$/, 'fill-color', '#707070'],
  [/^landuse_residential$/, 'fill-opacity', fadeIn(6, 9, 0.6)],
  [/^boundary_country/, 'line-color', 'rgba(30,30,30,0.85)'],
  [/^boundary_state$/, 'line-color', 'rgba(30,30,30,0.35)'],
  // roads: thin darker lines that fade in with zoom (hidden when zoomed out, no black grid)
  [/^highway_(motorway|major)/, 'line-color', '#5e5e5e'],
  [/^highway_(motorway|major)/, 'line-opacity', fadeIn(6, 8, 0.85)],
  [/^highway_(minor|path)/, 'line-color', '#6a6a6a'],
  [/^highway_(minor|path)/, 'line-opacity', fadeIn(8.5, 10.5, 0.7)],
  [/^(railway|road_|aeroway)/, 'line-opacity', 0],
  [/^highway_name/, 'text-opacity', 0],
  // names: dark text with a light outline, as on Windy's grey map
  [/^(place_|water_name)/, 'text-color', '#161616'],
  [/^(place_|water_name)/, 'text-halo-color', 'rgba(255,255,255,0.8)'],
];
const savedPaint = new Map<string, unknown>();
let theme: Theme = 'dark';

function setTheme(t: Theme) {
  if (t === theme) return;
  theme = t;
  for (const l of map.getStyle().layers) {
    for (const [re, prop, val] of GREY) {
      const kind = l.type === 'symbol' ? /^(text|icon)-/ : new RegExp('^' + l.type + '-');
      if (!re.test(l.id) || !kind.test(prop)) continue;
      const key = l.id + '|' + prop;
      if (!savedPaint.has(key)) savedPaint.set(key, map.getPaintProperty(l.id, prop as any));
      map.setPaintProperty(l.id, prop as any, t === 'grey' ? val : savedPaint.get(key));
    }
  }
}

// wind lines belong to the wind layer only — each layer shows one thing, clearly
const WIND_ALPHA: Record<LayerKey, number> = { rain: 0, clouds: 0, wind: 0.8, temp: 0 };

function lastFrameTime() {
  const fr = manifest.sources[sourceKey].frames;
  return fr[fr.length - 1].t;
}

function useSource(key: string) {
  sourceKey = key;
  if (!stores[key]) {
    stores[key] = new FrameStore(manifest, manifest.sources[key]);
    stores[key].onLoaded = () => scheduleRender();
  }
  stores[key].prefetch(Math.max(timeline.t, nowT));
  timeline.setRange(nowT - 12 * HOUR, nowT, lastFrameTime());
  sheet.setSource(key);
  scheduleRender(true);
}

// keep downloading the frames around wherever the user is looking (memory holds only a window)
let prefetchTimer = 0;
function schedulePrefetch(t: number) {
  clearTimeout(prefetchTimer);
  prefetchTimer = window.setTimeout(() => stores[sourceKey]?.prefetch(Math.max(t, nowT)), 250);
}

let pending = 0;
function scheduleRender(force = false) {
  if (force) lastDraw.t = NaN;
  if (pending) return;
  pending = requestAnimationFrame(() => { pending = 0; render(); });
}

// Radar nowcast on the rain layer: full strength for the first hour after the newest radar
// picture, then fading into the model forecast over the second hour.
const NOWCAST_FULL = 60 * 60_000, NOWCAST_END = 120 * 60_000;
/** Nowcast strength at time t (1 = only nowcast), or null when it doesn't apply. */
function nowcastFade(t: number): number | null {
  const r = sat?.latestRadar();
  if (layer !== 'rain' || r == null) return null;
  const lead = t - r;
  if (lead <= 5 * 60_000 || lead >= NOWCAST_END) return null;
  return lead <= NOWCAST_FULL ? 1 : 1 - (lead - NOWCAST_FULL) / (NOWCAST_END - NOWCAST_FULL);
}

function drawField(f: Field | null, t: number) {
  // redraw the colours only when something visible changed (~10 min of model time)
  if (f && (Math.abs(t - lastDraw.t) >= 10 * 60_000 || lastDraw.layer !== layer || lastDraw.source !== sourceKey || Number.isNaN(lastDraw.t))) {
    field.draw(f, layer);
    lastDraw = { t, layer, source: sourceKey };
  }
}

function render() {
  const t = timeline.t, store = stores[sourceKey];
  const fade = nowcastFade(t);
  const past = t < nowT && fade === null;
  let f: Field | null;
  if (fade !== null) {
    sat.hide();
    nowcast.prepare(sat.radarList());
    nowcast.show((t - sat.latestRadar()!) / 60_000, fade);
    f = store.at(t);
    // the forecast underneath shows through as the nowcast fades (or alone until it's ready)
    const ncShown = nowcast.ready;
    field.setVisible(!ncShown || fade < 1);
    field.setOpacity(ncShown ? 1 - fade : 1);
    drawField(f, t);
    setTheme('grey');
    particles.setAlpha(0);
  } else if (past) {
    nowcast.hide();
    sat.show(t, layer === 'rain');
    field.setVisible(false);
    f = store.at(nowT);
    setTheme(sat.mode === 'radar' ? 'grey' : 'dark');
    particles.setAlpha(0); // observed pictures: no model wind lines on top
  } else {
    nowcast.hide();
    sat.hide();
    field.setVisible(true);
    field.setOpacity(1);
    f = store.at(t);
    setTheme(layer === 'rain' ? 'grey' : 'dark');
    particles.setAlpha(WIND_ALPHA[layer]);
    drawField(f, t);
  }
  $('#app-loading')?.remove();
  particles.setField(f);
  updateLegend(past);
  updatePickerValue(f, past);
}

function buildLayerButtons() {
  const nav = $('#layers');
  nav.innerHTML = LAYERS.map((l) => `<button data-key="${l.key}" class="${l.key === layer ? 'on' : ''}">
    <svg viewBox="0 0 24 24" class="ic">${l.icon}</svg><span>${l.label}</span></button>`).join('');
  nav.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.onclick = () => {
      layer = b.dataset.key as LayerKey;
      pref.set('layer', layer);
      nav.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      timeline.set(timeline.t, false); // refresh the bubble text for the new layer
      scheduleRender(true);
    };
  });
}

let legendKey = '';
function updateLegend(past: boolean) {
  const radar = past && sat.mode === 'radar';
  const key = past ? (radar ? 'radar' : 'sat') : layer;
  if (key === legendKey) return;
  legendKey = key;
  const el = $('#legend');
  if (past && !radar) {
    el.innerHTML = `<span class="lg-title">ดาวเทียม</span><div class="lg-bar" style="background:linear-gradient(90deg, rgba(210,210,215,0.1), rgba(225,225,230,0.55), #f4f6fa), #1b2029"><span style="left:8%">เมฆต่ำ</span><span style="left:90%">พายุ</span></div>`;
    return;
  }
  const lk: LayerKey = radar ? 'rain' : layer;
  const r = RAMPS[lk];
  const base = lk === 'rain' ? '#858585' : '#1b2029';
  const ticks = r.legend.map((v) => `<span style="left:${(legendPos(r, v) * 100).toFixed(1)}%">${v}</span>`).join('');
  el.innerHTML = `<span class="lg-title">${radar ? 'เรดาร์ฝน<br>' : ''}${r.unit}</span>
    <div class="lg-bar" style="background:${gradientCss(r)}, ${base}">${ticks}</div>`;
}

// ---------- picker: tap the map to read the value there ----------

function pick(s: Spot, openSheet: boolean) {
  picked = s;
  const box = $('#picker');
  box.hidden = false;
  if (!pickerMarker) {
    pickerMarker = new Marker({ element: box, anchor: 'bottom-left', offset: [-7, 7] });
    (box.querySelector('.picker-label') as HTMLButtonElement).onclick = (e) => { e.stopPropagation(); if (picked) openSpot(picked); };
  }
  pickerMarker.setLngLat([s.lon, s.lat]).addTo(map);
  flipPicker();
  scheduleRender();
  if (openSheet) openSpot(s);
}

function flipPicker() {
  if (!picked) return;
  const x = map.project([picked.lon, picked.lat]).x;
  $('#picker').classList.toggle('flip', x > map.getContainer().clientWidth - 190);
}

function updatePickerValue(f: Field | null, past: boolean) {
  if (!picked || !f) return;
  const g = f.g, { lat, lon } = picked;
  const lbl = $('#picker .picker-label');
  if (past) { lbl.innerHTML = 'ดูภาพเมฆจริง <b>›</b>'; return; }
  const p = sample(g, f.p, lon, lat);
  if (Number.isNaN(p)) { lbl.innerHTML = 'นอกพื้นที่ <b>›</b>'; return; }
  const t = sample(g, f.t, lon, lat), c = sample(g, f.c, lon, lat);
  const ws = Math.hypot(sample(g, f.u, lon, lat), sample(g, f.v, lon, lat)) * 3.6;
  const main = layer === 'rain' ? `${p < 0.1 ? 'ไม่มีฝน' : p.toFixed(1) + ' มม./ชม.'}`
    : layer === 'clouds' ? `เมฆ ${Math.round(c)}%`
    : layer === 'wind' ? `ลม ${Math.round(ws)} กม./ชม.`
    : `${Math.round(t)}°C`;
  lbl.innerHTML = `${main}<small>${Math.round(t)}°</small><b>›</b>`;
}

async function openSpot(s: Spot) {
  closePlacesMenu();
  await sheet.open(s);
  sheet.scrollToNow();
  if (!s.name) {
    const name = await placeName(s);
    if (name && picked === s) { s.name = name; sheet.setName(name); }
  }
}

// ---------- places ----------

async function locate(initial: boolean) {
  try {
    const s = await gps();
    if (!gpsMarker) {
      const dot = document.createElement('div');
      dot.className = 'gps-dot';
      gpsMarker = new Marker({ element: dot });
    }
    gpsMarker.setLngLat([s.lon, s.lat]).addTo(map);
    map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 5.5), duration: initial ? 1200 : 800 });
    pick(s, !initial);
    here = { ...s };
    banner.watch(here);
    // don't write a name onto `s` here — leave it unset so openSpot()'s own lookup
    // (triggered by pick when !initial) resolves and syncs the sheet's title itself
    const name = await placeName(s);
    $('#place-name').textContent = name ?? 'ตำแหน่งของฉัน';
    if (name && here) here.name = name;
    syncAlerts();
  } catch {
    const saved = loadPlaces()[0];
    $('#place-name').textContent = saved?.name ?? 'แตะแผนที่เพื่อดูพยากรณ์';
    if (saved && initial) { map.jumpTo({ center: [saved.lon, saved.lat], zoom: 5.5 }); pick(saved, false); }
    else if (!initial) toast('เปิดตำแหน่งไม่ได้ — อนุญาตให้เข้าถึงตำแหน่งในการตั้งค่าเครื่อง', 5000);
    if (!here && saved) banner.watch(saved);
  }
}

// ---------- rain alerts on the phone ----------

const placeId = (p: Spot) => `p${p.lat.toFixed(2)}_${p.lon.toFixed(2)}`;
function alertSpots(): rainPush.AlertSpot[] {
  const out: rainPush.AlertSpot[] = here ? [rainPush.gpsSpot(here)] : [];
  for (const p of loadPlaces()) if (p.alert) out.push({ id: placeId(p), lat: p.lat, lon: p.lon, name: p.name });
  return out;
}
const syncAlerts = () => { rainPush.sync(alertSpots()).catch(() => {}); };

// coming back to the app: take a fresh GPS fix quietly (no map jump) so the strip and the
// server follow you around
let lastFix = Date.now();
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || Date.now() - lastFix < 5 * 60_000) return;
  lastFix = Date.now();
  try {
    const s = await gps();
    gpsMarker?.setLngLat([s.lon, s.lat]);
    const same = here && Math.abs(here.lat - s.lat) < 0.02 && Math.abs(here.lon - s.lon) < 0.02;
    here = { ...s, name: same ? here!.name : undefined };
    banner.watch(here);
    if (!here.name) { const n = await placeName(s); if (n && here) here.name = n; }
    syncAlerts();
  } catch { /* keep the last one */ }
});

const BELL = '<svg viewBox="0 0 24 24" class="ic"><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/></svg>';

async function renderAlertSection() {
  const box = document.querySelector<HTMLElement>('#places-menu .alerts');
  if (!box) return;
  if (!rainPush.serverReady()) { box.hidden = true; return; }
  const on = await rainPush.isOn();
  box.innerHTML = on
    ? `<div class="al-on">${BELL}<span>แจ้งเตือนฝน: <b>เปิดอยู่</b></span></div>
       <div class="al-btns"><button class="al-test">ส่งทดสอบ</button><button class="al-off">ปิด</button></div>
       <p class="hint">เตือนก่อนฝนมาถึงราว 1 ชม. ที่ตำแหน่งล่าสุดที่เปิดแอป และที่ประจำที่กดกระดิ่งไว้ · เงียบช่วง 4 ทุ่ม–6 โมงเช้า</p>`
    : `<button class="pl al-enable">${BELL}เปิดแจ้งเตือนฝนเข้ามือถือ</button>`;
  box.querySelector<HTMLButtonElement>('.al-enable')?.addEventListener('click', enableAlerts);
  box.querySelector<HTMLButtonElement>('.al-test')?.addEventListener('click', async () => {
    try { await rainPush.sendTest(); toast('ส่งแล้ว รอดูข้อความเด้งในไม่กี่วินาที'); }
    catch { toast('ส่งไม่สำเร็จ ลองปิดแล้วเปิดแจ้งเตือนใหม่', 5000); }
  });
  box.querySelector<HTMLButtonElement>('.al-off')?.addEventListener('click', async () => {
    await rainPush.disable().catch(() => {});
    toast('ปิดแจ้งเตือนฝนแล้ว');
    renderAlertSection();
  });
}

async function enableAlerts() {
  if (!rainPush.pushSupported()) {
    if (rainPush.isIos() && !rainPush.isStandalone()) {
      showHelp(`<b>iPhone ต้องเพิ่มแอปลงหน้าจอโฮมก่อน</b>
        <ol><li>กดปุ่ม <b>แชร์</b> (สี่เหลี่ยมมีลูกศรชี้ขึ้น) ด้านล่างของ Safari</li>
        <li>เลือก <b>เพิ่มไปยังหน้าจอโฮม</b> แล้วกด <b>เพิ่ม</b></li>
        <li>เปิด <b>ฟ้าฝน</b> จากไอคอนบนหน้าจอโฮม แล้วกดปุ่มเปิดแจ้งเตือนอีกครั้ง</li></ol>`);
    } else {
      toast('เบราว์เซอร์นี้รับแจ้งเตือนไม่ได้', 5000);
    }
    return;
  }
  if (!here && !loadPlaces().some((p) => p.alert)) {
    toast('ต้องเปิดตำแหน่ง (GPS) หรือกดกระดิ่งที่ที่ประจำก่อน จะได้รู้ว่าให้เตือนที่ไหน', 6000);
    return;
  }
  try {
    await rainPush.enable(alertSpots());
    toast('เปิดแจ้งเตือนฝนแล้ว');
  } catch (e) {
    toast(String(e).includes('denied')
      ? 'ยังไม่ได้อนุญาต — ไปที่ การตั้งค่า > การแจ้งเตือน > ฟ้าฝน แล้วเปิด "อนุญาตการแจ้งเตือน"'
      : 'เปิดแจ้งเตือนไม่สำเร็จ ลองใหม่อีกครั้ง', 7000);
  }
  renderAlertSection();
}

function showHelp(html: string) {
  const d = $('#help');
  d.innerHTML = `<div class="help-card glass">${html}<button class="help-ok">เข้าใจแล้ว</button></div>`;
  d.hidden = false;
  d.onclick = (e) => { if (e.target === d || (e.target as HTMLElement).classList.contains('help-ok')) d.hidden = true; };
}

function renderPlacesMenu() {
  const list = loadPlaces();
  const m = $('#places-menu');
  m.innerHTML = `<button class="pl gps"><svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/><circle cx="12" cy="12" r="7.5"/></svg>ตำแหน่งของฉัน</button>` +
    (list.length ? list.map((p, i) => `<div class="pl-row"><button class="pl" data-i="${i}"><svg viewBox="0 0 24 24" class="ic star"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>${p.name}</button>${rainPush.serverReady() ? `<button class="bell${p.alert ? ' on' : ''}" data-i="${i}" aria-label="เตือนฝนที่นี่">${BELL}</button>` : ''}<button class="del" data-i="${i}" aria-label="เอาออก">×</button></div>`).join('')
      : `<p class="hint">แตะแผนที่ แล้วกด "บันทึกที่นี่" เพื่อเก็บที่ประจำ</p>`) +
    `<div class="alerts"></div>`;
  renderAlertSection();
  m.querySelectorAll<HTMLButtonElement>('.bell').forEach((b) => {
    b.onclick = () => {
      const i = Number(b.dataset.i), on = !loadPlaces()[i]?.alert;
      setPlaceAlert(i, on);
      renderPlacesMenu();
      syncAlerts();
      toast(on ? 'จะเตือนฝนที่นี่ด้วย' : 'เลิกเตือนฝนที่นี่');
    };
  });
  (m.querySelector('.gps') as HTMLButtonElement).onclick = () => { closePlacesMenu(); locate(false); };
  m.querySelectorAll<HTMLButtonElement>('.pl[data-i]').forEach((b) => {
    b.onclick = () => {
      const p = loadPlaces()[Number(b.dataset.i)];
      $('#place-name').textContent = p.name ?? '';
      map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 6) });
      pick({ ...p }, true);
    };
  });
  m.querySelectorAll<HTMLButtonElement>('.del').forEach((b) => {
    b.onclick = () => { removePlace(Number(b.dataset.i)); renderPlacesMenu(); syncAlerts(); };
  });
}

function togglePlacesMenu() { const m = $('#places-menu'); m.hidden = !m.hidden; }
function closePlacesMenu() { $('#places-menu').hidden = true; }

// reload after a long break — either coming back to a hidden tab, or a tab left
// open and foregrounded the whole time (e.g. an always-on display)
let openedAt = Date.now();
function reloadIfStale() {
  if (Date.now() - openedAt > 3 * HOUR) { openedAt = Date.now(); location.reload(); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) reloadIfStale(); });
setInterval(reloadIfStale, 15 * 60_000);
