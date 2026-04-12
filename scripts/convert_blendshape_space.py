"""
Rebuild blendshape targets in Object Space.
Select the source mesh, run the script.

The source mesh stays intact. Blendshapes are rebuilt with same names and connections.

exec(open("H:/Shared drives/GLOOPS/09_GAME/WEB/scripts/convert_blendshape_space.py").read())
"""

import maya.cmds as cmds

WINDOW_NAME = "bsConvertWindow"


def force_set_attr(attr, value):
    """Force set an attribute by temporarily disconnecting drivers."""
    if cmds.getAttr(attr, lock=True):
        cmds.setAttr(attr, lock=False)
    conns = cmds.listConnections(attr, source=True, destination=False,
                                  plugs=True, connections=False) or []
    disconnected = []
    for src in conns:
        try:
            cmds.disconnectAttr(src, attr)
            disconnected.append(src)
        except:
            pass
    cmds.setAttr(attr, value)
    for src in disconnected:
        try:
            cmds.connectAttr(src, attr, force=True)
        except:
            pass


def rebuild_blendshapes(source_mesh):
    """Rebuild all blendshapes on source_mesh in Object Space."""

    history = cmds.listHistory(source_mesh, pruneDagObjects=True) or []
    bs_nodes = [n for n in history if cmds.nodeType(n) == "blendShape"]

    if not bs_nodes:
        cmds.warning("No blendshapes found on {}".format(source_mesh))
        return

    cmds.undoInfo(openChunk=True)

    try:
        for bs_node in bs_nodes:
            print("\n========== Rebuilding: {} ==========".format(bs_node))

            targets = cmds.listAttr(bs_node + ".weight", multi=True) or []
            if not targets:
                print("  No targets, skipping.")
                continue

            # --- 1. Save connections on each weight ---
            all_connections = {}
            for t in targets:
                attr = "{}.{}".format(bs_node, t)
                saved = []
                for src in (cmds.listConnections(attr, s=True, d=False, p=True) or []):
                    saved.append(("in", src, attr))
                for dest in (cmds.listConnections(attr, s=False, d=True, p=True) or []):
                    saved.append(("out", attr, dest))
                if saved:
                    all_connections[t] = saved

            envelope_val = cmds.getAttr(bs_node + ".envelope")

            # Save original weight values
            original_values = {}
            for t in targets:
                try:
                    original_values[t] = cmds.getAttr("{}.{}".format(bs_node, t))
                except:
                    original_values[t] = 0

            # --- 2. Find deformer order (to restore later) ---
            all_deformers = cmds.listHistory(source_mesh, pruneDagObjects=True, interestLevel=1) or []
            deformer_stack = [d for d in all_deformers
                              if cmds.nodeType(d) in ["skinCluster", "blendShape", "cluster",
                                                       "nonLinear", "ffd", "wrap", "shrinkWrap"]]
            # In listHistory, index 0 = evaluated last (closest to output)
            # We need to know what was ABOVE the blendshape (evaluated after it)
            bs_index = None
            for i, d in enumerate(deformer_stack):
                if d == bs_node:
                    bs_index = i
                    break

            print("  Deformer stack: {}".format(deformer_stack))
            print("  BS at index: {}".format(bs_index))

            # --- 3. Reset all weights to 0 ---
            for t in targets:
                force_set_attr("{}.{}".format(bs_node, t), 0)

            # --- 4. For each target: activate, duplicate source, clean ---
            new_meshes = []
            new_names = []

            cmds.progressWindow(title="Rebuilding BS", progress=0,
                                maxValue=len(targets), isInterruptable=True)

            for idx, t in enumerate(targets):
                if cmds.progressWindow(q=True, isCancelled=True):
                    break

                cmds.progressWindow(e=True, progress=idx,
                                    status="[{}/{}] {}".format(idx+1, len(targets), t))

                attr = "{}.{}".format(bs_node, t)

                # Set this target to 1
                force_set_attr(attr, 1)

                # Duplicate source mesh in deformed state
                dup = cmds.duplicate(source_mesh, name="temp_bs__{}".format(t))[0]

                # Reset target
                force_set_attr(attr, 0)

                # Remove ALL deformers from the duplicate
                dup_history = cmds.listHistory(dup, pruneDagObjects=True) or []
                for node in dup_history:
                    node_type = cmds.nodeType(node)
                    if node_type in ["skinCluster", "blendShape", "cluster",
                                      "nonLinear", "ffd", "wrap", "tweak",
                                      "shrinkWrap", "deltaMush", "tension"]:
                        try:
                            cmds.delete(node)
                        except:
                            pass

                new_meshes.append(dup)
                new_names.append(t)
                print("  [{}] {} -> {}".format(idx+1, t, dup))

            cmds.progressWindow(endProgress=True)

            if not new_meshes:
                cmds.warning("No targets generated!")
                continue

            # --- 5. Disconnect old connections ---
            for t in targets:
                attr = "{}.{}".format(bs_node, t)
                for src in (cmds.listConnections(attr, s=True, d=False, p=True) or []):
                    try: cmds.disconnectAttr(src, attr)
                    except: pass
                for dest in (cmds.listConnections(attr, s=False, d=True, p=True) or []):
                    try: cmds.disconnectAttr(attr, dest)
                    except: pass

            # --- 6. Delete old blendshape ---
            cmds.delete(bs_node)
            print("\n  Deleted: {}".format(bs_node))

            # --- 7. Create new blendshape (Object Space, default position) ---
            new_bs = cmds.blendShape(new_meshes, source_mesh,
                                      name=bs_node, origin="world")[0]
            print("  Created: {}".format(new_bs))

            # --- 8. Reorder deformers to restore original stack ---
            # The new blendshape is at the top. We need to move it back.
            # Find the skinCluster (or whatever was above it)
            current_deformers = cmds.listHistory(source_mesh, pruneDagObjects=True, interestLevel=1) or []
            current_stack = [d for d in current_deformers
                             if cmds.nodeType(d) in ["skinCluster", "blendShape", "cluster",
                                                      "nonLinear", "ffd", "wrap", "shrinkWrap"]]

            # Find skinCluster
            skin_cluster = None
            for d in current_stack:
                if cmds.nodeType(d) == "skinCluster":
                    skin_cluster = d
                    break

            if skin_cluster and bs_index is not None:
                # Reorder: put blendshape after skinCluster
                try:
                    cmds.reorderDeformers(skin_cluster, new_bs, source_mesh)
                    print("  Reordered: {} after {}".format(new_bs, skin_cluster))
                except Exception as e:
                    print("  Could not reorder: {}".format(e))

            # --- 9. Rename weight aliases ---
            for i, name in enumerate(new_names):
                try:
                    current = cmds.aliasAttr("{}.weight[{}]".format(new_bs, i), q=True)
                    if current and current != name:
                        cmds.aliasAttr("{}.{}".format(new_bs, current), remove=True)
                    cmds.aliasAttr(name, "{}.weight[{}]".format(new_bs, i))
                except Exception as e:
                    print("  Alias error [{}] {}: {}".format(i, name, e))

            # Restore envelope
            cmds.setAttr(new_bs + ".envelope", envelope_val)

            # --- 10. Restore connections (using NEW node name) ---
            restored = 0
            for t, conn_list in all_connections.items():
                new_attr = "{}.{}".format(new_bs, t)
                if not cmds.objExists(new_attr):
                    print("  WARNING: {} not found".format(new_attr))
                    continue
                for direction, plug_a, plug_b in conn_list:
                    try:
                        if direction == "in":
                            cmds.connectAttr(plug_a, new_attr, force=True)
                        else:
                            cmds.connectAttr(new_attr, plug_b, force=True)
                        restored += 1
                    except Exception as e:
                        print("  Connect error: {}".format(e))
            print("  Restored {} connections".format(restored))

            # --- 11. Restore original values (where not driven) ---
            for t, val in original_values.items():
                attr = "{}.{}".format(new_bs, t)
                try:
                    if not cmds.listConnections(attr, s=True, d=False):
                        cmds.setAttr(attr, val)
                except:
                    pass

            # --- 12. Delete temp meshes ---
            for m in new_meshes:
                if cmds.objExists(m):
                    cmds.delete(m)

            print("\n  DONE! {} targets rebuilt in Object Space".format(len(new_meshes)))

    except Exception as e:
        import traceback
        traceback.print_exc()
        cmds.warning("Error: {}".format(e))
    finally:
        cmds.undoInfo(closeChunk=True)


