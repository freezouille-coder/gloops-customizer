"""
Scan {glb,fbx}/ANIM/, POSE/, SET/, PROPS/ and images/{webp,png,chr}/ to
generate the manifest consumed by the web client.

Assets:
  glb/                            -> preferred (GLB + Draco optional)
  fbx/                            -> fallback

Textures (priority: whichever folder exists first is used):
  images/webp/chr/{mesh}/          -> WebP pool (preferred)
  images/png/chr/{mesh}/           -> PNG mirror (for comparisons)
  images/chr/{mesh}/               -> legacy pre-WebP layout

Per-mesh layout:
  {mesh}/                          base textures  ({mesh}_{Type}.{ext})
  {mesh}/diffuse/                  diffuse variants ({mesh}_Diffuse.{N}.{ext})
  {mesh}/pattern/                  pattern variants ({mesh}_Pattern.{N}.{ext})

Run: python scripts/build_manifest.py
"""

import os
import json

WEB_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Auto-detect format. FBX is preferred — matches the app's
# _resolveManifestPath() in js/app.js (FBX first, GLB fallback). Only scan
# GLB when fbx/ is empty or absent.
GLB_DIR = os.path.join(WEB_ROOT, "glb")
FBX_DIR = os.path.join(WEB_ROOT, "fbx")
if os.path.isdir(FBX_DIR) and any(
    f.lower().endswith(".fbx")
    for root, _, files in os.walk(FBX_DIR)
    for f in files
):
    ASSET_DIR = FBX_DIR
    EXT = ".fbx"
    print("[build_manifest] scanning FBX folder")
else:
    ASSET_DIR = GLB_DIR
    EXT = ".glb"
    print("[build_manifest] scanning GLB folder")

ANIM_DIR = os.path.join(ASSET_DIR, "ANIM")
POSE_DIR = os.path.join(ASSET_DIR, "POSE")
SET_DIR = os.path.join(ASSET_DIR, "SET")
PROPS_DIR = os.path.join(ASSET_DIR, "PROPS")
PROPS_ANIM_DIR = os.path.join(ANIM_DIR, "Props")
MANIFEST = os.path.join(ASSET_DIR, "manifest.json")

# Auto-detect which image pool to scan. Priority:
#   1) images/webp/chr   -- preferred (smaller files)
#   2) images/png/chr    -- fallback, clean copy of the PNGs
#   3) images/chr        -- legacy layout (pre-WebP split)
# The manifest stores paths relative to WEB_ROOT, so whichever folder we
# pick here is the one the browser ends up loading from. Delete or rename
# `images/webp/` if you want to force PNG mode.
_WEBP_CHR = os.path.join(WEB_ROOT, "images", "webp", "chr")
_PNG_CHR  = os.path.join(WEB_ROOT, "images", "png",  "chr")
_OLD_CHR  = os.path.join(WEB_ROOT, "images", "chr")
if os.path.isdir(_WEBP_CHR):
    IMAGES_DIR = _WEBP_CHR
    print("[build_manifest] scanning textures: images/webp/chr (WebP)")
elif os.path.isdir(_PNG_CHR):
    IMAGES_DIR = _PNG_CHR
    print("[build_manifest] scanning textures: images/png/chr (PNG)")
else:
    IMAGES_DIR = _OLD_CHR
    print("[build_manifest] scanning textures: images/chr (legacy)")

TEXTURE_TYPES = {
    'diffuse': 'diffuse', 'basecolor': 'diffuse', 'color': 'diffuse',
    'id': 'rgbMask', 'mask': 'rgbMask',
    'normal': 'normalMap',
    'roughness': 'roughnessMap', 'rough': 'roughnessMap',
    'metalness': 'metalnessMap', 'metal': 'metalnessMap', 'metallic': 'metalnessMap',
    'occ': 'aoMap', 'ao': 'aoMap', 'occlusion': 'aoMap',
    'sss': 'sssMap', 'subsurface': 'sssMap',
    'ramp': 'blendMask',
    'ds': 'displacementMap', 'displacement': 'displacementMap', 'height': 'displacementMap',
    'alpha': 'alphaMap', 'opacity': 'alphaMap',
    'emit': 'emissiveMap', 'emissive': 'emissiveMap',
    'bump': 'bumpMap', 'bp': 'bumpMap',
    'dw': 'diffuseWeightMap', 'diffusew': 'diffuseWeightMap',
    'pattern': 'pattern',
    'femal': 'variant',
}


