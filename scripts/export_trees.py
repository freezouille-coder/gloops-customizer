"""
Gloops - Export transforms to JSON for three.js instancing.

Use case:
    1. Bake your MASH network (MASH menu → Bake Instancer)
       OR convert your Yeti output to transforms.
    2. Select all the resulting transform nodes.
    3. Run this script — it opens a dialog to pick a prefab type +
       output file.
    4. Drop the resulting .json in WEB/assets/trees/ — the game will
       load it and instance the meshes.

Run from Maya Script Editor (Python):
    exec(open("H:/Shared drives/GLOOPS/09_GAME/WEB/scripts/export_trees.py").read())
"""

import os
import json
import maya.cmds as cmds


DEFAULT_TARGET_DIR = "H:/Shared drives/GLOOPS/09_GAME/WEB/assets/trees"
DEFAULT_PREFAB = "pine"


def export_selection_to_json(prefab, output_path, scale_multiplier=1.0,
                             world_space=True):
    """
    Walks the current Maya selection, reads each transform's world
    position / Y rotation / uniform scale, and writes a JSON file.

    Format:
        {
            "prefab": "pine",
            "count":  32,
            "items": [
                { "x": 1.5, "y": 0.0, "z": 2.3, "ry": 0.52, "s": 1.1 },
                ...
            ]
        }
    """
    sel = cmds.ls(selection=True, long=False, dag=True, type="transform") or []
    # Filter out any that are parents of another selected transform
    # (we only want leaf transforms / instance placeholders).
    leaves = []
    for node in sel:
        children = cmds.listRelatives(node, children=True, type="transform") or []
        has_transform_child = any(c in sel for c in children)
        if not has_transform_child:
            leaves.append(node)

    if not leaves:
        cmds.warning("[export_trees] No leaf transforms selected. "
                     "Select the MASH-baked instances, then run.")
        return 0

    items = []
    for node in leaves:
        try:
            if world_space:
                pos = cmds.xform(node, q=True, worldSpace=True, translation=True)
                rot = cmds.xform(node, q=True, worldSpace=True, rotation=True)
                scl = cmds.xform(node, q=True, worldSpace=True, relative=False, scale=True)
            else:
                pos = cmds.getAttr(node + ".translate")[0]
                rot = cmds.getAttr(node + ".rotate")[0]
                scl = cmds.getAttr(node + ".scale")[0]

            # Maya rotations are in degrees → convert to radians for three.js
            import math
            ry_rad = math.radians(rot[1])

            # Uniform scale = average (or just X if you know it's uniform)
            s = (abs(scl[0]) + abs(scl[1]) + abs(scl[2])) / 3.0 * scale_multiplier

            items.append({
                "x": round(pos[0], 4),
                "y": round(pos[1], 4),
                "z": round(pos[2], 4),
                "ry": round(ry_rad, 4),
                "s": round(s, 4),
            })
        except Exception as e:
            cmds.warning("[export_trees] skip {} ({})".format(node, e))

    out_dir = os.path.dirname(output_path)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir)

    data = {
        "prefab": prefab,
        "count": len(items),
        "items": items,
    }
    with open(output_path, "w") as f:
        json.dump(data, f, indent=2)

    print("[export_trees] wrote {} items ({}) → {}".format(
        len(items), prefab, output_path))
    return len(items)


# ============================================================
# UI
# ============================================================

WINDOW_NAME = "gloopsTreeExporter"


def _run_export(*args):
    prefab = cmds.textFieldGrp("gte_prefab", q=True, text=True).strip()
    path   = cmds.textFieldGrp("gte_output", q=True, text=True).strip()
    scale  = cmds.floatFieldGrp("gte_scale", q=True, value1=True)
    ws     = cmds.checkBoxGrp("gte_worldspace", q=True, value1=True)

    if not prefab:
        cmds.confirmDialog(title="Error", message="Pick a prefab name.")
        return
    if not path.endswith(".json"):
        path = path + ".json"

    n = export_selection_to_json(prefab, path, scale, world_space=ws)
    if n:
        cmds.confirmDialog(title="Exported",
                           message="Exported {} items to\n{}".format(n, path))


def _browse_output(*args):
    current = cmds.textFieldGrp("gte_output", q=True, text=True).strip() or DEFAULT_TARGET_DIR
    start_dir = current if os.path.exists(os.path.dirname(current)) else DEFAULT_TARGET_DIR
    result = cmds.fileDialog2(dialogStyle=2, fileMode=0,
                              startingDirectory=start_dir,
                              fileFilter="JSON Files (*.json)")
    if result:
        cmds.textFieldGrp("gte_output", edit=True, text=result[0])


def show_ui():
    if cmds.window(WINDOW_NAME, exists=True):
        cmds.deleteUI(WINDOW_NAME)

    win = cmds.window(WINDOW_NAME, title="Gloops Tree Exporter",
                      widthHeight=(500, 240), sizeable=True)
    cmds.columnLayout(adjustableColumn=True, rowSpacing=6, columnOffset=["both", 10])

    cmds.separator(height=6, style="none")
    cmds.text(label="GLOOPS — Transforms → JSON (for three.js instancing)",
              font="boldLabelFont", align="center")
    cmds.separator(height=6, style="in")

    cmds.textFieldGrp("gte_prefab", label="Prefab type:", text=DEFAULT_PREFAB,
                      columnWidth2=[100, 300], adjustableColumn=2,
                      annotation='Name of the prefab in the game code: "pine", "oak", "rock", etc.')

    default_out = os.path.join(DEFAULT_TARGET_DIR, DEFAULT_PREFAB + ".json").replace("\\", "/")
    cmds.rowLayout(numberOfColumns=3, columnWidth3=[100, 340, 50],
                   columnAttach=[(1, "right", 5), (2, "both", 2), (3, "both", 2)])
    cmds.text(label="Output JSON:", align="right")
    cmds.textFieldGrp("gte_output", text=default_out,
                      columnWidth2=[1, 330], adjustableColumn=2, label="")
    cmds.button(label="...", command=_browse_output)
    cmds.setParent("..")

    cmds.floatFieldGrp("gte_scale", label="Scale multiplier:", numberOfFields=1,
                       value1=1.0,
                       columnWidth2=[100, 100],
                       annotation="Multiplied into the per-instance scale. Use 1.0 unless you want global tuning.")

    cmds.checkBoxGrp("gte_worldspace", label="Use world space:",
                     value1=True, columnWidth2=[100, 100],
                     annotation="World = MASH root absolute. "
                                "Local = relative to each transform's parent.")

    cmds.separator(height=8, style="none")

    cmds.button(label="EXPORT SELECTION", height=36,
                backgroundColor=[0.2, 0.6, 0.3], command=_run_export)

    cmds.separator(height=6, style="none")
    cmds.text(label="Select the baked instances first (MASH → Bake Instancer).",
              font="smallPlainLabelFont", align="center")

    cmds.setParent("..")
    cmds.showWindow(win)


show_ui()
