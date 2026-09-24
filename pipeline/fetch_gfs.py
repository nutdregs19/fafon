"""NOAA GFS 0.25 from the AWS open-data bucket, read field-by-field via .idx byte ranges."""
import datetime as dt
import re
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests

from common import decode_crop, http_get

BUCKET = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
MAX_STEP = 240


def steps():
    return list(range(0, 121)) + list(range(123, MAX_STEP + 1, 3))


def _url(run, step):
    return f"{BUCKET}/gfs.{run:%Y%m%d}/{run:%H}/atmos/gfs.t{run:%H}z.pgrb2.0p25.f{step:03d}"


def latest_run(session):
    now = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    run = now.replace(hour=now.hour - now.hour % 6)
    for _ in range(8):
        try:
            r = session.head(_url(run, MAX_STEP) + ".idx", timeout=30)
        except requests.RequestException:
            run -= dt.timedelta(hours=6)
            continue
        if r.status_code == 200:
            return run
        run -= dt.timedelta(hours=6)
    raise RuntimeError("no complete GFS run found in the last 48 h")


def _hours(num, unit):
    return int(num) * (24 if unit == "day" else 1)


def _pick(idx_text, step):
    """Return {name: (start, end_or_None)} byte ranges for the fields we need."""
    lines = [l.split(":") for l in idx_text.strip().splitlines()]
    want = {}
    inst = "anl" if step == 0 else f"{step} hour fcst"
    for i, p in enumerate(lines):
        var, level, when = p[3], p[4], p[5]
        start = int(p[1])
        end = int(lines[i + 1][1]) - 1 if i + 1 < len(lines) else None
        key = None
        if when == inst:
            if var == "UGRD" and level == "10 m above ground":
                key = "u"
            elif var == "VGRD" and level == "10 m above ground":
                key = "v"
            elif var == "TMP" and level == "2 m above ground":
                key = "t"
            elif var == "TCDC" and level == "entire atmosphere":
                key = "c"
        elif var == "APCP" and level == "surface":
            m = re.match(r"0-(\d+) (hour|day) acc fcst", when)
            if m and _hours(*m.groups()) == step:
                key = "p"
        if key and key not in want:
            want[key] = (start, end)
    need = {"u", "v", "t", "c"} | ({"p"} if step else set())
    missing = need - want.keys()
    if missing:
        raise RuntimeError(f"GFS f{step:03d} missing fields {missing}")
    return want


def _fetch_step(session, run, step):
    base = _url(run, step)
    idx = http_get(session, base + ".idx")
    out = {}
    for key, rng in _pick(idx.text, step).items():
        out[key] = http_get(session, base, rng=rng).content
    return step, out


def fetch(max_steps=None, log=print):
    """Yield (valid_time, u, v, t_c, rain_mmh, cloud_pct) for each step."""
    session = requests.Session()
    session.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=16))
    run = latest_run(session)
    st = steps()[: max_steps or None]
    log(f"GFS run {run:%Y-%m-%d %HZ}, {len(st)} steps")
    with ThreadPoolExecutor(8) as ex:
        raw = dict(ex.map(lambda s: _fetch_step(session, run, s), st))
    # eccodes is not thread-safe: decode in this thread only
    fields = {s: {k: decode_crop(b) for k, b in raw[s].items()} for s in st}
    frames = []
    prev_acc, prev_step = None, 0
    for s in st:
        f = fields[s]
        if s == 0:
            rain = None
        else:
            acc = f["p"]
            rain = (acc - (prev_acc if prev_acc is not None else 0.0)) / (s - prev_step)
            rain = np.clip(rain, 0.0, None)
            prev_acc, prev_step = acc, s
        frames.append([run + dt.timedelta(hours=s), f["u"], f["v"], f["t"] - 273.15, rain, f["c"]])
    if len(frames) > 1:
        frames[0][4] = frames[1][4]   # analysis has no rain: borrow the first hour
    elif frames:
        frames[0][4] = np.zeros_like(frames[0][1])
    return run, frames
