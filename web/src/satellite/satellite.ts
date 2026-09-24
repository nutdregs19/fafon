// Observed weather for the past slice of the timeline:
//  - Himawari-9 infrared from NASA GIBS (every 10 min, ~30-40 min behind)
//  - RainViewer radar composite (free tier: last 2 h, 10 min steps, zoom <= 7)
import type { Map as MLMap } from 'maplibre-gl';
import { HOUR } from '../util/time';
import { PROTOCOL, registerRadarProtocol } from './radar-colors';
import { SAT_PROTOCOL, registerSatelliteProtocol } from './sat-colors';

const MIN = 60_000;

/** A time series of raster tile layers; keeps the old picture until the new one has loaded. */
class TimedRaster {
  private loaded: number[] = [];
  private shown: number | null = null;
  private pendingOff = new Map<number, () => void>();

  constructor(private map: MLMap, private prefix: string, private beforeId: string | undefined,
    private opt: { url: (t: number) => string; maxzoom: number; opacity: number; attribution: string; keep: number }) {}

  show(ft: number) {
    if (ft === this.shown) return;
    const id = this.prefix + ft;
    if (!this.map.getLayer(id)) {
      this.map.addSource(id, { type: 'raster', tiles: [this.opt.url(ft)], tileSize: 256, maxzoom: this.opt.maxzoom, attribution: this.opt.attribution });
      this.map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': this.opt.opacity, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, this.beforeId);
      this.loaded.push(ft);
    } else {
      this.map.moveLayer(id, this.beforeId);
      this.map.setLayoutProperty(id, 'visibility', 'visible');
    }
    const prev = this.shown;
    this.shown = ft;
    const done = () => {
      if (this.shown !== ft) return;
      for (const other of this.loaded) if (other !== ft) this.map.setLayoutProperty(this.prefix + other, 'visibility', 'none');
      this.trim();
    };
    // at most one waiting listener per frame (re-showing a frame used to leave a second one behind)
    this.pendingOff.get(ft)?.();
    this.pendingOff.delete(ft);
    if (prev === null || this.map.isSourceLoaded(id)) done();
    else {
      const onData = (e: any) => {
        if (e.sourceId === id && this.map.getSource(id) && this.map.isSourceLoaded(id)) {
          this.map.off('sourcedata', onData);
          this.pendingOff.delete(ft);
          done();
        }
      };
      this.map.on('sourcedata', onData);
      this.pendingOff.set(ft, () => this.map.off('sourcedata', onData));
    }
  }

  /** Put the current picture back on top (a newer layer of another series may cover it). */
  raise() {
    if (this.shown !== null) this.map.moveLayer(this.prefix + this.shown, this.beforeId);
  }

  hide() {
    for (const ft of this.loaded) this.map.setLayoutProperty(this.prefix + ft, 'visibility', 'none');
    this.shown = null;
  }

  private trim() {
    while (this.loaded.length > this.opt.keep) {
      const i = this.loaded.findIndex((x) => x !== this.shown);
      const old = this.loaded.splice(i, 1)[0];
      // an evicted frame may still have a "sourcedata" listener from its own show()
      // waiting to fire — remove it explicitly, or it never gets cleaned up once its
      // source is gone (the event it's waiting for will never come)
      this.pendingOff.get(old)?.();
      this.pendingOff.delete(old);
      this.map.removeLayer(this.prefix + old);
      this.map.removeSource(this.prefix + old);
    }
  }
}

const GIBS = 'Himawari_AHI_Band13_Clean_Infrared';
const SAT_STEP = HOUR / 2;   // one image per half hour keeps downloads small
const SAT_LAG = 50 * MIN;    // newest image we trust to exist

export class Satellite {
  private sat: TimedRaster;
  private radar: TimedRaster;
  private radarFrames: { t: number; path: string }[] = [];
  private radarHost = '';
  private radarHttps = '';
  /** called once the list of radar pictures has arrived */
  onRadarReady: () => void = () => {};

  constructor(map: MLMap, beforeId?: string) {
    this.sat = new TimedRaster(map, 'sat-', beforeId, {
      // repainted as white cloud on the dark map (sat-colors.ts)
      url: (t) => `${SAT_PROTOCOL}://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${GIBS}/default/${new Date(t).toISOString().slice(0, 19)}Z/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`,
      maxzoom: 6, opacity: 1, attribution: 'NASA GIBS / JMA Himawari', keep: 6,
    });
    registerSatelliteProtocol();
    this.radar = new TimedRaster(map, 'radar-', beforeId, {
      // unsmoothed tiles keep exact palette colours, so they can be repainted (radar-colors.ts)
      url: (t) => `${this.radarHost}${this.radarFrames.find((f) => f.t === t)!.path}/256/{z}/{x}/{y}/2/0_0.png`,
      maxzoom: 7, opacity: 1, attribution: 'RainViewer', keep: 4,
    });
    registerRadarProtocol();
    fetch('https://api.rainviewer.com/public/weather-maps.json')
      .then((r) => r.json())
      .then((j) => { this.radarHttps = String(j.host); this.radarHost = String(j.host).replace(/^https?:\/\//, PROTOCOL + '://'); this.radarFrames = j.radar.past.map((f: any) => ({ t: f.time * 1000, path: f.path })); this.onRadarReady(); })
      .catch(() => { /* radar is optional */ });
  }

  /** Radar pictures as plain https tile URLs, oldest first (for the nowcast). */
  radarList() {
    return this.radarFrames.map((f) => ({ t: f.t, url: `${this.radarHttps}${f.path}/256/{z}/{x}/{y}/2/0_0.png` }));
  }

  /** Time of the newest radar picture, or null if radar isn't available. */
  latestRadar(): number | null {
    return this.radarFrames.length ? this.radarFrames[this.radarFrames.length - 1].t : null;
  }

  static latest(now = Date.now()) { return Math.floor((now - SAT_LAG) / (10 * MIN)) * (10 * MIN); }

  frameFor(t: number) { return Math.min(Satellite.latest(), Math.floor(t / SAT_STEP) * SAT_STEP); }

  /** Radar frame for time t, or null outside the last ~2 hours. */
  radarFor(t: number): number | null {
    const fr = this.radarFrames;
    if (!fr.length || t < fr[0].t - 5 * MIN) return null;
    let best = fr[0].t;
    for (const f of fr) if (f.t <= t + 5 * MIN) best = f.t;
    return best;
  }

  /** What the past view is showing right now, for the legend. */
  mode: 'radar' | 'sat' | 'sat+radar' = 'sat';

  /** radarOnly: on the rain layer, show clean radar on its own (like Windy) wherever it exists. */
  show(t: number, radarOnly = false) {
    const r = this.radarFor(t);
    if (radarOnly && r !== null) {
      this.sat.hide();
      this.radar.show(r);
      this.mode = 'radar';
      return;
    }
    this.sat.show(this.frameFor(t));
    if (r === null) { this.radar.hide(); this.mode = 'sat'; } else { this.radar.show(r); this.radar.raise(); this.mode = 'sat+radar'; }
  }

  hide() { this.sat.hide(); this.radar.hide(); }
}
