// Windy-style flowing wind lines, drawn on a 2D canvas laid over the map.
import type { Map as MLMap } from 'maplibre-gl';
import { sample, type Field } from '../data/store';

const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unmerc = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;
const MAX_AGE = 90;

export class Particles {
  private ctx: CanvasRenderingContext2D;
  private xs = new Float32Array(0);
  private ys = new Float32Array(0);
  private age = new Uint16Array(0);
  private field: Field | null = null;
  private alpha = 0.78;
  private running = false;
  private moving = false;
  private raf = 0;
  private dpr = 1;
  // screen <-> lon/lat, refreshed after every map move
  private lonW = 0; private lonE = 0; private yTop = 0; private yBot = 0;

  constructor(private map: MLMap, private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    map.on('movestart', () => { this.moving = true; this.clear(); });
    map.on('moveend', () => { this.moving = false; this.resize(); });
    map.on('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => (document.hidden ? this.stop() : this.start()));
    this.resize();
  }

  setField(f: Field | null) { this.field = f; }

  /** Line strength: faint over rain so the rain stays readable, strong on the wind layer. */
  setAlpha(a: number) {
    if (a !== this.alpha) { this.alpha = a; this.clear(); }
  }

  start() {
    if (this.running || document.hidden) return;
    this.running = true;
    const tick = () => { if (!this.running) return; this.step(); this.raf = requestAnimationFrame(tick); };
    this.raf = requestAnimationFrame(tick);
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); this.clear(); }

  private clear() { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }

  private resize() {
    const box = this.map.getContainer();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = box.clientWidth * this.dpr;
    this.canvas.height = box.clientHeight * this.dpr;
    const b = this.map.getBounds();
    this.lonW = b.getWest(); this.lonE = b.getEast();
    this.yTop = merc(b.getNorth()); this.yBot = merc(b.getSouth());
    const count = Math.min(3500, Math.round((box.clientWidth * box.clientHeight) / 170));
    this.xs = new Float32Array(count); this.ys = new Float32Array(count); this.age = new Uint16Array(count);
    for (let i = 0; i < count; i++) this.respawn(i, true);
  }

  private respawn(i: number, randomAge: boolean) {
    this.xs[i] = Math.random() * this.canvas.width;
    this.ys[i] = Math.random() * this.canvas.height;
    this.age[i] = randomAge ? (Math.random() * MAX_AGE) | 0 : 0;
  }

  private step() {
    const f = this.field, ctx = this.ctx, cw = this.canvas.width, ch = this.canvas.height;
    if (!f || this.moving || this.alpha <= 0) { if (this.alpha <= 0) this.clear(); return; }
    // fade the old trails
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.93)';
    ctx.fillRect(0, 0, cw, ch);
    ctx.globalCompositeOperation = 'source-over';

    const kx = (this.lonE - this.lonW) / cw, ky = (this.yBot - this.yTop) / ch;
    const speed = 0.16 * this.dpr * Math.max(0.7, Math.min(1.6, this.map.getZoom() / 5));
    ctx.beginPath();
    for (let i = 0; i < this.xs.length; i++) {
      const x = this.xs[i], y = this.ys[i];
      if (++this.age[i] > MAX_AGE) { this.respawn(i, false); continue; }
      const lon = this.lonW + x * kx, lat = unmerc(this.yTop + y * ky);
      const u = sample(f.g, f.u, lon, lat), v = sample(f.g, f.v, lon, lat);
      if (Number.isNaN(u)) { this.respawn(i, false); continue; }
      const nx = x + u * speed, ny = y - v * speed;
      if (nx < 0 || ny < 0 || nx > cw || ny > ch) { this.respawn(i, false); continue; }
      ctx.moveTo(x, y); ctx.lineTo(nx, ny);
      this.xs[i] = nx; this.ys[i] = ny;
    }
    ctx.strokeStyle = `rgba(255,255,255,${this.alpha})`;
    ctx.lineWidth = 1.1 * this.dpr;
    ctx.stroke();
  }
}
