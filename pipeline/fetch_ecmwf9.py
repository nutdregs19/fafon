"""ECMWF IFS HRES at native 9 km, from Open-Meteo's open data on AWS (CC-BY-4.0).

Files: s3://openmeteo/data_run/ecmwf_ifs/<YYYY/MM/DD>/<HHMM>Z/<variable>.om
Each variable is one array (1, 6_599_680 points, T times) on ECMWF's reduced Gaussian
O1280 grid, chunked 7 points x all times. Points run north -> south, ring by ring, each
ring starting at longitude 0. Our region is one contiguous latitude band of the file, so
we fetch it in large byte blocks (a few dozen requests) instead of thousands of tiny ones,
then resample the rings onto a regular 0.1 degree grid.
"""
import datetime as dt
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
import omfiles

from common import LAT_N, LAT_S, LON_W, LON_E

BASE = "https://openmeteo.s3.us-west-2.amazonaws.com/data_run/ecmwf_ifs"
VARS = {"u": "wind_u_component_10m", "v": "wind_v_component_10m", "t": "temperature_2m",
        "c": "cloud_cover", "p": "precipitation"}
MAX_HOURS = 240
STEP = 0.1  # output grid, degrees
BLOCK = 8 << 20

# ---- O1280 reduced Gaussian geometry ----
N = 1280
NLON = np.array([4 * i + 16 for i in range(1, N + 1)] + [4 * i + 16 for i in range(N, 0, -1)])
START = np.concatenate([[0], np.cumsum(NLON)[:-1]])
RING_LAT = np.degrees(np.arcsin(-np.polynomial.legendre.leggauss(2 * N)[0]))  # north -> south


def grid_info():
    w = int(round((LON_E - LON_W) / STEP)) + 1
    h = int(round((LAT_N - LAT_S) / STEP)) + 1
    return {"w": w, "h": h, "lat0": LAT_N, "lon0": LON_W, "dlat": -STEP, "dlon": STEP}


class BlockReader:
    """Minimal fsspec-like object for omfiles: serves byte ranges from big cached blocks."""

    def __init__(self, url, session):
        self.url, self.s = url, session
        r = session.head(url, timeout=60)
        r.raise_for_status()
        self._size = int(r.headers["Content-Length"])
        self.blocks, self.lock = {}, threading.Lock()
        self.pool = ThreadPoolExecutor(4)
        self.inflight = {}

    def size(self, path=None):
        return self._size

    def _fetch(self, b):
        a, z = b * BLOCK, min(self._size, (b + 1) * BLOCK) - 1
        for attempt in range(6):
            try:
                r = self.s.get(self.url, headers={"Range": f"bytes={a}-{z}"}, timeout=300)
                r.raise_for_status()
                return r.content
            except Exception:
                if attempt == 5:
                    raise

    def _block(self, b):
        with self.lock:
            if b in self.blocks:
                return self.blocks[b]
            fut = self.inflight.get(b)
            if fut is None:
                fut = self.inflight[b] = self.pool.submit(self._fetch, b)
            # read-ahead: the band is read front to back
            for nb in (b + 1, b + 2, b + 3):
                if nb * BLOCK < self._size and nb not in self.blocks and nb not in self.inflight:
                    self.inflight[nb] = self.pool.submit(self._fetch, nb)
        data = fut.result()
        with self.lock:
            self.blocks[b] = data
            self.inflight.pop(b, None)
        return data

    def cat_file(self, path, start=None, end=None):
        start = 0 if start is None else start
        end = self._size if end is None else end
        out, pos = [], start
        while pos < end:
            b = pos // BLOCK
            blk = self._block(b)
            off = pos - b * BLOCK
            take = min(end - pos, len(blk) - off)
            out.append(blk[off:off + take])
            pos += take
        return b"".join(out)

    def close(self):
        self.pool.shutdown(wait=False)
        self.blocks.clear()


def _band_rings():
    return np.where((RING_LAT <= LAT_N + 0.2) & (RING_LAT >= LAT_S - 0.2))[0]


def _segments(rings):
    """Per ring: first/last point index covering our longitudes (+1 point margin each side)."""
    segs = []
    for i in rings:
        n = NLON[i]
        a = int(np.floor(LON_W / 360 * n)) - 1
        b = int(np.ceil(LON_E / 360 * n)) + 2
        segs.append((i, a, b))
    return segs


