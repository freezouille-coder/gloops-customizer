"""
Gloops - Studio Library to FBX Exporter
Run in Maya Script Editor (Python):
    exec(open("H:/Shared drives/GLOOPS/09_GAME/WEB/scripts/export_traits.py").read())
"""

import os
import json
import subprocess
import maya.cmds as cmds
import maya.mel as mel

WINDOW_NAME = "gloopsExporter"
MANIFEST_NAME = "manifest.json"

# --- DEFAULTS ---
DEFAULT_SKELETON = "root"
DEFAULT_GEOS = "body_high, teeths_low, arms_R_low, arms_L_low, horns_low, tongue_low, eyeLid_Upper_R_low, eyeLid_Down_R_low, eyeLid_Upper_L_low, eyeLid_Down_L_low, eyeBrows_R_low, eyeBrows_L_low, eye_R_low, eye_L_low"
DEFAULT_SOURCE = "H:/Shared drives/GLOOPS/01_PROD/01_ASSET/01_CHR/01_POLIPO/library/StudioLib/Polipo"
DEFAULT_TARGET = "H:/Shared drives/GLOOPS/09_GAME/WEB/FBX/ANIM"


# ============================================================
# CORE
# ============================================================

def get_items(folder):
    """List all .pose and .anim items in a Studio Library folder (recursive)."""
    items = []
    if not folder or not os.path.exists(folder):
        return items
    for entry in sorted(os.listdir(folder)):
        full = os.path.join(folder, entry)
        if entry.endswith(".pose") or entry.endswith(".anim"):
            items.append(full)
        elif os.path.isdir(full) and not entry.startswith("."):
            items.extend(get_items(full))
    return items


def item_name(path):
    return os.path.splitext(os.path.basename(path))[0]


def item_type(path):
    return "pose" if path.endswith(".pose") else "anim"


def detect_anim_range():
    """Detect the real animation range from all anim curves in the scene."""
    anim_curves = cmds.ls(type=["animCurveTL", "animCurveTA", "animCurveTU"]) or []
    if not anim_curves:
        s = int(cmds.playbackOptions(q=True, minTime=True))
        e = int(cmds.playbackOptions(q=True, maxTime=True))
        return s, e

    global_start = float('inf')
    global_end = float('-inf')
    for curve in anim_curves:
        num_keys = cmds.keyframe(curve, q=True, keyframeCount=True)
        if num_keys > 0:
            keys = cmds.keyframe(curve, q=True, timeChange=True)
            if keys:
                global_start = min(global_start, keys[0])
                global_end = max(global_end, keys[-1])

    if global_start == float('inf'):
        s = int(cmds.playbackOptions(q=True, minTime=True))
        e = int(cmds.playbackOptions(q=True, maxTime=True))
        return s, e
    return int(global_start), int(global_end)


def apply_studio_lib_item(path, namespace=""):
    """Apply a .pose or .anim from Studio Library on all scene controllers."""
    ctrls = cmds.ls("*_ctrl", "*_CTRL", "*Ctrl*", type="transform")
    if ctrls:
        cmds.select(ctrls)
    else:
        cmds.select(all=True)

    ext = os.path.splitext(path)[1]
    try:
        if ext == ".pose":
            from studiolibrarymaya import poseitem
            poseitem.load(path, objects=cmds.ls(selection=True) or [],
                          namespaces=[namespace] if namespace else [],
                          key=True, mirror=False)
        elif ext == ".anim":
            from studiolibrarymaya import animitem
            animitem.load(path, objects=cmds.ls(selection=True) or [],
                          namespaces=[namespace] if namespace else [],
                          option="replaceCompletely")
        return True
    except Exception as e:
        cmds.warning("Failed to load {}: {}".format(path, e))
        return False


def capture_rest_pose(skeleton_root):
    """Capture the current (rest/T-pose) values of all joints and blendshapes."""
    rest = {}
    cmds.select(skeleton_root, hierarchy=True)
    joints = cmds.ls(selection=True, type="joint")
    for jnt in joints:
        values = {}
        for attr in ["translateX", "translateY", "translateZ",
                      "rotateX", "rotateY", "rotateZ",
                      "scaleX", "scaleY", "scaleZ"]:
            try:
                values[attr] = cmds.getAttr("{}.{}".format(jnt, attr))
            except:
                values[attr] = 0
        rest[jnt] = values

    for bs in cmds.ls(type="blendShape"):
        targets = cmds.listAttr(bs + ".weight", multi=True) or []
        for target in targets:
            key = "{}.{}".format(bs, target)
            try:
                rest[key] = cmds.getAttr(key)
            except:
                rest[key] = 0
    return rest


def clean_unchanged_anim(skeleton_root, rest_pose, threshold=0.001):
    """
    Remove anim curves from bones/blendshapes that haven't changed
    from the rest pose. Ensures overlay animations only contain
    data for bones that actually moved.
    """
    removed = 0
    total = 0

    cmds.select(skeleton_root, hierarchy=True)
    joints = cmds.ls(selection=True, type="joint")

    for jnt in joints:
        if jnt not in rest_pose:
            continue
        for attr in ["translateX", "translateY", "translateZ",
                      "rotateX", "rotateY", "rotateZ",
                      "scaleX", "scaleY", "scaleZ"]:
            full_attr = "{}.{}".format(jnt, attr)
            total += 1
            connections = cmds.listConnections(full_attr, type="animCurve") or []
            if not connections:
                continue
            rest_val = rest_pose[jnt].get(attr, 0)
            curve = connections[0]
            key_values = cmds.keyframe(curve, q=True, valueChange=True) or []
            if not key_values:
                continue
            max_delta = max(abs(v - rest_val) for v in key_values)
            if max_delta < threshold:
                cmds.delete(curve)
                removed += 1

    for bs in cmds.ls(type="blendShape"):
        targets = cmds.listAttr(bs + ".weight", multi=True) or []
        for target in targets:
            key = "{}.{}".format(bs, target)
            total += 1
            rest_val = rest_pose.get(key, 0)
            connections = cmds.listConnections(key, type="animCurve") or []
            if not connections:
                continue
            curve = connections[0]
            key_values = cmds.keyframe(curve, q=True, valueChange=True) or []
            if not key_values:
                continue
            max_delta = max(abs(v - rest_val) for v in key_values)
            if max_delta < threshold:
                cmds.delete(curve)
                removed += 1

    print("  >> Cleaned anim: removed {}/{} unchanged curves".format(removed, total))
    return removed


