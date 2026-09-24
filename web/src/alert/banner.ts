// The strip under the place name: "rain in ~20 min · heavy" for where you are.
import { alertText, checkSpot, type RainAlert } from './rain-alert';
import { fetchDbzTile } from '../satellite/radar-colors';
import type { Spot } from '../sheet/sheet';

const REFRESH = 5 * 60_000;
const ICON: Record<RainAlert['kind'], string> = {
  now: '<path d="M7 15.5h10a3.5 3.5 0 0 0 .3-7A5.2 5.2 0 0 0 7.2 9.8 2.9 2.9 0 0 0 7 15.5Z"/><path d="M9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5"/>',
  soon: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9.5 3h5"/>',
  later: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9.5 3h5"/>',
  none: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
};

export class RainBanner {
  private spot: Spot | null = null;
  private timer = 0;
  private busy = false;
  onTap: (s: Spot) => void = () => {};
  /** latest verdict, e.g. for the notification setup */
  last: RainAlert | null = null;

  constructor(private el: HTMLElement) {
    el.onclick = () => { if (this.spot) this.onTap(this.spot); };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refresh(); });
  }

  /** Follow this spot (null hides the strip). */
  watch(s: Spot | null) {
    const moved = !this.spot || !s || Math.abs(this.spot.lat - s.lat) > 0.005 || Math.abs(this.spot.lon - s.lon) > 0.005;
    this.spot = s;
    if (!s) { this.el.hidden = true; return; }
    if (moved) this.refresh();
  }

  async refresh() {
    const s = this.spot;
    if (!s || this.busy) return;
    this.busy = true;
    clearTimeout(this.timer);
    try {
      const a = await checkSpot(s.lat, s.lon, Date.now(), {
        json: (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }),
        tile: (u) => fetchDbzTile(u, undefined, false).then(({ z }) => (i: number) => z[i]),
      });
      if (s === this.spot) this.show(a);
    } catch {
      this.el.hidden = true; // no data (offline): say nothing rather than something wrong
    } finally {
      this.busy = false;
      this.timer = window.setTimeout(() => this.refresh(), REFRESH);
    }
  }

  private show(a: RainAlert) {
    this.last = a;
    const { title, body } = alertText(a);
    this.el.className = `rain-alert glass k-${a.kind} lv-${a.level}`;
    this.el.innerHTML = `<svg viewBox="0 0 24 24" class="ic">${ICON[a.kind]}</svg>
      <span class="ra-text"><b>${title}</b>${body ? `<small>${body}</small>` : ''}</span>`;
    this.el.hidden = false;
  }
}
