// Windy-style time strip: a fixed needle in the middle, and a wide strip of days and
// hours that you swipe underneath it. Left of "now" is real satellite/radar (past),
// right of it is the forecast. Swipe, flick (it keeps gliding), tap a spot, or press play.
import { HOUR, dayTick, fullLabel } from '../util/time';

const MIN = 60_000;

export class Timeline {
  private wrap: HTMLDivElement;
  private strip: HTMLDivElement;
  private bubble: HTMLDivElement;
  private playBtn: HTMLButtonElement;
  private playing = false;
  private raf = 0;
  private glideRaf = 0;
  private lastTs = 0;
  private pxPerMs = 8 / HOUR;
  t: number;
  onChange: (t: number) => void = () => {};
  tag: (t: number) => string = () => '';

  constructor(private el: HTMLElement, private start: number, private now: number, private end: number) {
    this.t = now;
    el.innerHTML = `
      <button class="play" aria-label="เล่น">${ICON_PLAY}</button>
      <div class="tl-body">
        <div class="strip-wrap"><div class="strip"></div></div>
        <div class="needle"></div>
        <div class="bubble"></div>
      </div>`;
    this.wrap = el.querySelector('.strip-wrap')!;
    this.strip = el.querySelector('.strip')!;
    this.bubble = el.querySelector('.bubble')!;
    this.playBtn = el.querySelector('.play')!;
    this.playBtn.onclick = () => (this.playing ? this.pause() : this.play());
    this.bindGestures();
    new ResizeObserver(() => this.setRange(this.start, this.now, this.end)).observe(this.wrap);
    this.setRange(start, now, end);
  }

  setRange(start: number, now: number, end: number) {
    this.start = start; this.now = now; this.end = end;
    // roomier on wide screens; about a day and a half across a phone
    const w = this.wrap.clientWidth || 300;
    this.pxPerMs = Math.min(16, Math.max(7, w / 36)) / HOUR;
    const pxh = this.pxPerMs * HOUR;
    const x = (t: number) => ((t - start) * this.pxPerMs).toFixed(1);
    const parts: string[] = [
      `<div class="pastzone" style="left:0;width:${x(now)}px"></div>`,
      `<div class="nowline" style="left:${x(now)}px"><span>ตอนนี้</span></div>`,
    ];
    const first = new Date(start); first.setMinutes(0, 0, 0);
    for (let h = first.getTime() + HOUR; h <= end; h += HOUR) {
      const hr = new Date(h).getHours();
      if (hr === 0) {
        parts.push(`<i class="tk tk-day" style="left:${x(h)}px"></i><b class="day-lb" style="left:${x(h)}px">${dayTick(h)}</b>`);
      } else if (hr % 6 === 0) {
        parts.push(`<i class="tk tk-mid" style="left:${x(h)}px"></i><span class="hr-lb" style="left:${x(h)}px">${String(hr).padStart(2, '0')}</span>`);
      } else if (hr % 3 === 0 || pxh >= 12) {
        parts.push(`<i class="tk" style="left:${x(h)}px"></i>`);
      }
    }
    this.strip.innerHTML = parts.join('');
    this.strip.style.width = x(end) + 'px';
    this.set(Math.min(Math.max(this.t, start), end), false);
  }

  set(t: number, notify = true) {
    this.t = Math.min(Math.max(t, this.start), this.end);
    const offset = this.wrap.clientWidth / 2 - (this.t - this.start) * this.pxPerMs;
    this.strip.style.transform = `translateX(${offset.toFixed(1)}px)`;
    const shown = Math.round(this.t / (5 * MIN)) * 5 * MIN; // label to the nearest 5 minutes
    this.bubble.innerHTML = `<b>${fullLabel(shown)}</b><small>${this.tag(this.t)}</small>`;
    this.el.classList.toggle('in-past', this.t < this.now);
    if (notify) this.onChange(this.t);
  }

  /** Smoothly move to time t (tap-to-seek). */
  private glideTo(target: number) {
    cancelAnimationFrame(this.glideRaf);
    const from = this.t, t0 = performance.now(), dur = 350;
    const step = (ts: number) => {
      const k = Math.min(1, (ts - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      this.set(from + (target - from) * e);
      if (k < 1) this.glideRaf = requestAnimationFrame(step);
    };
    this.glideRaf = requestAnimationFrame(step);
  }

  private bindGestures() {
    let startX = 0, startT = 0, moved = 0, lastX = 0, lastTime = 0, vel = 0, dragging = false;
    this.wrap.addEventListener('pointerdown', (e) => {
      this.pause();
      cancelAnimationFrame(this.glideRaf);
      this.wrap.setPointerCapture(e.pointerId);
      this.el.classList.add('dragging');
      dragging = true;
      startX = lastX = e.clientX; startT = this.t; moved = 0; vel = 0; lastTime = performance.now();
    });
    this.wrap.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const now = performance.now(), dx = e.clientX - lastX, dt = Math.max(1, now - lastTime);
      vel = 0.7 * vel + 0.3 * (dx / dt); // px per ms, smoothed
      lastX = e.clientX; lastTime = now;
      moved = Math.max(moved, Math.abs(e.clientX - startX));
      this.set(startT - (e.clientX - startX) / this.pxPerMs);
    });
    const up = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      this.el.classList.remove('dragging');
      if (moved < 6) {
        // a tap: glide to the tapped spot
        const r = this.wrap.getBoundingClientRect();
        this.glideTo(this.t + (e.clientX - (r.left + r.width / 2)) / this.pxPerMs);
        return;
      }
      if (performance.now() - lastTime > 80) vel = 0; // finger stopped before lifting
      // flick: keep gliding and slow down
      let prev = performance.now();
      const glide = (ts: number) => {
        const dt = ts - prev; prev = ts;
        vel *= Math.pow(0.93, dt / 16);
        if (Math.abs(vel) < 0.02) return;
        this.set(this.t - (vel * dt) / this.pxPerMs);
        this.glideRaf = requestAnimationFrame(glide);
      };
      this.glideRaf = requestAnimationFrame(glide);
    };
    this.wrap.addEventListener('pointerup', up);
    this.wrap.addEventListener('pointercancel', up);
    // desktop: mouse wheel / trackpad scrolls through time
    this.wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.pause();
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.set(this.t + d / this.pxPerMs);
    }, { passive: false });
  }

  play() {
    if (this.t >= this.end - HOUR) this.set(this.now);
    cancelAnimationFrame(this.glideRaf);
    this.playing = true;
    this.playBtn.innerHTML = ICON_PAUSE;
    this.playBtn.setAttribute('aria-label', 'หยุด');
    this.lastTs = performance.now();
    const tick = (ts: number) => {
      if (!this.playing) return;
      const dt = ts - this.lastTs; this.lastTs = ts;
      // forecast: one hour every 0.3 s; past (radar/satellite): ten minutes every 0.25 s
      const rate = this.t < this.now ? (10 * MIN) / 250 : HOUR / 300;
      const t = this.t + dt * rate;
      if (t >= this.end) { this.set(this.end); this.pause(); return; }
      this.set(t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.playBtn.innerHTML = ICON_PLAY;
    this.playBtn.setAttribute('aria-label', 'เล่น');
  }
}

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>';