def bake_blendshapes(geo_nodes, start_frame, end_frame):
    """
    Explicitly bake all blendshape weights to keyframes.
    This is critical because FBX bake doesn't catch blendshapes
    driven by set driven keys, expressions, or other indirect connections.
    """
    baked = 0
    for geo in geo_nodes:
        if not cmds.objExists(geo):
            continue
        # Find blendshape deformers on this geo
        history = cmds.listHistory(geo, pruneDagObjects=True) or []
        for node in history:
            if cmds.nodeType(node) == "blendShape":
                targets = cmds.listAttr(node + ".weight", multi=True) or []
                attrs = ["{}.{}".format(node, t) for t in targets]
                if attrs:
                    try:
                        cmds.bakeResults(
                            attrs,
                            simulation=True,
                            time=(start_frame, end_frame),
                            sampleBy=1,
                            oversamplingRate=1,
                            disableImplicitControl=True,
                            preserveOutsideKeys=False
                        )
                        baked += len(attrs)
                    except Exception as e:
                        cmds.warning("Failed to bake blendshapes on {}: {}".format(node, e))
    if baked:
        print("  >> Baked {} blendshape channels".format(baked))


def do_export_fbx(output_path, start_frame, end_frame, skeleton_root, geo_nodes,
                  export_blendshapes=True):
    """Unparent skeleton+geos to world, configure FBX, export.
    If geo_nodes is empty, exports the skeleton only (no meshes, no shapes)."""
    all_nodes = [skeleton_root] + (geo_nodes or [])

    for node in all_nodes:
        if cmds.objExists(node):
            parent = cmds.listRelatives(node, parent=True)
            if parent:
                try:
                    cmds.parent(node, world=True)
                except:
                    pass

    mel.eval("FBXResetExport;")
    mel.eval("FBXExportSmoothingGroups -v true;")
    mel.eval("FBXExportSmoothMesh -v true;")
    mel.eval("FBXExportTriangulate -v false;")
    mel.eval("FBXExportFileVersion -v FBX201800;")
    # Only export shapes (blendshapes) if we actually have meshes to carry them
    shapes_on = "true" if (export_blendshapes and geo_nodes) else "false"
    skins_on  = "true" if geo_nodes else "false"
    mel.eval("FBXExportShapes -v {};".format(shapes_on))
    mel.eval("FBXExportSkins -v {};".format(skins_on))
    mel.eval("FBXExportBakeComplexAnimation -v true;")
    mel.eval("FBXExportBakeComplexStart -v {};".format(int(start_frame)))
    mel.eval("FBXExportBakeComplexEnd -v {};".format(int(end_frame)))
    mel.eval("FBXExportBakeComplexStep -v 1;")
    mel.eval("FBXExportInputConnections -v false;")
    mel.eval("FBXExportConstraints -v false;")
    mel.eval("FBXExportCameras -v false;")
    mel.eval("FBXExportLights -v false;")
    mel.eval("FBXExportEmbeddedTextures -v false;")

    cmds.select(all_nodes, replace=True)
    export_path_clean = output_path.replace("\\", "/")
    mel.eval('FBXExport -f "{}" -s;'.format(export_path_clean))
    print("  >> Exported: {} ({})".format(
        export_path_clean,
        "skeleton only" if not geo_nodes else "skeleton + {} meshes".format(len(geo_nodes))
    ))


FPS_UNITS = {
    None: None,       # keep scene fps unchanged
    24:  "film",
    25:  "pal",
    30:  "ntsc",
    48:  "show",
    50:  "palf",
    60:  "ntscf",
}


def set_scene_fps(fps):
    """Change the scene's frame-rate unit. Returns the previous unit string
    so the caller can restore it."""
    prev = cmds.currentUnit(query=True, time=True)
    unit = FPS_UNITS.get(fps)
    if unit and unit != prev:
        cmds.currentUnit(time=unit, updateAnimation=True)
        print("  >> Scene FPS changed: {} -> {} ({} fps)".format(prev, unit, fps))
    return prev


# ============================================================
# BATCH PROP EXPORT (skeleton + single mesh -> one FBX per mesh)
# ============================================================

