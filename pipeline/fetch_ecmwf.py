"""ECMWF IFS open data (0.25 deg, CC-BY-4.0), read field-by-field via .index byte ranges.

Mirrors are tried in order; each one serves the same files.
"""
import datetime as dt
import json
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests

from common import decode_crop, http_get

MIRRORS = [
    "https://storage.googleapis.com/ecmwf-open-data",
    "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com",
    "https://data.ecmwf.int/forecasts",
]
KEYS = {"10u": "u", "10v": "v", "2t": "t", "tcc": "c", "tp": "p"}
MAX_STEP = 240


def steps():
    return list(range(0, 145, 3)) + list(range(150, MAX_STEP + 1, 6))


def _base(mirror, run, step):
    return f"{mirror}/{run:%Y%m%d}/{run:%H}z/ifs/0p25/oper/{run:%Y%m%d%H}0000-{step}h-oper-fc"


def latest_run(session):
    """Newest 00z/12z run whose 240 h file is published (06z/18z stop at 144 h)."""
    now = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    run = now.replace(hour=12 if now.hour >= 12 else 0)
    for _ in range(6):
        for mirror in MIRRORS:
            try:
                r = session.head(_base(mirror, run, MAX_STEP) + ".index", timeout=30)
            except requests.RequestException:
                continue
            if r.status_code == 200:
                return run, mirror
        run -= dt.timedelta(hours=12)
    raise RuntimeError("no complete ECMWF run found in the last 3 days")


def _fetch_step(session, mirror, run, step):
    base = _base(mirror, run, step)
    idx = http_get(session, base + ".index").text
    want = {}
    for line in idx.splitlines():
        rec = json.loads(line)
        if rec.get("param") in KEYS and rec.get("levtype") == "sfc":
            want[KEYS[rec["param"]]] = (rec["_offset"], rec["_offset"] + rec["_length"] - 1)
    missing = set(KEYS.values()) - want.keys()
    if missing:
        raise RuntimeError(f"ECMWF {step}h missing {missing}")
    out = {}
    for key, (a, b) in want.items():
        out[key] = http_get(session, base + ".grib2", rng=(a, b)).content
    return step, out


def fetch(max_steps=None, log=print):
    session = requests.Session()
    session.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=8))
    run, mirror = latest_run(session)
    st = steps()[: max_steps or None]
    log(f"ECMWF run {run:%Y-%m-%d %HZ} from {mirror}, {len(st)} steps")
    with ThreadPoolExecutor(4) as ex:
        raw = dict(ex.map(lambda s: _fetch_step(session, mirror, run, s), st))
    # eccodes is not thread-safe: decode in this thread only
    fields = {s: {k: decode_crop(b) for k, b in raw[s].items()} for s in st}

    frames = []
    prev_acc, prev_step = None, 0
    for s in st:
        f = fields[s]
        cloud = f["c"] * 100.0 if np.nanmax(f["c"]) <= 1.01 else f["c"]
        acc_mm = f["p"] * 1000.0
        if s == 0:
            rain = None
        else:
            rain = np.clip((acc_mm - (prev_acc if prev_acc is not None else 0.0)) / (s - prev_step), 0.0, None)
        prev_acc, prev_step = acc_mm, s
        frames.append([run + dt.timedelta(hours=s), f["u"], f["v"], f["t"] - 273.15, rain, cloud])
    if len(frames) > 1:
        frames[0][4] = frames[1][4]
    elif frames:
        frames[0][4] = np.zeros_like(frames[0][1])
    return run, frames