def scan():
    categories = {}

    # Scan ANIM subfolders
    if os.path.exists(ANIM_DIR):
        for folder_name in sorted(os.listdir(ANIM_DIR)):
            folder_path = os.path.join(ANIM_DIR, folder_name)
            if os.path.isdir(folder_path):
                files = sorted([f for f in os.listdir(folder_path) if f.lower().endswith(EXT)])
                if files:
                    categories[folder_name] = {
                        "type": "anim",
                        "folder": "ANIM/{}".format(folder_name),
                        "files": files
                    }

    # Scan POSE subfolders
    if os.path.exists(POSE_DIR):
        for folder_name in sorted(os.listdir(POSE_DIR)):
            folder_path = os.path.join(POSE_DIR, folder_name)
            if os.path.isdir(folder_path):
                files = sorted([f for f in os.listdir(folder_path) if f.lower().endswith(EXT)])
                if files:
                    categories[folder_name] = {
                        "type": "pose",
                        "folder": "POSE/{}".format(folder_name),
                        "files": files
                    }

    # Scan SET subfolders (legacy — one subfolder per set)
    sets = {}
    if os.path.exists(SET_DIR):
        for set_name in sorted(os.listdir(SET_DIR)):
            set_path = os.path.join(SET_DIR, set_name)
            if os.path.isdir(set_path):
                asset_files = [f for f in os.listdir(set_path) if f.lower().endswith(EXT)]
                if asset_files:
                    sets[set_name] = {
                        "fbx": "SET/{}/{}".format(set_name, asset_files[0]),
                        "textures": {}
                    }
                    # Check for set textures
                    set_tex_dir = os.path.join(WEB_ROOT, "images", "set", set_name)
                    if os.path.exists(set_tex_dir):
                        for f in sorted(os.listdir(set_tex_dir)):
                            if f.lower().endswith(('.png', '.jpg', '.hdr', '.webp')):
                                rel = os.path.relpath(os.path.join(set_tex_dir, f), WEB_ROOT).replace("\\", "/")
                                name = os.path.splitext(f)[0]
                                sets[set_name]["textures"][name] = rel

    # ------------------------------------------------------------------
    # Scan SET/ for flat `block_<W>x<H>_<NN>[_w<weight>].<ext>` files —
    # the new city-block palette. Each entry captures the dimensions in
    # cells, the variant number, and the probability weight (default 10).
    # Emitted in manifest as `cityBlocks`.
    # ------------------------------------------------------------------
    import re
    city_blocks = []
    # `variant` now accepts any alphanumeric label — Stores, SuperMarket,
    # Tower, House, etc. — so filenames can be self-documenting.
    # Examples:
    #   block_2x2_01.fbx              (variant="01", legacy numeric)
    #   block_2x2_Stores.fbx          (variant="Stores", default weight)
    #   block_2x2_SuperMarket_w30.fbx (variant="SuperMarket", weight 30)
    block_rx = re.compile(
        r"^block_(\d+)x(\d+)_([A-Za-z0-9]+)(?:_w(\d+))?\." + EXT.lstrip(".") + r"$",
        re.IGNORECASE,
    )
    if os.path.exists(SET_DIR):
        for f in sorted(os.listdir(SET_DIR)):
            full = os.path.join(SET_DIR, f)
            if not os.path.isfile(full):
                continue
            m = block_rx.match(f)
            if not m:
                # Not a block_WxH_NN file — skip silently
                continue
            w = int(m.group(1))
            h = int(m.group(2))
            variant = m.group(3)          # kept as string — "Stores", "01", etc.
            weight = int(m.group(4)) if m.group(4) else 10
            city_blocks.append({
                "file":    "SET/{}".format(f),
                "w":       w,
                "h":       h,
                "variant": variant,
                "weight":  weight,
            })

    if city_blocks:
        print("City blocks: {} file(s)".format(len(city_blocks)))
        for b in city_blocks:
            print("  {}  ({}x{} '{}' w{})".format(
                b["file"], b["w"], b["h"], b["variant"], b["weight"]))

    # Scan PROPS
    props = {}
    if os.path.exists(PROPS_DIR):
        for f in sorted(os.listdir(PROPS_DIR)):
            if not f.lower().endswith(EXT):
                continue
            prop_name = os.path.splitext(f)[0]
            prop_entry = {
                "model": "PROPS/{}".format(f),
                "bone": "head",  # default bone, can be overridden in config
            }
            # Check if matching animation exists
            anim_file = os.path.join(PROPS_ANIM_DIR, f) if os.path.exists(PROPS_ANIM_DIR) else None
            if anim_file and os.path.exists(anim_file):
                prop_entry["animation"] = "ANIM/Props/{}".format(f)

            # Try to detect category from name
            name_lower = prop_name.lower()
            if 'glass' in name_lower or 'sunglass' in name_lower:
                prop_entry["category"] = "Glasses"
                prop_entry["bone"] = "head"
            elif 'hat' in name_lower or 'cap' in name_lower:
                prop_entry["category"] = "Hats"
                prop_entry["bone"] = "head"
            else:
                prop_entry["category"] = "Accessories"

            props[prop_name] = prop_entry

    print("Props: {} items".format(len(props)))
    for name, data in props.items():
        has_anim = "animation" in data
        print("  {} ({}) bone:{} anim:{}".format(name, data.get("category", "?"), data["bone"], "YES" if has_anim else "no"))

    # Scan images/chr/
    textures = {}
    auto_connect = {}

    if os.path.exists(IMAGES_DIR):
        for mesh_folder in sorted(os.listdir(IMAGES_DIR)):
            mesh_path = os.path.join(IMAGES_DIR, mesh_folder)
            if not os.path.isdir(mesh_path):
                continue

            # Scan base textures in mesh folder
            _scan_folder(mesh_path, mesh_folder, mesh_folder, textures, auto_connect)

            # Scan diffuse/ subfolder
            diffuse_path = os.path.join(mesh_path, "diffuse")
            if os.path.isdir(diffuse_path):
                _scan_folder(diffuse_path, mesh_folder, mesh_folder, textures, auto_connect)

            # Scan pattern/ subfolder
            pattern_path = os.path.join(mesh_path, "pattern")
            if os.path.isdir(pattern_path):
                _scan_folder(pattern_path, mesh_folder, mesh_folder, textures, auto_connect)

    manifest = {
        "categories": categories,
        "props": props,
        "sets": sets,
        "cityBlocks": city_blocks,
        "textures": textures,
        "autoConnect": auto_connect
    }

    with open(MANIFEST, "w") as f:
        json.dump(manifest, f, indent=4)

    print("Manifest generated: {}".format(MANIFEST))
    print("Categories: {}".format(list(categories.keys())))
    for name, data in categories.items():
        print("  {} ({}) - {} files".format(name, data["type"], len(data["files"])))
    print("Textures: {} files".format(len(textures)))
    print("\nAuto-connect:")
    for mesh, types in auto_connect.items():
        print("  {}:".format(mesh))
        for typ, entries in types.items():
            print("    {} -> {} file(s)".format(typ, len(entries)))

    return manifest


