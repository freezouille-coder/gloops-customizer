"""
Clean FBX animations: remove keyframes from bones that match the T-pose.

Process:
1. Open the base FBX (T-pose) and save all bone transforms as reference
2. For each animation FBX in a folder:
   - Open it
   - Compare each bone's keyframes against the T-pose reference
   - Delete anim curves where ALL keyframes match the T-pose (within threshold)
   - Re-export the cleaned FBX
3. The base FBX is not modified

UI:
- Base FBX (the skeleton T-pose)
- Anim Folder (folder with animation FBX files to clean)
- Threshold
- Export cleaned FBX (overwrite or new folder)

exec(open("H:/Shared drives/GLOOPS/09_GAME/WEB/scripts/clean_fbx_anims.py").read())
"""

import os
import json
import maya.cmds as cmds
import maya.mel as mel

WINDOW_NAME = "cleanFbxWindow"


def capture_tpose_from_fbx(fbx_path):
    """
    Open a base FBX, capture all bone transforms and blendshape values.
    Returns a dict: { 'boneName.attr': value, ... }
    """
    cmds.file(new=True, force=True)

    if not cmds.pluginInfo("fbxmaya", q=True, loaded=True):
        cmds.loadPlugin("fbxmaya", quiet=True)

    mel.eval('FBXImport -f "{}";'.format(fbx_path.replace("\\", "/")))

    reference = {}

    # Capture all joints
    for jnt in cmds.ls(type="joint"):
        for attr in ["tx", "ty", "tz", "rx", "ry", "rz", "sx", "sy", "sz"]:
            full = "{}.{}".format(jnt, attr)
            try:
                reference[full] = cmds.getAttr(full)
            except:
                pass

    # Capture all blendshape weights
    for bs in cmds.ls(type="blendShape"):
        targets = cmds.listAttr(bs + ".weight", multi=True) or []
        for t in targets:
            full = "{}.{}".format(bs, t)
            try:
                reference[full] = cmds.getAttr(full)
            except:
                reference[full] = 0

    print("T-pose reference: {} attributes captured".format(len(reference)))
    return reference


def clean_fbx_file(fbx_path, reference, threshold, output_path):
    """
    Open an animation FBX, remove curves that match the T-pose reference.
    Re-export to output_path.
    """
    cmds.file(new=True, force=True)
    mel.eval('FBXImport -f "{}";'.format(fbx_path.replace("\\", "/")))

    removed = 0
    total = 0
    kept = 0

    # Check all joints
    for jnt in cmds.ls(type="joint"):
        for attr in ["tx", "ty", "tz", "rx", "ry", "rz", "sx", "sy", "sz"]:
            full = "{}.{}".format(jnt, attr)
            curves = cmds.listConnections(full, type="animCurve") or []
            if not curves:
                continue

            total += 1
            ref_val = reference.get(full)
            if ref_val is None:
                kept += 1
                continue

            curve = curves[0]
            key_values = cmds.keyframe(curve, q=True, valueChange=True) or []
            if not key_values:
                continue

            # Check if ALL keyframes match the T-pose value
            max_delta = max(abs(v - ref_val) for v in key_values)
            if max_delta < threshold:
                cmds.delete(curve)
                removed += 1
            else:
                kept += 1

    # Check blendshapes
    for bs in cmds.ls(type="blendShape"):
        targets = cmds.listAttr(bs + ".weight", multi=True) or []
        for t in targets:
            full = "{}.{}".format(bs, t)
            curves = cmds.listConnections(full, type="animCurve") or []
            if not curves:
                continue

            total += 1
            ref_val = reference.get(full, 0)
            curve = curves[0]
            key_values = cmds.keyframe(curve, q=True, valueChange=True) or []
            if not key_values:
                continue

            max_delta = max(abs(v - ref_val) for v in key_values)
            if max_delta < threshold:
                cmds.delete(curve)
                removed += 1
            else:
                kept += 1

    print("  Cleaned: removed {}, kept {}, total {}".format(removed, kept, total))

    # Re-export
    cmds.select(all=True)

    # Get frame range from remaining curves
    all_curves = cmds.ls(type=["animCurveTL", "animCurveTA", "animCurveTU"]) or []
    if all_curves:
        start = float('inf')
        end = float('-inf')
        for c in all_curves:
            keys = cmds.keyframe(c, q=True, timeChange=True) or []
            if keys:
                start = min(start, keys[0])
                end = max(end, keys[-1])
        if start == float('inf'):
            start, end = 1, 1
    else:
        start, end = 1, 1

    mel.eval("FBXResetExport;")
    mel.eval("FBXExportBakeComplexAnimation -v true;")
    mel.eval("FBXExportBakeComplexStart -v {};".format(int(start)))
    mel.eval("FBXExportBakeComplexEnd -v {};".format(int(end)))
    mel.eval("FBXExportBakeComplexStep -v 1;")
    mel.eval("FBXExportSmoothingGroups -v true;")
    mel.eval("FBXExportSmoothMesh -v true;")
    mel.eval("FBXExportShapes -v true;")
    mel.eval("FBXExportSkins -v true;")
    mel.eval("FBXExportInputConnections -v false;")
    mel.eval("FBXExportConstraints -v false;")
    mel.eval("FBXExportCameras -v false;")
    mel.eval("FBXExportLights -v false;")
    mel.eval("FBXExportEmbeddedTextures -v false;")

    mel.eval('FBXExport -f "{}" -s;'.format(output_path.replace("\\", "/")))
    print("  Exported: {}".format(output_path))

    return removed, kept


