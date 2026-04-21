"""
Scan sound/mp3/ and generate sound/music.json — the list of music
tracks surfaced in the Music Options menu.

Exclusion rules:
  - Files matching `\\d{2}_*.mp3` (e.g. `01_peace.mp3`) are emotion SFX
    voices used by the animation system — not music, so skipped.
  - Any other MP3 is treated as a music track.

The first file (alphabetical) is marked `default: true` unless a file
named "Mami's Potion Dance.mp3" is present, in which case that one wins.

Run: python scripts/build_music_manifest.py
"""

import json
import os
import re
import sys

WEB_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MP3_DIR  = os.path.join(WEB_ROOT, "sound", "mp3")
DST      = os.path.join(WEB_ROOT, "sound", "music.json")

EMOTION_SFX = re.compile(r"^\d{2}_.*\.mp3$", re.IGNORECASE)

# Preferred default filename (case-insensitive match), kept at top of list
PREFERRED_DEFAULT = "mami's potion dance.mp3"


def slugify(name):
    """Build a short id from the display name."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "track"


def main():
    if not os.path.isdir(MP3_DIR):
        print(f"[ERROR] {MP3_DIR} does not exist")
        return 1

    tracks = []
    for name in sorted(os.listdir(MP3_DIR)):
        if not name.lower().endswith(".mp3"):
            continue
        if EMOTION_SFX.match(name):
            continue
        display = os.path.splitext(name)[0]
        tracks.append({
            "id":   slugify(display),
            "name": display,
            "path": f"sound/mp3/{name}",
        })

    # Reorder so the preferred default ends up first, and flag it.
    def is_default(t):
        return os.path.basename(t["path"]).lower() == PREFERRED_DEFAULT
    tracks.sort(key=lambda t: (not is_default(t), t["name"].lower()))
    if tracks:
        tracks[0]["default"] = True

    with open(DST, "w", encoding="utf-8") as f:
        json.dump(tracks, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"[OK] {DST} — {len(tracks)} track(s):")
    for t in tracks:
        default = " (default)" if t.get("default") else ""
        print(f"     {t['name']}{default}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
