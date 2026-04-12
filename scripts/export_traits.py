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
    """Unparent skeleton+geos to world, configure FBX, export."""
    all_nodes = [skeleton_root] + geo_nodes

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
    mel.eval("FBXExportShapes -v {};".format("true" if export_blendshapes else "false"))
    mel.eval("FBXExportSkins -v true;")
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
    print("  >> Exported: {}".format(export_path_clean))


def export_all(source_folder, target_folder, skeleton_root, geo_nodes,
               export_mode, update_manifest, clean_bones=True, clean_threshold=0.001):
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

        # 4. Bake blendshapes
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

    cmds.confirmDialog(title="Done",
                       message="Export finished!\n{}/{} items exported.\n\nCheck Script Editor for details.".format(
                           len(exported), total))


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
    if not geos_text:
        cmds.confirmDialog(title="Error", message="Pick geometries to export.")
        return

    geo_nodes = [g.strip() for g in geos_text.split(",") if g.strip()]

    result = cmds.confirmDialog(
        title="Confirm Export",
        message="This will export {} items.\n\n"
                "The scene will be SAVED and reopened between each export.\n"
                "Make sure your scene is in a clean state.\n\n"
                "Continue?".format(len(get_items(source))),
        button=["Export", "Cancel"], defaultButton="Export", cancelButton="Cancel")
    if result != "Export":
        return

    export_all(source, target, skeleton_root, geo_nodes, export_mode, update_manifest,
               clean_bones, clean_threshold)


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
        annotation="Select meshes/groups to export, then click << Selection")

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

    cmds.separator(height=8, style="none")

    cmds.button(label="EXPORT", height=40, backgroundColor=[0.2, 0.6, 0.3],
                command=run_export)

    cmds.separator(height=4, style="none")
    cmds.text(label="Scene will be saved and reopened between each export.",
              font="smallPlainLabelFont", align="center")

    cmds.setParent("..")
    cmds.showWindow(win)


# Launch
show_ui()
