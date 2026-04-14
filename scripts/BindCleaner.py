"""
BindCleaner.py — Maya utility

Rebuilds the bindPose of the currently-selected joint hierarchy and
disconnects any joint that still has incoming animation on
translate / rotate / scale (those should not contribute to the bind
pose).

Usage:
    1. Select the root joint (or any joint in the hierarchy).
    2. Run the script.

Compatible with Maya's Python 3 environment (Maya 2022+).
"""

import maya.cmds as cmds


def clean_bindpose():
    # --- 1. Delete existing bindPose nodes ---
    existing = cmds.ls("*bindPose*") or []
    if existing:
        cmds.delete(existing)
        print("[BindCleaner] Deleted {} existing bindPose node(s): {}".format(
            len(existing), existing))
    else:
        print("[BindCleaner] No existing bindPose to delete")

    # --- 2. Create a fresh bindPose from the current selection ---
    sel = cmds.ls(selection=True) or []
    if not sel:
        cmds.warning("[BindCleaner] Nothing selected — aborting.")
        return
    cmds.dagPose(sel, bindPose=True, save=True)

    # --- 3. Find the newly-created bindPose node(s) and inspect joints ---
    bindposes = cmds.ls("*bindPose*") or []
    if not bindposes:
        cmds.warning("[BindCleaner] No bindPose found after dagPose() — "
                     "your selection probably wasn't a joint hierarchy.")
        return

    disconnected_count = 0
    for bp_node in bindposes:
        joints = cmds.listConnections(bp_node + ".worldMatrix") or []
        for joint in joints:
            # Does this joint have incoming animation on TRS?
            has_rot   = cmds.listConnections(joint + ".rotate",    s=True, d=False)
            has_trans = cmds.listConnections(joint + ".translate", s=True, d=False)
            has_scale = cmds.listConnections(joint + ".scale",     s=True, d=False)
            if not (has_rot or has_trans or has_scale):
                continue

            # Disconnect the joint.bindPose → bindPose.worldMatrix[*] connection
            bp_cons  = cmds.listConnections(joint + ".bindPose", plugs=True) or []
            msg_cons = cmds.listConnections(joint + ".message",  plugs=True) or []

            for con in bp_cons:
                try:
                    cmds.disconnectAttr(joint + ".bindPose", con)
                    print("[BindCleaner] disconnected {}.bindPose -> {}".format(joint, con))
                    disconnected_count += 1
                except RuntimeError as e:
                    cmds.warning("[BindCleaner] could not disconnect bindPose on {}: {}".format(joint, e))

            for con in msg_cons:
                try:
                    cmds.disconnectAttr(joint + ".message", con)
                    print("[BindCleaner] disconnected {}.message -> {}".format(joint, con))
                    disconnected_count += 1
                except RuntimeError as e:
                    cmds.warning("[BindCleaner] could not disconnect message on {}: {}".format(joint, e))

    print("[BindCleaner] Done. {} connection(s) removed.".format(disconnected_count))


if __name__ == "__main__":
    clean_bindpose()
