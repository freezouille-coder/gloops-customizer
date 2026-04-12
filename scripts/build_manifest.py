"""
Scan FBX/ANIM/, FBX/POSE/ subfolders and TEXTURES/ to generate FBX/manifest.json

Run: python scripts/build_manifest.py
"""

import os
import json

BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "FBX")
ANIM_DIR = os.path.join(BASE, "ANIM")
POSE_DIR = os.path.join(BASE, "POSE")
MANIFEST = os.path.join(BASE, "manifest.json")
TEXTURES_DIR = os.path.join(os.path.dirname(BASE), "TEXTURES")


def scan():
    categories = {}

    # Scan ANIM subfolders
    if os.path.exists(ANIM_DIR):
        for folder_name in sorted(os.listdir(ANIM_DIR)):
            folder_path = os.path.join(ANIM_DIR, folder_name)
            if os.path.isdir(folder_path):
                files = sorted([f for f in os.listdir(folder_path) if f.lower().endswith(".fbx")])
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
                files = sorted([f for f in os.listdir(folder_path) if f.lower().endswith(".fbx")])
                if files:
                    categories[folder_name] = {
                        "type": "pose",
                        "folder": "POSE/{}".format(folder_name),
                        "files": files
                    }

    # Scan TEXTURES with auto-connect naming convention
    # Convention: {mesh}_{Type}.png or {mesh}_{Type}.{variant}.png
    # Types: Diffuse, ID (RGBA mask), Normal, Roughness, Metalness, Occ, SSS, Ramp, DS, Alpha, Emit
    textures = {}
    auto_connect = {}  # mesh_name -> { type: [paths] }

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
        'femal': 'variant',
        'bump': 'bumpMap', 'bp': 'bumpMap',
        'diffusew': 'diffuseWeightMap', 'dw': 'diffuseWeightMap',
        'pattern': 'pattern',
    }

    if os.path.exists(TEXTURES_DIR):
        for root, dirs, files in os.walk(TEXTURES_DIR):
            folder = os.path.basename(root)
            for f in sorted(files):
                if f.lower().endswith(('.png', '.jpg', '.jpeg')):
                    full_path = os.path.join(root, f)
                    rel_path = os.path.relpath(full_path, os.path.dirname(BASE)).replace("\\", "/")
                    name = os.path.splitext(f)[0]
                    tex_id = "{}/{}".format(folder, name)
                    textures[tex_id] = rel_path

                    # Parse for auto-connect
                    # Try to match: folder_Type or folder_Type.variant
                    name_lower = name.lower()
                    parts = name_lower.replace(folder.lower() + '_', '').split('.')
                    type_name = parts[0]
                    variant = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else None

                    mapped_type = TEXTURE_TYPES.get(type_name)
                    if mapped_type:
                        if folder not in auto_connect:
                            auto_connect[folder] = {}
                        if mapped_type not in auto_connect[folder]:
                            auto_connect[folder][mapped_type] = []
                        auto_connect[folder][mapped_type].append({
                            'id': tex_id,
                            'path': rel_path,
                            'variant': variant
                        })

    manifest = {
        "categories": categories,
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
    for tid, path in list(textures.items())[:10]:
        print("  {} -> {}".format(tid, path))
    if len(textures) > 10:
        print("  ... and {} more".format(len(textures) - 10))
    print("\nAuto-connect:")
    for mesh, types in auto_connect.items():
        print("  {}:".format(mesh))
        for typ, entries in types.items():
            paths = [e['path'] for e in entries]
            print("    {} -> {} file(s)".format(typ, len(paths)))

    return manifest


if __name__ == "__main__":
    scan()
else:
    scan()
