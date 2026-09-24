"""Shared grid, GRIB decoding and PNG packing for the forecast pipeline.

Every forecast frame becomes one small RGB PNG (W x 2H):
  top half    R = wind u, G = wind v, B = 2 m temperature
  bottom half R = rain rate (sqrt curve), G = total cloud, B = 0
The web app decodes the pixels back to numbers, so the ranges below
must match web/src/data/encoding.ts.
"""
import io
import os
import time

import numpy as np
from PIL import Image
import eccodes

# Thailand + neighbours, 0.25 degree grid, north-up
LAT_N, LAT_S = 30.0, -5.0
LON_W, LON_E = 88.0, 122.0
STEP = 0.25
W = int(round((LON_E - LON_W) / STEP)) + 1   # 137
H = int(round((LAT_N - LAT_S) / STEP)) + 1   # 141

ENC = {
    "u": [-40.0, 40.0],       # m/s
    "v": [-40.0, 40.0],       # m/s
    "t": [-30.0, 50.0],       # deg C
    "p": {"max": 100.0, "curve": "sqrt"},  # mm/h
    "c": [0.0, 100.0],        # %
}


def grid_info():
    return {"w": W, "h": H, "lat0": LAT_N, "lon0": LON_W, "dlat": -STEP, "dlon": STEP}


def decode_crop(msg_bytes):
    """Decode one GRIB message and crop it to the region grid (H, W)."""
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
    vals = np.where(vals == missing, np.nan, vals)
    lats = LAT_N - STEP * np.arange(H)
    lons = LON_W + STEP * np.arange(W)
    if j_pos:
        rows = np.rint((lats - lat1) / dj).astype(int)
    else:
        rows = np.rint((lat1 - lats) / dj).astype(int)
    cols = np.rint(((lons - lon1) % 360.0) / di).astype(int) % ni
    if rows.min() < 0 or rows.max() >= nj:
        raise ValueError("region outside GRIB grid")
    return vals[np.ix_(rows, cols)]


def _lin(x, lo, hi):
    return np.clip((np.nan_to_num(x, nan=lo) - lo) / (hi - lo), 0.0, 1.0) * 255.0


def pack_png(u, v, t_c, rain_mmh, cloud_pct):
    top = np.stack([_lin(u, *ENC["u"]), _lin(v, *ENC["v"]), _lin(t_c, *ENC["t"])], axis=-1)
    p = np.sqrt(np.clip(np.nan_to_num(rain_mmh), 0.0, ENC["p"]["max"]) / ENC["p"]["max"]) * 255.0
    bottom = np.stack([p, _lin(cloud_pct, *ENC["c"]), np.zeros_like(p)], axis=-1)
    img = np.rint(np.concatenate([top, bottom], axis=0)).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(img, "RGB").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def http_get(session, url, rng=None, tries=6):
    """GET with byte range, backing off on throttling (429/503/SlowDown)."""
    headers = {"Range": f"bytes={rng[0]}-{rng[1]}" if rng[1] is not None else f"bytes={rng[0]}-"} if rng else {}
    wait = 5
    for attempt in range(tries):
        try:
            r = session.get(url, headers=headers, timeout=120)
            if r.status_code in (429, 500, 502, 503, 504):
                raise IOError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(wait)
            wait = min(wait * 2, 60)


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
