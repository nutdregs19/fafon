"""Fetch every source, write PNG frames + manifest.json.

usage: python render.py [--out DIR] [--max-steps N] [--only ecmwf]
"""
import argparse
import datetime as dt
import json
import os
import sys
import traceback

from common import ENC, grid_info, pack_png, write_atomic
import fetch_ecmwf
import fetch_ecmwf9

# Each source lists fetchers in order of preference; the first that works wins.
# ECMWF: native 9 km (Open-Meteo archive), falling back to ECMWF's own 25 km open data.
# (GFS was dropped 24 Sep 2026 — the owner keeps only the European model; fetch_gfs.py stays for reference.)
SOURCES = {
    "ecmwf": {"label": "ยุโรป", "credit": "ECMWF", "mods": [fetch_ecmwf9, fetch_ecmwf]},
}


def run_source(src, max_steps):
    for mod in src["mods"]:
        try:
            res = mod.fetch(max_steps=max_steps)
            return res if len(res) == 3 else (*res, grid_info())
        except Exception:
            traceback.print_exc()
            print(f"!! {mod.__name__} failed", file=sys.stderr)
    raise RuntimeError("all fetchers failed")


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%MZ")


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--out", default=os.path.join(here, "..", "web", "public", "data"))
    ap.add_argument("--max-steps", type=int, default=None)
    ap.add_argument("--only", choices=list(SOURCES))
    a = ap.parse_args()
    out = os.path.abspath(a.out)

    manifest = {"generated": iso(dt.datetime.now(dt.timezone.utc)), "grid": grid_info(),
                "enc": ENC, "sources": {}}
    for key, src in SOURCES.items():
        if a.only and key != a.only:
            continue
        try:
            run, frames, grid = run_source(src, a.max_steps)
        except Exception:
            traceback.print_exc()
            print(f"!! {key} failed, skipping", file=sys.stderr)
            continue
        items = []
        for t, u, v, tc, rain, cloud in frames:
            step = int((t - run).total_seconds() // 3600)
            # grid spacing in the name: a cached 25 km file must never be read as a 9 km one
            rel = f"{key}/{run:%Y%m%d%H}_{round(-grid['dlat'] * 1000):03d}_f{step:03d}.png"
            write_atomic(os.path.join(out, rel), pack_png(u, v, tc, rain, cloud))
            items.append({"t": iso(t), "f": rel})
        manifest["sources"][key] = {"label": src["label"], "credit": src["credit"],
                                    "run": iso(run), "grid": grid, "frames": items}
        print(f"{key}: {len(items)} frames")

    if not manifest["sources"]:
        sys.exit("no source succeeded")
    # check: every referenced file exists before publishing the manifest
    for s in manifest["sources"].values():
        for fr in s["frames"]:
            assert os.path.exists(os.path.join(out, fr["f"])), fr["f"]
    write_atomic(os.path.join(out, "manifest.json"),
                 json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    print("manifest written:", os.path.join(out, "manifest.json"))


if __name__ == "__main__":
    main()