def _scan_folder(folder_path, mesh_folder, mesh_name, textures, auto_connect):
    """Scan a folder for texture files and add to textures + auto_connect."""
    for f in sorted(os.listdir(folder_path)):
        if not f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
            continue

        full_path = os.path.join(folder_path, f)
        # Always relative to WEB_ROOT
        rel_from_web = os.path.relpath(full_path, WEB_ROOT).replace("\\", "/")

        name = os.path.splitext(f)[0]
        tex_id = "{}/{}".format(mesh_folder, name)
        textures[tex_id] = rel_from_web

        # Parse type and variant
        name_lower = name.lower()
        # Remove mesh prefix: body_Normal -> normal, eyes_Diffuse.0 -> diffuse.0
        stripped = name_lower
        for prefix in [mesh_name.lower() + '_', mesh_name.lower()]:
            if stripped.startswith(prefix):
                stripped = stripped[len(prefix):]
                break

        parts = stripped.split('.')
        type_name = parts[0]
        variant = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else None

        mapped_type = TEXTURE_TYPES.get(type_name)
        if mapped_type:
            if mesh_name not in auto_connect:
                auto_connect[mesh_name] = {}
            if mapped_type not in auto_connect[mesh_name]:
                auto_connect[mesh_name][mapped_type] = []
            auto_connect[mesh_name][mapped_type].append({
                'id': tex_id,
                'path': rel_from_web,
                'variant': variant
            })


if __name__ == "__main__":
    scan()
else:
    scan()