# ============================================================
# UI
# ============================================================

def pick_field(field_name):
    sel = cmds.ls(selection=True)
    if sel:
        cmds.textFieldButtonGrp(field_name, edit=True, text=sel[0])


def run_convert(*args):
    source = cmds.textFieldButtonGrp("bsc_source", q=True, text=True).strip()
    if not source or not cmds.objExists(source):
        cmds.confirmDialog(title="Error", message="Source mesh not found: {}".format(source))
        return

    result = cmds.confirmDialog(
        title="Confirm",
        message="Rebuild blendshapes on:\n  {}\n\nSave your scene first!".format(source),
        button=["Go", "Cancel"], defaultButton="Go", cancelButton="Cancel")
    if result != "Go":
        return

    rebuild_blendshapes(source)
    cmds.confirmDialog(title="Done", message="Blendshapes rebuilt in Object Space!")


def show_ui():
    if cmds.window(WINDOW_NAME, exists=True):
        cmds.deleteUI(WINDOW_NAME)

    win = cmds.window(WINDOW_NAME, title="BS Space Converter",
                       widthHeight=(450, 180), sizeable=True)

    cmds.columnLayout(adjustableColumn=True, rowSpacing=6, columnOffset=["both", 10])

    cmds.separator(height=6, style="none")
    cmds.text(label="Blendshape -> Object Space", font="boldLabelFont", align="center")
    cmds.separator(height=6, style="in")

    cmds.textFieldButtonGrp(
        "bsc_source", label="Source Mesh:", text="",
        buttonLabel="<< Sel",
        buttonCommand='pick_field("bsc_source")',
        columnWidth3=[90, 260, 60], adjustableColumn=2,
        annotation="Mesh with blendshapes to rebuild")

    cmds.separator(height=4, style="none")
    cmds.text(label="Rebuilds all blendshapes in Object Space, same names & connections.",
              font="smallPlainLabelFont", align="center")
    cmds.text(label="Source mesh stays intact. Save first!",
              font="smallBoldLabelFont", align="center")

    cmds.separator(height=8, style="none")
    cmds.button(label="CONVERT", height=40, backgroundColor=[0.2, 0.6, 0.3],
                command=run_convert)

    cmds.setParent("..")
    cmds.showWindow(win)


show_ui()
