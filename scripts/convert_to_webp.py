#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
convert_to_webp.py
==================

Mirrors every PNG under `images/` into two sibling trees so the project
can compare the two formats side-by-side without touching the originals:

  images/png/   -- plain copies of every PNG (reference)
  images/webp/  -- same files re-encoded as .webp

Encoding mode per texture is picked from the file name:
  - lossless: ID, Normal, Alpha, DS, Height, Bump, Ramp, Mask, Metalness, DW
  - lossy q=90: everything else (color / diffuse / emissive / roughness / ...)

Run from the WEB root:
    python scripts/convert_to_webp.py

Re-run any time after adding / updating PNGs. Files already up-to-date
are skipped (mtime check).
"""

import os
import sys
import shutil
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("[ERROR] Pillow not installed. Run:  pip install Pillow")
    sys.exit(1)


# ---------------------------------------------------------------- config

# Whitelist for lossy — ONLY actual color/light data that tolerates JPEG
# artifacts. Everything else (masks, roughness, weights…) stays lossless.
LOSSY_KEYWORDS = [
    "_diffuse", "_basecolor", "_color", "_albedo",
    "_pattern",            # patterns are decorative color overlays
    "_femal",              # the diffuse variant "body_Femal"
    "_emit", "_emissive",
    "logogloops",          # UI
]
LOSSY_QUALITY = 95        # high quality, virtually transparent artifacts

# Folders we should NOT scan (so we don't recurse into our own output)
EXCLUDE = {"png", "webp"}


# ---------------------------------------------------------------- helpers

def find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents]:
        if (candidate / "images").is_dir():
            return candidate
    raise SystemExit("[ERROR] Could not locate the images/ folder")


def is_lossless(filename: str) -> bool:
    """Default = lossless. Only when the filename matches a whitelisted
    COLOR keyword do we switch to lossy. This is safer for masks,
    roughness maps, displacement, etc. that would break with JPEG-like
    compression artifacts."""
    n = filename.lower()
    return not any(k in n for k in LOSSY_KEYWORDS)


def scan_pngs(images_root: Path):
    for dirpath, dirnames, filenames in os.walk(images_root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE]
        for fn in filenames:
            if fn.lower().endswith(".png"):
                src = Path(dirpath) / fn
                rel = src.relative_to(images_root)
                yield src, rel


def newer(src: Path, dst: Path) -> bool:
    if not dst.exists():
        return True
    return src.stat().st_mtime > dst.stat().st_mtime + 0.5


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


# ---------------------------------------------------------------- main

def main() -> int:
    repo = find_repo_root()
    images = repo / "images"
    png_root = images / "png"
    webp_root = images / "webp"
    png_root.mkdir(exist_ok=True)
    webp_root.mkdir(exist_ok=True)

    print(f"Repo:   {repo}")
    print(f"Source: {images}")
    print(f"PNG =>   {png_root}")
    print(f"WebP =>  {webp_root}")
    print("-" * 78)

    total_src = 0
    total_png = 0
    total_webp = 0
    count = 0
    skipped = 0

    for src, rel in scan_pngs(images):
        count += 1
        lossless = is_lossless(src.name)
        mode = "lossless" if lossless else f"lossy q={LOSSY_QUALITY}"

        # 1. Mirror the PNG
        png_dst = png_root / rel
        png_dst.parent.mkdir(parents=True, exist_ok=True)
        if newer(src, png_dst):
            shutil.copy2(src, png_dst)

        # 2. Encode the WebP
        webp_dst = webp_root / rel.with_suffix(".webp")
        webp_dst.parent.mkdir(parents=True, exist_ok=True)
        encoded = False
        if newer(src, webp_dst):
            try:
                with Image.open(src) as im:
                    has_alpha = (
                        im.mode in ("RGBA", "LA")
                        or "transparency" in im.info
                    )
                    if im.mode == "P":
                        im = im.convert("RGBA" if has_alpha else "RGB")
                    if lossless:
                        # exact=True preserves pixel-perfect RGB even
                        # where alpha is 0 (important for masks).
                        im.save(webp_dst, "WEBP",
                                lossless=True, method=6, exact=True)
                    else:
                        im.save(webp_dst, "WEBP",
                                quality=LOSSY_QUALITY,
                                method=6,
                                lossless=False)
                encoded = True
            except Exception as e:
                print(f"[FAIL] {rel}: {e}")
                continue
        else:
            skipped += 1

        sz_src  = src.stat().st_size
        sz_png  = png_dst.stat().st_size if png_dst.exists() else 0
        sz_webp = webp_dst.stat().st_size if webp_dst.exists() else 0
        total_src += sz_src
        total_png += sz_png
        total_webp += sz_webp

        ratio = (1 - sz_webp / sz_src) * 100 if sz_src else 0
        flag = "+" if encoded else "."
        print(f"  {flag} {mode:11s} {human(sz_src):>9s} -> {human(sz_webp):>9s} "
              f"(-{ratio:4.0f}%)   {rel}")

    print("-" * 78)
    saved_pct = (1 - total_webp / max(1, total_src)) * 100
    print(f"Processed:  {count} PNG(s)  (skipped unchanged: {skipped})")
    print(f"Total PNG:  {human(total_png)}")
    print(f"Total WebP: {human(total_webp)}  -- saves {saved_pct:.0f}% "
          f"({human(total_src - total_webp)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