def do_export_prop(output_path, skeleton_root, mesh):
    """Export a STATIC prop FBX: skeleton root + a single mesh, no animation.
    Used to batch-build paired props (one FBX per mesh, named after the mesh)
    that the customizer attaches via Type C (skeleton rebind)."""
    all_nodes = [skeleton_root, mesh]

    # Unparent both to world for a clean export hierarchy
    for node in all_nodes:
        if cmds.objExists(node):
            parent = cmds.listRelatives(node, parent=True)
            if parent:
                try:
                    cmds.parent(node, world=True)
                except:
                    pass

    mel.eval("FBXResetExport;")
    mel.eval("FBXExportSmoothingGroups -v true;")
    mel.eval("FBXExportSmoothMesh -v true;")
    mel.eval("FBXExportTriangulate -v false;")
    mel.eval("FBXExportFileVersion -v FBX201800;")
    mel.eval("FBXExportShapes -v true;")             # blendshapes (BS_*)
    mel.eval("FBXExportSkins -v true;")              # skin weights
    mel.eval("FBXExportBakeComplexAnimation -v false;")  # static, no anim
    mel.eval("FBXExportInputConnections -v false;")
    mel.eval("FBXExportConstraints -v false;")
    mel.eval("FBXExportCameras -v false;")
    mel.eval("FBXExportLights -v false;")
    mel.eval("FBXExportEmbeddedTextures -v false;")

    cmds.select(all_nodes, replace=True)
    export_path_clean = output_path.replace("\\", "/")
    mel.eval('FBXExport -f "{}" -s;'.format(export_path_clean))
    print("  >> Exported prop: {}".format(export_path_clean))


def batch_export_props(target_folder, skeleton_root, meshes):
    """For each mesh in `meshes`, export an FBX named `<mesh>.fbx` containing
    (skeleton + that single mesh). Saves and reopens the scene between
    exports to keep a clean state."""
    if not skeleton_root or not cmds.objExists(skeleton_root):
        cmds.confirmDialog(title="Error",
                           message="Skeleton root not found: {}".format(skeleton_root))
        return

    valid_meshes = [m for m in meshes if cmds.objExists(m)]
    if not valid_meshes:
        cmds.confirmDialog(title="Error", message="No valid meshes selected.")
        return

    if not os.path.exists(target_folder):
        os.makedirs(target_folder)

    scene_path = cmds.file(q=True, sceneName=True)
    if not scene_path:
        result = cmds.confirmDialog(
            title="Scene not saved",
            message="The scene must be saved before batch export.\nSave now?",
            button=["Save", "Cancel"], defaultButton="Save", cancelButton="Cancel")
        if result == "Save":
            cmds.file(save=True)
            scene_path = cmds.file(q=True, sceneName=True)
        else:
            return

    if not scene_path:
        cmds.error("Scene must be saved first.")
        return

    cmds.file(save=True, type="mayaAscii")

    if not cmds.pluginInfo("fbxmaya", q=True, loaded=True):
        cmds.loadPlugin("fbxmaya", quiet=True)

    print("\n========== BATCH PROP EXPORT ==========")
    print("Skeleton:  {}".format(skeleton_root))
    print("Meshes:    {}".format(valid_meshes))
    print("Target:    {}".format(target_folder))
    print("=======================================\n")

    exported = 0
    total = len(valid_meshes)
    cmds.progressWindow(title="Batch Prop Export", progress=0, maxValue=total,
                        status="Starting...", isInterruptable=True)

    for i, mesh in enumerate(valid_meshes):
        if cmds.progressWindow(q=True, isCancelled=True):
            print("Batch cancelled by user.")
            break

        # Filename = mesh short name (strip namespace + path)
        short = mesh.split("|")[-1].split(":")[-1]
        fbx_name = "{}.fbx".format(short)
        output_path = os.path.join(target_folder, fbx_name)

        cmds.progressWindow(edit=True, progress=i,
                            status="[{}/{}] {}".format(i + 1, total, short))
        print("[{}/{}] {}".format(i + 1, total, short))

        try:
            do_export_prop(output_path, skeleton_root, mesh)
            exported += 1
        except Exception as e:
            cmds.warning("Export failed for {}: {}".format(mesh, e))

        # Reopen the scene so the next iteration starts clean
        cmds.file(scene_path, open=True, force=True)

    cmds.progressWindow(endProgress=True)

    print("\n========== DONE ==========")
    print("Exported {}/{} props".format(exported, total))
    print("==========================")

    cmds.confirmDialog(
        title="Done",
        message="Batch prop export finished!\n{}/{} exported to:\n{}".format(
            exported, total, target_folder))


