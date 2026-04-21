#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build_props_manifest.py
=======================

Scans `fbx/ANIM/<Category>/PROPS/*.fbx` for animation-paired props and
updates `fbx/manifest.json` with a `pairedProps` section.

Pairing rule: a prop file `ANIM/Horns/PROPS/Hat_CowBoy.fbx` is paired
with the animation file `ANIM/Horns/Hat_CowBoy.fbx` (same name, sibling
category folder). When the player switches to that animation in the
customizer, the paired prop is auto-loaded and attached.

Run after adding/removing FBX files in any PROPS subfolder:
    python scripts/build_props_manifest.py

The script is idempotent and only touches the `pairedProps` key.
"""

import json
import os
import sys
from pathlib import Path


def find_repo_root() -> Path:
    """Walk up from this file to find the WEB folder containing
    either glb/manifest.json or fbx/manifest.json."""
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents]:
        if (candidate / "glb" / "manifest.json").exists():
            return candidate
        if (candidate / "fbx" / "manifest.json").exists():
            return candidate
    raise SystemExit("[ERROR] Could not locate glb/manifest.json or fbx/manifest.json — run build_manifest.py first")


def pick_asset_dir(repo: Path) -> Path:
    """Prefer glb/ over fbx/ when both exist."""
    glb = repo / "glb"
    if (glb / "manifest.json").exists():
        return glb
    return repo / "fbx"


def scan_paired_props(asset_root: Path, ext: str) -> dict:
    """Scan `<root>/ANIM/<Category>/PROPS/*<ext>` for paired props."""
    paired = {}
    anim_root = asset_root / "ANIM"
    if not anim_root.exists():
        print(f"[WARN] {anim_root} does not exist")
        return paired

    for category_dir in sorted(anim_root.iterdir()):
        if not category_dir.is_dir():
            continue
        props_dir = category_dir / "PROPS"
        if not props_dir.exists() or not props_dir.is_dir():
            continue

        category = category_dir.name
        for asset in sorted(props_dir.glob(f"*{ext}")):
            name = asset.name
            anim_file = category_dir / name
            if not anim_file.exists():
                print(f"[skip] {category}/PROPS/{name} has no matching anim {category}/{name}")
                continue
            key = f"{category}/{name}"
            rel = f"ANIM/{category}/PROPS/{name}"
            paired[key] = rel
            print(f"[pair] {key}  ->  {rel}")
    return paired


def main() -> int:
    repo = find_repo_root()
    asset_root = pick_asset_dir(repo)
    ext = ".glb" if asset_root.name == "glb" else ".fbx"
    manifest_path = asset_root / "manifest.json"

    print(f"Repo root:    {repo}")
    print(f"Asset root:   {asset_root}  (ext={ext})")
    print(f"Manifest:     {manifest_path}")
    print(f"Scanning:     {asset_root / 'ANIM' / f'*/PROPS/*{ext}'}")
    print("-" * 60)

    paired = scan_paired_props(asset_root, ext)

    print("-" * 60)
    print(f"Found {len(paired)} paired prop(s).")

    with manifest_path.open("r", encoding="utf-8") as f:
        manifest = json.load(f)

    manifest["pairedProps"] = paired

    with manifest_path.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=4, ensure_ascii=False)
        f.write("\n")

    print(f"[OK] Updated {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
