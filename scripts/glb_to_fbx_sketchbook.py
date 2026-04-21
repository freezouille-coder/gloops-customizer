"""
Convert every Sketchbook .glb under assets/sketchbook/ into an .fbx next to
it in assets/sketchbook_fbx/. Textures are unpacked to disk so Maya picks
them up automatically.

Run (from the WEB root):
    "C:/Program Files/Blender Foundation/Blender 4.3/blender.exe" \\
        --background --python scripts/glb_to_fbx_sketchbook.py
"""
import bpy
import os
import sys
import glob

WEB_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR  = os.path.join(WEB_ROOT, "assets", "sketchbook")
DST_DIR  = os.path.join(WEB_ROOT, "assets", "sketchbook_fbx")


def _wipe_scene():
    # Remove everything (incl. default cube / lamp / camera) so each GLB
    # lands in a fresh scene.
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.meshes):       bpy.data.meshes.remove(block)
    for block in list(bpy.data.materials):    bpy.data.materials.remove(block)
    for block in list(bpy.data.textures):     bpy.data.textures.remove(block)
    for block in list(bpy.data.images):       bpy.data.images.remove(block)
    for block in list(bpy.data.armatures):    bpy.data.armatures.remove(block)
    for block in list(bpy.data.actions):      bpy.data.actions.remove(block)


def _unpack_textures(tex_dir):
    """Unpack embedded GLB images to disk so Maya's FBX loader can find them."""
    os.makedirs(tex_dir, exist_ok=True)
    bpy.context.scene.render.filepath = tex_dir
    for img in bpy.data.images:
        if img.packed_file is None:
            continue
        # Name the file safely
        safe = "".join(c for c in (img.name or "tex") if c.isalnum() or c in "._-")
        if not safe.lower().endswith((".png", ".jpg", ".jpeg")):
            safe += ".png"
        dst = os.path.join(tex_dir, safe)
        img.filepath_raw = dst
        img.file_format = "PNG"
        try:
            img.save()
            print(f"    unpacked {safe}")
        except Exception as e:
            print(f"    [warn] couldn't unpack {safe}: {e}")


def convert(src_glb, dst_fbx):
    _wipe_scene()
    print(f"\n=== {os.path.basename(src_glb)} -> {os.path.basename(dst_fbx)} ===")
    bpy.ops.import_scene.gltf(filepath=src_glb)

    # Sketchbook uses Y-up but Blender imports glTF as Z-up. Keep the default
    # — Maya is Y-up, FBX export below rotates back.

    # Unpack textures into a sidecar folder so FBX references PNGs on disk
    tex_dir = os.path.join(os.path.dirname(dst_fbx), "textures",
                           os.path.splitext(os.path.basename(dst_fbx))[0])
    _unpack_textures(tex_dir)

    bpy.ops.export_scene.fbx(
        filepath=dst_fbx,
        check_existing=False,
        use_selection=False,
        # --- Transform ---
        global_scale=1.0,
        apply_unit_scale=True,
        apply_scale_options='FBX_SCALE_NONE',
        bake_space_transform=False,
        axis_forward='-Z',
        axis_up='Y',
        # --- Content ---
        object_types={'ARMATURE', 'MESH', 'EMPTY', 'OTHER'},
        use_mesh_modifiers=True,
        mesh_smooth_type='FACE',
        use_subsurf=False,
        use_custom_props=True,
        # --- Animation ---
        bake_anim=True,
        bake_anim_use_all_bones=True,
        bake_anim_use_nla_strips=True,
        bake_anim_use_all_actions=True,
        bake_anim_force_startend_keying=True,
        bake_anim_step=1.0,
        bake_anim_simplify_factor=1.0,
        # --- Path / textures ---
        path_mode='COPY',         # copy textures alongside the .fbx
        embed_textures=False,     # keep them as external files so Maya can relink
    )
    # Size report
    sz = os.path.getsize(dst_fbx) / 1024 / 1024
    print(f"    OK  ({sz:.2f} MB)")


def main():
    if not os.path.isdir(SRC_DIR):
        print(f"[ERROR] source dir not found: {SRC_DIR}")
        sys.exit(1)
    os.makedirs(DST_DIR, exist_ok=True)

    glbs = sorted(glob.glob(os.path.join(SRC_DIR, "*.glb")))
    if not glbs:
        print(f"[ERROR] no .glb in {SRC_DIR}")
        sys.exit(1)

    print(f"Sketchbook GLB -> FBX")
    print(f"  src: {SRC_DIR}")
    print(f"  dst: {DST_DIR}")
    print(f"  {len(glbs)} file(s) to convert")

    for src in glbs:
        name = os.path.splitext(os.path.basename(src))[0]
        dst  = os.path.join(DST_DIR, name + ".fbx")
        try:
            convert(src, dst)
        except Exception as e:
            print(f"[FAIL] {name}: {e}")

    print(f"\nDone. Output in: {DST_DIR}")


if __name__ == "__main__":
    main()