def find_blender_exe():
    """Locate a Blender executable for the auto-convert-to-GLB option."""
    env = os.environ.get("BLENDER_EXE")
    if env and os.path.exists(env):
        return env
    candidates = [
        r"C:\Program Files\Blender Foundation\Blender 4.3\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.1\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.0\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 3.6\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender\blender.exe",
        "/Applications/Blender.app/Contents/MacOS/Blender",
        "/usr/bin/blender",
        "/usr/local/bin/blender",
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    # Glob any Blender version on Windows
    try:
        import glob
        for base in [r"C:\Program Files\Blender Foundation",
                     r"C:\Program Files (x86)\Blender Foundation"]:
            if os.path.isdir(base):
                for match in sorted(glob.glob(os.path.join(base, "Blender*", "blender.exe")), reverse=True):
                    return match
    except Exception:
        pass
    return None


def convert_folder_to_glb(fbx_folder, glb_folder, compress=True, blender_path=None, scale=100.0):
    """Launch the fbx_to_glb.py script against the freshly-exported FBX
    folder. Runs synchronously so the Maya UI can report success/failure.

    Args:
        scale: uniform scale factor passed to Blender (default 100 —
               Maya exports in cm, Blender interprets as meters, so we
               multiply by 100 to restore the authored size).
    """
    blender = blender_path or find_blender_exe()
    if not blender:
        cmds.warning("[convert_glb] Blender not found — skipping GLB conversion. "
                     "Set BLENDER_EXE env var or install Blender.")
        return False

    # Locate fbx_to_glb.py next to this script. `__file__` isn't defined
    # when Maya runs the script via exec(open(...).read()), so we fall
    # back to well-known paths relative to the project root.
    here = None
    try:
        here = os.path.dirname(os.path.abspath(__file__))  # normal path
    except NameError:
        # Running under Maya's exec() — try the scene's path, then hunt
        scene = cmds.file(q=True, sceneName=True)
        candidates = []
        if scene:
            candidates.append(os.path.join(os.path.dirname(scene), "..", "scripts"))
        candidates += [
            "H:/Shared drives/GLOOPS/09_GAME/WEB/scripts",
            r"H:\Shared drives\GLOOPS\09_GAME\WEB\scripts",
            os.path.join(os.path.expanduser("~"), "maya", "scripts"),
        ]
        for c in candidates:
            if os.path.isdir(c) and os.path.exists(os.path.join(c, "fbx_to_glb.py")):
                here = c
                break
    if here is None:
        cmds.warning("[convert_glb] cannot locate fbx_to_glb.py — set it manually")
        return False
    script = os.path.join(here, "fbx_to_glb.py")
    if not os.path.exists(script):
        cmds.warning("[convert_glb] fbx_to_glb.py not found next to export_traits.py")
        return False

    cmd = [
        blender, "--background",
        "--python", script,
        "--",
        "--input", fbx_folder,
        "--output", glb_folder,
    ]
    if compress:
        cmd.append("--compress")
    if scale and abs(scale - 1.0) > 0.001:
        cmd += ["--scale", str(scale)]

    print("[convert_glb] launching Blender: {}".format(blender))
    print("[convert_glb] cmd: {}".format(" ".join(cmd)))
    try:
        # creationflags avoids spawning a visible cmd window on Windows
        creationflags = 0
        if os.name == "nt":
            creationflags = subprocess.CREATE_NO_WINDOW
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, bufsize=1, creationflags=creationflags)
        for line in iter(proc.stdout.readline, ""):
            if not line:
                break
            print(line.rstrip())
        proc.wait()
        return proc.returncode == 0
    except Exception as e:
        cmds.warning("[convert_glb] failed: {}".format(e))
        return False


def export_all(source_folder, target_folder, skeleton_root, geo_nodes,
               export_mode, update_manifest, clean_bones=True, clean_threshold=0.001,
               target_fps=None, convert_glb=False, glb_compress=True, glb_scale=100.0):
    """Main export loop."""
    items = get_items(source_folder)
    if not items:
        cmds.confirmDialog(title="Error",
                           message="No .pose or .anim found in:\n{}".format(source_folder))
        return

    if not skeleton_root or not cmds.objExists(skeleton_root):
        cmds.confirmDialog(title="Error",
                           message="Skeleton root not found: {}".format(skeleton_root))
        return

    # Geo list is OPTIONAL. If provided, validate each entry.
    geo_nodes = geo_nodes or []
    for g in geo_nodes:
        if not cmds.objExists(g):
            cmds.confirmDialog(title="Error",
                               message="Geometry not found: {}".format(g))
            return

    if not os.path.exists(target_folder):
        os.makedirs(target_folder)

    scene_path = cmds.file(q=True, sceneName=True)
    if not scene_path:
        result = cmds.confirmDialog(
            title="Scene not saved",
            message="The scene must be saved before exporting.\nSave now?",
            button=["Save", "Cancel"], defaultButton="Save", cancelButton="Cancel")
        if result == "Save":
            cmds.file(save=True)
            scene_path = cmds.file(q=True, sceneName=True)
        else:
            return

    if not scene_path:
        cmds.error("Scene must be saved first.")
        return

    cmds.file(save=True, type="mayaAscii")
    print("\nScene saved: {}".format(scene_path))

    if not cmds.pluginInfo("fbxmaya", q=True, loaded=True):
        cmds.loadPlugin("fbxmaya", quiet=True)

    print("\n========== GLOOPS EXPORT ==========")
    print("Source:    {}".format(source_folder))
    print("Target:    {}".format(target_folder))
    print("Skeleton:  {}".format(skeleton_root))
    print("Geos:      {}".format(geo_nodes))
    print("Mode:      {}".format(export_mode))
    print("Clean:     {} (threshold={})".format(clean_bones, clean_threshold))
    print("Items:     {}".format(len(items)))
    print("===================================\n")

    exported = []
    total = len(items)

    cmds.progressWindow(title="Gloops Export", progress=0, maxValue=total,
                        status="Starting...", isInterruptable=True)

    for i, item_path in enumerate(items):
        if cmds.progressWindow(q=True, isCancelled=True):
            print("Export cancelled by user.")
            break

        name = item_name(item_path)
        typ = item_type(item_path)
        fbx_name = "{}.fbx".format(name)
        output_path = os.path.join(target_folder, fbx_name)

        cmds.progressWindow(edit=True, progress=i,
                            status="[{}/{}] {}".format(i + 1, total, name))
        print("[{}/{}] {} ({})".format(i + 1, total, name, typ))

        # 1. Apply Studio Library item
        if not apply_studio_lib_item(item_path):
            print("  >> SKIPPED (failed to load)")
            cmds.file(scene_path, open=True, force=True)
            continue

        # 1b. Change scene FPS if requested (before detecting range so
        #     the range is expressed in the target unit).
        if target_fps:
            set_scene_fps(target_fps)

        # 2. Determine frame range
        if export_mode == "first_frame" or typ == "pose":
            start, end = 1, 1
            cmds.currentTime(1)
            cmds.setKeyframe(time=1)
        else:
            start, end = detect_anim_range()
            print("  >> Detected range: {} - {}".format(start, end))

        # 3. Capture which attrs HAVE anim curves right now
        #    (before bake adds curves to everything)
        animated_attrs = set()
        if clean_bones:
            cmds.select(skeleton_root, hierarchy=True)
            for jnt in cmds.ls(selection=True, type="joint"):
                for attr in ["tx", "ty", "tz", "rx", "ry", "rz", "sx", "sy", "sz"]:
                    full = "{}.{}".format(jnt, attr)
                    if cmds.listConnections(full, type="animCurve"):
                        animated_attrs.add(full)
            print("  >> {} animated joint attrs before bake".format(len(animated_attrs)))

        # 4. Bake blendshapes (only if we're exporting geometry with shapes)
        if geo_nodes:
            bake_blendshapes(geo_nodes, start, end)

        # 5. Clean: remove anim curves that were ADDED by bake
        #    (not present in the original Studio Library pose/anim)
        if clean_bones and animated_attrs:
            removed = 0
            cmds.select(skeleton_root, hierarchy=True)
            for jnt in cmds.ls(selection=True, type="joint"):
                for attr in ["tx", "ty", "tz", "rx", "ry", "rz", "sx", "sy", "sz"]:
                    full = "{}.{}".format(jnt, attr)
                    if full not in animated_attrs:
                        curves = cmds.listConnections(full, type="animCurve") or []
                        for c in curves:
                            try:
                                cmds.delete(c)
                                removed += 1
                            except:
                                pass
            # NOTE: Do NOT clean blendshape curves here.
            # Blendshapes are often driven by set driven keys (not animCurves),
            # so they won't appear in animated_attrs, but the bake creates
            # valid animCurves for them that must be kept.
            print("  >> Cleaned {} joint curves added by bake".format(removed))

        # 6. Export
        try:
            do_export_fbx(output_path, start, end, skeleton_root, geo_nodes)
            exported.append({"file": fbx_name, "type": typ})
        except Exception as e:
            cmds.warning("Export failed for {}: {}".format(name, e))

        # 6. Reopen scene (clean slate for next item)
        cmds.file(scene_path, open=True, force=True)

    cmds.progressWindow(endProgress=True)

    # Update manifest
    if update_manifest and exported:
        manifest_path = os.path.join(os.path.dirname(target_folder), MANIFEST_NAME)
        manifest = {"poses": [], "anims": []}
        if os.path.exists(manifest_path):
            try:
                with open(manifest_path, "r") as f:
                    manifest = json.load(f)
            except:
                pass
        for item in exported:
            key = "poses" if item["type"] == "pose" else "anims"
            if item["file"] not in manifest[key]:
                manifest[key].append(item["file"])
        manifest["poses"] = sorted(manifest["poses"])
        manifest["anims"] = sorted(manifest["anims"])
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=4)
        print("\nManifest updated: {}".format(manifest_path))

    print("\n========== DONE ==========")
    print("Exported {}/{} items".format(len(exported), total))
    print("==========================")

    # --- Optional: auto-convert the freshly-exported FBX folder to GLB ---
    glb_msg = ""
    if convert_glb and exported:
        print("\n[convert_glb] starting Blender batch on {}".format(target_folder))
        glb_folder = os.path.join(
            os.path.dirname(target_folder),
            "glb",
            os.path.basename(target_folder)
        ).replace("\\", "/")
        success = convert_folder_to_glb(target_folder, glb_folder,
                                         compress=glb_compress, scale=glb_scale)
        if success:
            glb_msg = "\n\nGLB conversion: ✓ → {}".format(glb_folder)
            print("[convert_glb] done → {}".format(glb_folder))
        else:
            glb_msg = "\n\nGLB conversion FAILED (see Script Editor)."

    cmds.confirmDialog(title="Done",
                       message="Export finished!\n{}/{} items exported.{}\n\nCheck Script Editor for details.".format(
                           len(exported), total, glb_msg))


