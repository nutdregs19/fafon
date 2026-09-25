"""The whole world at 25 km (ECMWF IFS open data 0.25 deg), cut into 30 x 30 degree tiles.

The phone downloads only the tiles it is looking at (roaming data abroad is expensive), so
each forecast step becomes 12 x 6 small PNGs instead of one big picture. Same pixel packing
as the regional frames (common.pack_png). Steps are processed one at a time: the whole run
held in memory at once would be ~3 GB.
"""
import datetime as dt
import os
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
import eccodes

from common import pack_png, write_atomic
from fetch_ecmwf import latest_run, steps, _fetch_step

STEP = 0.25
TILE = 120                      # px per tile side = 30 degrees
NX, NY = 12, 6                  # 360 / 30, 180 / 30
W, H = NX * TILE, NY * TILE     # 1440 x 720: lat 90 .. -89.75, lon -180 .. 179.75


def grid_info():
    return {"w": W, "h": H, "lat0": 90.0, "lon0": -180.0, "dlat": -STEP, "dlon": STEP}


def decode_global(msg_bytes):
    """One GRIB message -> (720, 1440) float32, north-up, starting at lon -180."""
    gid = eccodes.codes_new_from_message(msg_bytes)
    try:
        ni = eccodes.codes_get(gid, "Ni")
        nj = eccodes.codes_get(gid, "Nj")
        lat1 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
        lon1 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
        di = eccodes.codes_get(gid, "iDirectionIncrementInDegrees")
        dj = eccodes.codes_get(gid, "jDirectionIncrementInDegrees")
        j_pos = eccodes.codes_get(gid, "jScansPositively")
        vals = eccodes.codes_get_values(gid).reshape(nj, ni)
        missing = eccodes.codes_get(gid, "missingValue")
    finally:
        eccodes.codes_release(gid)
    vals = np.where(vals == missing, np.nan, vals).astype(np.float32)
    lats = 90.0 - STEP * np.arange(H)
    lons = -180.0 + STEP * np.arange(W)
    rows = np.rint(((lats - lat1) if j_pos else (lat1 - lats)) / dj).astype(int)
    cols = np.rint(((lons - lon1) % 360.0) / di).astype(int) % ni
    if rows.min() < 0 or rows.max() >= nj:
        raise ValueError("unexpected global grid")
    return vals[np.ix_(rows, cols)]


def tile_dir(run, step):
    return f"world/{run:%Y%m%d%H}_250_f{step:03d}"


def fetch_and_write(out, max_steps=None, log=print):
    """Download the newest run, write every step's tiles under `out`, return the manifest entry."""
    session = requests.Session()
    session.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=8))
    run, mirror = latest_run(session)
    st = steps()[: max_steps or None]
    log(f"world: ECMWF run {run:%Y-%m-%d %HZ} from {mirror}, {len(st)} steps")

    frames = []
    prev_acc, prev_step, first_rain_missing = None, 0, None
    with ThreadPoolExecutor(4) as ex:
        # downloads run ahead in threads; decoding stays in this thread (eccodes isn't thread-safe)
        for s, raw in ex.map(lambda s: _fetch_step(session, mirror, run, s), st):
            f = {k: decode_global(b) for k, b in raw.items()}
            cloud = f["c"] * 100.0 if np.nanmax(f["c"]) <= 1.01 else f["c"]
            acc = f["p"] * 1000.0
            rain = None if s == 0 else np.clip((acc - (prev_acc if prev_acc is not None else 0.0)) / (s - prev_step), 0.0, None)
            prev_acc, prev_step = acc, s
            if rain is None:
                first_rain_missing = (s, f["u"], f["v"], f["t"] - 273.15, cloud)
                continue  # step 0 has no rain rate yet; written with the next step's rain below
            if first_rain_missing is not None:
                s0, u0, v0, t0, c0 = first_rain_missing
                _write_tiles(out, run, s0, u0, v0, t0, rain, c0)
                frames.append({"t": run + dt.timedelta(hours=s0), "f": tile_dir(run, s0)})
                first_rain_missing = None
            _write_tiles(out, run, s, f["u"], f["v"], f["t"] - 273.15, rain, cloud)
            frames.append({"t": run + dt.timedelta(hours=s), "f": tile_dir(run, s)})
            if len(frames) % 10 == 0:
                log(f"world: {len(frames)}/{len(st)} steps written")
    if first_rain_missing is not None:  # a one-step run (testing)
        s0, u0, v0, t0, c0 = first_rain_missing
        _write_tiles(out, run, s0, u0, v0, t0, np.zeros_like(u0), c0)
        frames.append({"t": run + dt.timedelta(hours=s0), "f": tile_dir(run, s0)})
    return run, frames


def _write_tiles(out, run, step, u, v, t, rain, cloud):
    base = os.path.join(out, tile_dir(run, step))
    for y in range(NY):
        for x in range(NX):
            sl = np.s_[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE]
            write_atomic(os.path.join(base, f"{x}_{y}.png"), pack_png(u[sl], v[sl], t[sl], rain[sl], cloud[sl]))


def check(out, frames):
    """Every tile of every step must exist before the manifest points at it."""
    for fr in frames:
        for y in range(NY):
            for x in range(NX):
                p = os.path.join(out, fr["f"], f"{x}_{y}.png")
                assert os.path.exists(p), p
