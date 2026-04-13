"""
Scan fbx/ANIM/, fbx/POSE/ and images/chr/ to generate fbx/manifest.json

New structure:
  images/chr/{mesh}/              -> base textures ({mesh}_{Type}.png)
  images/chr/{mesh}/diffuse/      -> diffuse variants ({mesh}_Diffuse.{N}.png)
  images/chr/{mesh}/pattern/      -> pattern variants ({mesh}_Pattern.{N}.png)

Run: python scripts/build_manifest.py
"""

import os
import json

WEB_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FBX_DIR = os.path.join(WEB_ROOT, "fbx")
ANIM_DIR = os.path.join(FBX_DIR, "ANIM")
POSE_DIR = os.path.join(FBX_DIR, "POSE")
MANIFEST = os.path.join(FBX_DIR, "manifest.json")
IMAGES_DIR = os.path.join(WEB_ROOT, "images", "chr")

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
        if not f.lower().endswith(('.png', '.jpg', '.jpeg')):
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