# ============================================================
# UI
# ============================================================

def browse_folder_os(field):
    """Open Windows Explorer folder picker."""
    current = cmds.textFieldButtonGrp(field, q=True, text=True).strip()
    start_dir = current if current and os.path.exists(current) else ""

    ps_script = (
        '[System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms") | Out-Null; '
        '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog; '
    )
    if start_dir:
        ps_script += '$dlg.SelectedPath = "{}"; '.format(start_dir.replace("/", "\\"))
    ps_script += (
        '$dlg.Description = "Select Folder"; '
        '$dlg.ShowNewFolderButton = $true; '
        'if ($dlg.ShowDialog() -eq "OK") { $dlg.SelectedPath } else { "" }'
    )

    try:
        result = subprocess.check_output(
            ["powershell", "-Command", ps_script],
            creationflags=subprocess.CREATE_NO_WINDOW
        ).decode("utf-8").strip()
        if result:
            cmds.textFieldButtonGrp(field, edit=True, text=result.replace("\\", "/"))
    except Exception as e:
        cmds.warning("Windows picker failed, using Maya dialog: {}".format(e))
        fallback = cmds.fileDialog2(dialogStyle=2, fileMode=3, startingDirectory=start_dir or "")
        if fallback:
            cmds.textFieldButtonGrp(field, edit=True, text=fallback[0])


def pick_skeleton_root(*args):
    sel = cmds.ls(selection=True)
    if not sel:
        cmds.warning("Select the root joint first.")
        return
    cmds.textFieldButtonGrp("gloops_skeleton", edit=True, text=sel[0])


def pick_geos(*args):
    sel = cmds.ls(selection=True, long=False)
    if not sel:
        cmds.warning("Select one or more geometry groups/meshes.")
        return
    cmds.textFieldButtonGrp("gloops_geos", edit=True, text=", ".join(sel))