def _weights(segs, g):
    """Bilinear weights from ring segments to the regular output grid."""
    lats = g["lat0"] + g["dlat"] * np.arange(g["h"])
    lons = g["lon0"] + g["dlon"] * np.arange(g["w"])
    ring_lat = np.array([RING_LAT[i] for i, _, _ in segs])
    offs = np.concatenate([[0], np.cumsum([b - a for _, a, b in segs])[:-1]])
    idx = np.zeros((4, g["h"], g["w"]), dtype=np.int64)
    wt = np.zeros((4, g["h"], g["w"]), dtype=np.float32)
    for r, la in enumerate(lats):
        j = np.searchsorted(-ring_lat, -la)  # first ring at or south of la
        j = int(np.clip(j, 1, len(segs) - 1))
        north, south = j - 1, j
        fy = (ring_lat[north] - la) / (ring_lat[north] - ring_lat[south])
        for k, (ri, wy) in enumerate(((north, 1 - fy), (south, fy))):
            i, a, _ = segs[ri]
            n = NLON[i]
            x = lons / 360 * n - a          # fractional index inside the segment
            x0 = np.floor(x).astype(int)
            fx = x - x0
            idx[2 * k, r] = offs[ri] + x0
            idx[2 * k + 1, r] = offs[ri] + x0 + 1
            wt[2 * k, r] = wy * (1 - fx)
            wt[2 * k + 1, r] = wy * fx
    return idx.reshape(4, -1), wt.reshape(4, -1)


def latest_run(session):
    now = dt.datetime.now(dt.timezone.utc)
    run = now.replace(hour=12 if now.hour >= 12 else 0, minute=0, second=0, microsecond=0)
    for _ in range(8):
        url = f"{BASE}/{run:%Y/%m/%d/%H%M}Z/meta.json"
        try:
            r = session.get(url, timeout=30)
            if r.ok:
                meta = r.json()
                times = [dt.datetime.strptime(t, "%Y-%m-%dT%H:%MZ").replace(tzinfo=dt.timezone.utc) for t in meta["valid_times"]]
                if times and times[-1] - run >= dt.timedelta(hours=MAX_HOURS) and set(VARS.values()) <= set(meta["variables"]):
                    return run, times
        except requests.RequestException:
            pass
        run -= dt.timedelta(hours=12)
    raise RuntimeError("no complete 9 km ECMWF run in the last 4 days")


def fetch(max_steps=None, log=print):
    session = requests.Session()
    session.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=16))
    run, times = latest_run(session)
    keep = [k for k, t in enumerate(times) if t - run <= dt.timedelta(hours=MAX_HOURS)][: max_steps or None]
    g = grid_info()
    segs = _segments(_band_rings())
    idx, wt = _weights(segs, g)
    log(f"ECMWF 9km run {run:%Y-%m-%d %HZ}, {len(keep)} steps, grid {g['w']}x{g['h']}")

    fields = {}
    for key, name in VARS.items():
        reader = BlockReader(f"{BASE}/{run:%Y/%m/%d/%H%M}Z/{name}.om", session)
        om = omfiles.OmFileReader.from_fsspec(reader, name)
        # the file can briefly hold fewer steps than meta.json lists while a run is being appended
        nt = min(om.shape[2], len(times))
        if keep[-1] >= nt:
            raise RuntimeError(f"{name}: only {nt} of {len(times)} steps written yet")
        t0 = dt.datetime.now()
        band = np.concatenate([om.read_array((0, slice(int(START[i] + a), int(START[i] + b)), slice(0, nt)))
                               for i, a, b in segs])[:, keep].astype(np.float32)  # (points, steps)
        reader.close()
        # resample every step at once: (4 taps, grid) x (points, steps)
        out = sum(wt[k][:, None] * band[idx[k]] for k in range(4))
        fields[key] = out.T.reshape(len(keep), g["h"], g["w"])
        log(f"  {name}: {(dt.datetime.now() - t0).seconds}s")

    frames = []
    for n, k in enumerate(keep):
        t = times[k]
        # In these files precipitation at step k is the total for the interval AFTER it
        # (k -> k+1); checked against Open-Meteo's single-run API for the same run.
        # Our frames show the rate over the interval BEFORE t, like the other sources.
        if n:
            hours = (t - times[keep[n - 1]]).total_seconds() / 3600
            rain = np.clip(fields["p"][n - 1] / hours, 0, None)
        else:
            rain = None
        frames.append([t, fields["u"][n], fields["v"][n], fields["t"][n], rain, fields["c"][n]])
    if len(frames) > 1:
        frames[0][4] = frames[1][4]
    elif frames:
        frames[0][4] = np.zeros_like(frames[0][1])
    return run, frames, g