def run_clean(base_fbx, anim_folder, threshold, overwrite):
    """Main cleaning loop."""
    if not os.path.exists(base_fbx):
        cmds.confirmDialog(title="Error", message="Base FBX not found:\n{}".format(base_fbx))
        return
    if not os.path.exists(anim_folder):
        cmds.confirmDialog(title="Error", message="Anim folder not found:\n{}".format(anim_folder))
        return

    # Step 1: Capture T-pose reference
    print("\n========== CLEAN FBX ANIMS ==========")
    print("Base: {}".format(base_fbx))
    print("Folder: {}".format(anim_folder))
    print("Threshold: {}".format(threshold))
    print("======================================\n")

    print("Capturing T-pose reference...")
    reference = capture_tpose_from_fbx(base_fbx)

    # Step 2: Process each FBX in the folder
    fbx_files = sorted([f for f in os.listdir(anim_folder) if f.lower().endswith('.fbx')])
    if not fbx_files:
        cmds.confirmDialog(title="Error", message="No FBX files found in folder.")
        return

    output_folder = anim_folder
    if not overwrite:
        output_folder = os.path.join(anim_folder, "cleaned")
        if not os.path.exists(output_folder):
            os.makedirs(output_folder)

    total_removed = 0
    total_kept = 0

    cmds.progressWindow(title="Cleaning FBX", progress=0, maxValue=len(fbx_files),
                        isInterruptable=True)

    for i, filename in enumerate(fbx_files):
        if cmds.progressWindow(q=True, isCancelled=True):
            break

        cmds.progressWindow(e=True, progress=i,
                            status="[{}/{}] {}".format(i+1, len(fbx_files), filename))

        fbx_path = os.path.join(anim_folder, filename)
        output_path = os.path.join(output_folder, filename)

        print("\n[{}/{}] {}".format(i+1, len(fbx_files), filename))

        removed, kept = clean_fbx_file(fbx_path, reference, threshold, output_path)
        total_removed += removed
        total_kept += kept

    cmds.progressWindow(endProgress=True)

    print("\n========== DONE ==========")
    print("Total: removed {} curves, kept {}".format(total_removed, total_kept))
    print("Output: {}".format(output_folder))

    cmds.confirmDialog(title="Done",
                       message="Cleaned {} FBX files.\nRemoved {} curves, kept {}.".format(
                           len(fbx_files), total_removed, total_kept))


# ============================================================
# UI
# ============================================================

def browse_file(field):
    result = cmds.fileDialog2(fileFilter="FBX Files (*.fbx)", dialogStyle=2, fileMode=1)
    if result:
        cmds.textFieldButtonGrp(field, edit=True, text=result[0])