def run_batch_glb_convert(*args):
    """Recursively convert every FBX under the input folder to GLB,
    mirroring the folder structure in the output folder.

    The heavy lifting is done by fbx_to_glb.py running Blender headless
    (which already walks os.walk + relpath, so subfolder layout is
    preserved automatically). The FBX sources are NEVER modified or
    deleted — just copied/converted."""
    input_folder  = cmds.textFieldButtonGrp("glb_input",  q=True, text=True).strip()
    output_folder = cmds.textFieldButtonGrp("glb_output", q=True, text=True).strip()
    compress      = cmds.checkBox("glb_batch_compress", q=True, value=True)
    scale         = cmds.floatSliderGrp("glb_batch_scale", q=True, value=True)

    if not input_folder or not os.path.isdir(input_folder):
        cmds.confirmDialog(title="Error",
                           message="Input folder not found:\n{}".format(input_folder))
        return
    if not output_folder:
        cmds.confirmDialog(title="Error", message="Set an output folder.")
        return

    # Pre-count FBX files so the user knows what they're signing up for
    total = 0
    for dirpath, _, filenames in os.walk(input_folder):
        for fn in filenames:
            if fn.lower().endswith(".fbx"):
                total += 1

    if total == 0:
        cmds.confirmDialog(title="Nothing to do",
                           message="No .fbx file found under:\n{}".format(input_folder))
        return

    result = cmds.confirmDialog(
        title="Confirm Batch GLB Convert",
        message="This will convert {} FBX file(s) to GLB.\n\n"
                "Input:   {}\n"
                "Output:  {}\n"
                "Draco:   {}\n"
                "Scale:   {}\n\n"
                "Folder structure is preserved. Source FBX are untouched.\n"
                "Launches Blender in background — can take a few minutes.".format(
                    total, input_folder, output_folder,
                    "ON" if compress else "OFF", scale),
        button=["Convert", "Cancel"], defaultButton="Convert", cancelButton="Cancel")
    if result != "Convert":
        return

    print("\n========== BATCH FBX → GLB ==========")
    print("Input:    {}".format(input_folder))
    print("Output:   {}".format(output_folder))
    print("Compress: {}".format(compress))
    print("Scale:    {}".format(scale))
    print("Files:    {}".format(total))
    print("=====================================\n")

    ok = convert_folder_to_glb(input_folder, output_folder,
                                compress=compress, scale=scale)

    if ok:
        cmds.confirmDialog(
            title="Done",
            message="Batch conversion finished!\n{} file(s) → {}".format(total, output_folder))
    else:
        cmds.confirmDialog(
            title="Failed",
            message="GLB conversion FAILED.\nCheck Script Editor for details.")


def run_batch_props(*args):
    """Read the current Maya selection (mesh transforms), use the
    Skeleton Root + Target fields, and batch export one FBX per mesh
    (skeleton + that mesh, no animation). Filename = mesh name."""
    target = cmds.textFieldButtonGrp("gloops_target", q=True, text=True).strip()
    skeleton_root = cmds.textFieldButtonGrp("gloops_skeleton", q=True, text=True).strip()

    sel = cmds.ls(selection=True, long=False, type="transform") or []
    # Keep only transforms that have a mesh shape
    meshes = []
    for s in sel:
        shapes = cmds.listRelatives(s, shapes=True, type="mesh") or []
        if shapes:
            meshes.append(s)

    if not meshes:
        cmds.confirmDialog(
            title="Error",
            message="Select one or more MESH transforms in the viewport,\n"
                    "then click 'Batch Export Props' again.")
        return
    if not skeleton_root:
        cmds.confirmDialog(title="Error", message="Pick a Skeleton Root above.")
        return
    if not target:
        cmds.confirmDialog(title="Error",
                           message="Set a Target folder above.\n"
                                   "Tip: point it at fbx/ANIM/<Category>/PROPS/")
        return

    result = cmds.confirmDialog(
        title="Confirm Batch Prop Export",
        message="Export {} mesh(es) as separate FBX files?\n\n"
                "Each file: skeleton + ONE mesh, no animation.\n"
                "Filename = mesh name.\n\n"
                "Target: {}\n"
                "Skeleton: {}\n\n"
                "Scene will be SAVED and reopened between each export.".format(
                    len(meshes), target, skeleton_root),
        button=["Export", "Cancel"], defaultButton="Export", cancelButton="Cancel")
    if result != "Export":
        return

    batch_export_props(target, skeleton_root, meshes)


def run_export(*args):
    source = cmds.textFieldButtonGrp("gloops_source", q=True, text=True).strip()
    target = cmds.textFieldButtonGrp("gloops_target", q=True, text=True).strip()
    skeleton_root = cmds.textFieldButtonGrp("gloops_skeleton", q=True, text=True).strip()
    geos_text = cmds.textFieldButtonGrp("gloops_geos", q=True, text=True).strip()

    selected_radio = cmds.radioCollection("gloops_mode_collection", q=True, select=True)
    mode_map = {
        "gloops_mode_auto": "auto",
        "gloops_mode_first": "first_frame",
        "gloops_mode_anim": "animation"
    }
    export_mode = mode_map.get(selected_radio, "auto")
    update_manifest = cmds.checkBox("gloops_manifest", q=True, value=True)
    clean_bones = cmds.checkBox("gloops_clean_bones", q=True, value=True)
    clean_threshold = cmds.floatSliderGrp("gloops_clean_threshold", q=True, value=True)

    if not source or not os.path.exists(source):
        cmds.confirmDialog(title="Error", message="Source folder not found:\n{}".format(source))
        return
    if not target:
        cmds.confirmDialog(title="Error", message="Set a target folder.")
        return
    if not skeleton_root:
        cmds.confirmDialog(title="Error", message="Pick a skeleton root.")
        return

    # Geometries are OPTIONAL — leaving empty exports the skeleton only
    # (faster, smaller files, ideal for locomotion clips).
    geo_nodes = [g.strip() for g in geos_text.split(",") if g.strip()] if geos_text else []

    # Read the target-fps dropdown
    fps_choice = cmds.optionMenu("gloops_fps", q=True, value=True)
    fps_map = {
        "Keep scene FPS": None,
        "24 fps (film)":  24,
        "25 fps (PAL)":   25,
        "30 fps (NTSC)":  30,
        "48 fps":         48,
        "50 fps":         50,
        "60 fps":         60,
    }
    target_fps = fps_map.get(fps_choice, None)

    result = cmds.confirmDialog(
        title="Confirm Export",
        message="This will export {} items.\n\n"
                "The scene will be SAVED and reopened between each export.\n"
                "Make sure your scene is in a clean state.\n\n"
                "Continue?".format(len(get_items(source))),
        button=["Export", "Cancel"], defaultButton="Export", cancelButton="Cancel")
    if result != "Export":
        return

    convert_glb  = cmds.checkBox("gloops_convert_glb", q=True, value=True)
    glb_compress = cmds.checkBox("gloops_glb_compress", q=True, value=True)
    glb_scale    = cmds.floatSliderGrp("gloops_glb_scale", q=True, value=True)

    export_all(source, target, skeleton_root, geo_nodes, export_mode, update_manifest,
               clean_bones, clean_threshold, target_fps=target_fps,
               convert_glb=convert_glb, glb_compress=glb_compress, glb_scale=glb_scale)