def browse_folder(field):
    import subprocess
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
        'if ($dlg.ShowDialog() -eq "OK") { $dlg.SelectedPath } else { "" }'
    )
    try:
        result = subprocess.check_output(
            ["powershell", "-Command", ps_script],
            creationflags=subprocess.CREATE_NO_WINDOW
        ).decode("utf-8").strip()
        if result:
            cmds.textFieldButtonGrp(field, edit=True, text=result.replace("\\", "/"))
    except:
        fallback = cmds.fileDialog2(dialogStyle=2, fileMode=3, startingDirectory=start_dir or "")
        if fallback:
            cmds.textFieldButtonGrp(field, edit=True, text=fallback[0])


def run_from_ui(*args):
    base = cmds.textFieldButtonGrp("cfbx_base", q=True, text=True).strip()
    folder = cmds.textFieldButtonGrp("cfbx_folder", q=True, text=True).strip()
    threshold = cmds.floatSliderGrp("cfbx_threshold", q=True, value=True)
    overwrite = cmds.checkBox("cfbx_overwrite", q=True, value=True)

    result = cmds.confirmDialog(
        title="Confirm",
        message="Clean {} FBX files?\nThreshold: {}\n{}".format(
            len([f for f in os.listdir(folder) if f.lower().endswith('.fbx')]) if os.path.exists(folder) else 0,
            threshold,
            "OVERWRITE originals" if overwrite else "Output to /cleaned subfolder"),
        button=["Go", "Cancel"])
    if result != "Go":
        return

    run_clean(base, folder, threshold, overwrite)


def show_ui():
    if cmds.window(WINDOW_NAME, exists=True):
        cmds.deleteUI(WINDOW_NAME)

    win = cmds.window(WINDOW_NAME, title="Clean FBX Animations",
                       widthHeight=(600, 280), sizeable=True)

    cmds.columnLayout(adjustableColumn=True, rowSpacing=6, columnOffset=["both", 10])

    cmds.separator(height=6, style="none")
    cmds.text(label="Clean FBX Animations (Remove T-pose bones)", font="boldLabelFont", align="center")
    cmds.separator(height=6, style="in")

    cmds.textFieldButtonGrp(
        "cfbx_base", label="Base FBX (T-pose):",
        text="H:/Shared drives/GLOOPS/09_GAME/WEB/FBX/Gloops_skeleton.fbx",
        buttonLabel="Browse...",
        buttonCommand='browse_file("cfbx_base")',
        columnWidth3=[110, 370, 80], adjustableColumn=2)

    cmds.textFieldButtonGrp(
        "cfbx_folder", label="Anim Folder:",
        text="H:/Shared drives/GLOOPS/09_GAME/WEB/FBX/ANIM/Teeths",
        buttonLabel="Browse...",
        buttonCommand='browse_folder("cfbx_folder")',
        columnWidth3=[110, 370, 80], adjustableColumn=2)

    cmds.separator(height=6, style="in")

    cmds.floatSliderGrp("cfbx_threshold",
                         label="Threshold:", field=True,
                         minValue=0.0001, maxValue=1.0,
                         fieldMinValue=0.0001, fieldMaxValue=10.0,
                         value=0.01, step=0.001,
                         columnWidth3=[110, 60, 200], adjustableColumn=3,
                         annotation="Max delta from T-pose to consider unchanged")

    cmds.checkBox("cfbx_overwrite",
                   label="Overwrite original FBX files",
                   value=True,
                   annotation="If unchecked, outputs to a /cleaned subfolder")

    cmds.separator(height=8, style="none")

    cmds.button(label="CLEAN", height=40, backgroundColor=[0.6, 0.3, 0.2],
                command=run_from_ui)

    cmds.separator(height=4, style="none")
    cmds.text(label="Opens each FBX, compares with T-pose, removes unchanged curves, re-exports.",
              font="smallPlainLabelFont", align="center")

    cmds.setParent("..")
    cmds.showWindow(win)


show_ui()