def show_ui():
    if cmds.window(WINDOW_NAME, exists=True):
        cmds.deleteUI(WINDOW_NAME)

    win = cmds.window(WINDOW_NAME, title="Gloops FBX Exporter", widthHeight=(600, 450),
                       sizeable=True)

    cmds.columnLayout(adjustableColumn=True, rowSpacing=6, columnOffset=["both", 10])

    cmds.separator(height=6, style="none")
    cmds.text(label="GLOOPS - Studio Library to FBX", font="boldLabelFont", align="center")
    cmds.separator(height=6, style="in")

    # --- Folders ---
    cmds.text(label="Folders", font="boldLabelFont", align="left")

    cmds.textFieldButtonGrp(
        "gloops_source", label="Source:", text=DEFAULT_SOURCE,
        buttonLabel="Browse...",
        buttonCommand='browse_folder_os("gloops_source")',
        columnWidth3=[90, 390, 80], adjustableColumn=2,
        annotation="Studio Library folder containing .pose / .anim items")

    cmds.textFieldButtonGrp(
        "gloops_target", label="Target:", text=DEFAULT_TARGET,
        buttonLabel="Browse...",
        buttonCommand='browse_folder_os("gloops_target")',
        columnWidth3=[90, 390, 80], adjustableColumn=2,
        annotation="Output folder for FBX files")

    cmds.separator(height=6, style="in")

    # --- Scene Setup ---
    cmds.text(label="Scene Setup", font="boldLabelFont", align="left")

    cmds.textFieldButtonGrp(
        "gloops_skeleton", label="Skeleton Root:", text=DEFAULT_SKELETON,
        buttonLabel="<< Selection",
        buttonCommand='pick_skeleton_root()',
        columnWidth3=[90, 390, 80], adjustableColumn=2,
        annotation="Select the root joint, then click << Selection")

    cmds.textFieldButtonGrp(
        "gloops_geos", label="Geometries:", text=DEFAULT_GEOS,
        buttonLabel="<< Selection",
        buttonCommand='pick_geos()',
        columnWidth3=[90, 390, 80], adjustableColumn=2,
        annotation="Optional! Leave empty to export skeleton only (smaller, faster).\n"
                   "Select meshes/groups to export, then click << Selection.")

    cmds.separator(height=6, style="in")

    # --- Target FPS ---
    cmds.rowLayout(numberOfColumns=2, columnWidth2=[120, 300],
                   columnAttach=[(1, "right", 5), (2, "left", 5)])
    cmds.text(label="Target FPS:", align="right")
    cmds.optionMenu("gloops_fps",
                    annotation="Resample the animation at a target frame rate before exporting.\n"
                               "Three.js is frame-rate independent (runs at whatever refresh\n"
                               "the browser gives), so any of these works — higher = smoother\n"
                               "but larger FBX files.")
    cmds.menuItem(label="Keep scene FPS")
    cmds.menuItem(label="24 fps (film)")
    cmds.menuItem(label="25 fps (PAL)")
    cmds.menuItem(label="30 fps (NTSC)")
    cmds.menuItem(label="48 fps")
    cmds.menuItem(label="50 fps")
    cmds.menuItem(label="60 fps")
    cmds.setParent("..")

    cmds.separator(height=6, style="in")

    # --- Export Mode ---
    cmds.text(label="Export Mode", font="boldLabelFont", align="left")

    cmds.rowLayout(numberOfColumns=3, columnWidth3=[190, 150, 150])
    cmds.radioCollection("gloops_mode_collection")
    cmds.radioButton("gloops_mode_auto", label="Auto (pose=1f, anim=full)", select=True)
    cmds.radioButton("gloops_mode_first", label="First Frame Only")
    cmds.radioButton("gloops_mode_anim", label="Full Animation")
    cmds.setParent("..")

    cmds.separator(height=6, style="in")

    # --- Options ---
    cmds.checkBox("gloops_manifest",
                   label="Update manifest.json (in target's parent folder)",
                   value=True)

    cmds.checkBox("gloops_clean_bones",
                   label="Clean unchanged bones (for overlay anims like Teeths)",
                   value=True,
                   annotation="Removes anim curves from bones that didn't move vs T-pose.\n"
                              "Essential for animations that should layer on top of others.")

    cmds.floatSliderGrp("gloops_clean_threshold",
                         label="Clean Threshold:", field=True,
                         minValue=0.0001, maxValue=0.1, fieldMinValue=0.0001, fieldMaxValue=1.0,
                         value=0.001, step=0.0001,
                         columnWidth3=[100, 60, 200], adjustableColumn=3,
                         annotation="Max delta from T-pose to consider a bone unchanged")

    cmds.separator(height=4, style="in")

    # Auto-convert to GLB via Blender after FBX export
    cmds.checkBox("gloops_convert_glb",
                   label="Auto-convert FBX → GLB (via headless Blender)",
                   value=False,
                   annotation="After exporting the FBX batch, launch Blender\n"
                              "in background mode to convert each file to GLB.\n"
                              "GLB loads ~3x faster in three.js and is smaller.")

    cmds.checkBox("gloops_glb_compress",
                   label="GLB Draco compression (smaller, slower load)",
                   value=True,
                   annotation="Applies Draco mesh compression to the GLB output.\n"
                              "Massive file-size reduction (~70%) at the cost of\n"
                              "a slightly longer browser-side decode.")

    cmds.floatSliderGrp("gloops_glb_scale",
                         label="GLB scale:", field=True,
                         minValue=0.01, maxValue=200.0,
                         fieldMinValue=0.001, fieldMaxValue=1000.0,
                         value=100.0, step=1.0,
                         columnWidth3=[90, 60, 200], adjustableColumn=3,
                         annotation="Uniform scale factor applied in Blender\n"
                                    "before GLB export. Maya FBX exports in cm\n"
                                    "but Blender treats units as meters, so use\n"
                                    "100 to restore the authored size. Use 1.0\n"
                                    "if your FBX is already in meters.")

    cmds.separator(height=8, style="none")

    cmds.button(label="EXPORT", height=40, backgroundColor=[0.2, 0.6, 0.3],
                command=run_export)

    cmds.separator(height=4, style="none")
    cmds.text(label="Scene will be saved and reopened between each export.",
              font="smallPlainLabelFont", align="center")

    # ------------------------------------------------------------
    # Batch Prop Export — independent path (no Studio Library loop)
    # ------------------------------------------------------------
    cmds.separator(height=10, style="in")
    cmds.text(label="Batch Prop Export (skeleton + mesh)",
              font="boldLabelFont", align="left")
    cmds.text(label="Select MESHES in the viewport, set the Target folder above\n"
                    "to point at fbx/ANIM/<Category>/PROPS/, then click below.\n"
                    "One static FBX per mesh, named after the mesh.",
              font="smallPlainLabelFont", align="left")
    cmds.button(label="BATCH EXPORT PROPS",
                height=34, backgroundColor=[0.35, 0.45, 0.7],
                command=run_batch_props,
                annotation="For each selected mesh, export an FBX containing\n"
                           "(skeleton root + that single mesh) with no animation.\n"
                           "Filename = mesh name. Used by the customizer's\n"
                           "Type C paired-prop autodetect (skeleton rebind).")

    # ------------------------------------------------------------
    # Batch FBX -> GLB (recursive folder convert)
    # ------------------------------------------------------------
    cmds.separator(height=10, style="in")
    cmds.text(label="Batch FBX → GLB (recursive folder)",
              font="boldLabelFont", align="left")
    cmds.text(label="Pick a root folder of FBX files (with any subfolders).\n"
                    "Each .fbx is converted to .glb in the output folder,\n"
                    "preserving the exact sub-folder structure.\n"
                    "Source FBX files are NEVER modified or deleted.",
              font="smallPlainLabelFont", align="left")

    cmds.textFieldButtonGrp(
        "glb_input", label="Input FBX:", text=DEFAULT_TARGET,
        buttonLabel="Browse...",
        buttonCommand='browse_folder_os("glb_input")',
        columnWidth3=[90, 390, 80], adjustableColumn=2,
        annotation="Root folder containing .fbx files (recursive)")

    cmds.textFieldButtonGrp(
        "glb_output", label="Output GLB:", text=DEFAULT_TARGET.replace("/FBX/", "/GLB/").replace("/fbx/", "/glb/"),
        buttonLabel="Browse...",
        buttonCommand='browse_folder_os("glb_output")',
        columnWidth3=[90, 390, 80], adjustableColumn=2,
        annotation="Destination folder — sub-folder structure mirrors input")

    cmds.checkBox("glb_batch_compress",
                  label="Draco compression (smaller GLB, slower decode)",
                  value=True,
                  annotation="Applies Draco mesh compression. ~70% smaller files,\n"
                             "slightly longer decode in the browser.")

    cmds.floatSliderGrp("glb_batch_scale",
                         label="Scale:", field=True,
                         minValue=0.01, maxValue=200.0,
                         fieldMinValue=0.001, fieldMaxValue=1000.0,
                         value=100.0, step=1.0,
                         columnWidth3=[90, 60, 200], adjustableColumn=3,
                         annotation="Uniform scale passed to Blender before GLB\n"
                                    "export. Maya-cm FBX → use 100.")

    cmds.button(label="BATCH CONVERT FBX → GLB",
                height=34, backgroundColor=[0.7, 0.45, 0.3],
                command=run_batch_glb_convert,
                annotation="Recursively scan the input folder and convert every .fbx\n"
                           "to .glb in the output folder, preserving subfolder layout.\n"
                           "Runs Blender in background. Original FBX files untouched.")

    cmds.setParent("..")
    cmds.showWindow(win)


# Launch
show_ui()
