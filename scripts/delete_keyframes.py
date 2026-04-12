"""
Delete Keyframes Tool
Select what to clean: all keys, selected controllers, driven keys, blendshapes, etc.

exec(open("H:/Shared drives/GLOOPS/09_GAME/WEB/scripts/delete_keyframes.py").read())
"""

import maya.cmds as cmds

try:
    from PySide6 import QtWidgets, QtCore
    import shiboken6 as shiboken
except ImportError:
    from PySide2 import QtWidgets, QtCore
    import shiboken2 as shiboken

import maya.OpenMayaUI as omui


def get_maya_main_window():
    ptr = omui.MQtUtil.mainWindow()
    return shiboken.wrapInstance(int(ptr), QtWidgets.QWidget)


class DeleteKeysUI(QtWidgets.QDialog):
    def __init__(self, parent=get_maya_main_window()):
        super(DeleteKeysUI, self).__init__(parent)
        self.setWindowTitle("Delete Keyframes")
        self.setMinimumWidth(400)
        self.build_ui()

    def build_ui(self):
        layout = QtWidgets.QVBoxLayout(self)

        # --- Scope ---
        scope_group = QtWidgets.QGroupBox("Scope")
        scope_layout = QtWidgets.QVBoxLayout()
        self.rb_all = QtWidgets.QRadioButton("All objects in scene")
        self.rb_selected = QtWidgets.QRadioButton("Selected objects only")
        self.rb_hierarchy = QtWidgets.QRadioButton("Selected + hierarchy")
        self.rb_selected.setChecked(True)
        scope_layout.addWidget(self.rb_all)
        scope_layout.addWidget(self.rb_selected)
        scope_layout.addWidget(self.rb_hierarchy)
        scope_group.setLayout(scope_layout)
        layout.addWidget(scope_group)

        # --- What to delete ---
        what_group = QtWidgets.QGroupBox("What to delete")
        what_layout = QtWidgets.QVBoxLayout()

        self.cb_anim_curves = QtWidgets.QCheckBox("Animation Curves (translate, rotate, scale)")
        self.cb_anim_curves.setChecked(True)

        self.cb_blendshape_keys = QtWidgets.QCheckBox("Blendshape keyframes")
        self.cb_blendshape_keys.setChecked(True)

        self.cb_driven_keys = QtWidgets.QCheckBox("Set Driven Keys (animCurveUU, animCurveUA, etc.)")
        self.cb_driven_keys.setChecked(False)

        self.cb_constraints = QtWidgets.QCheckBox("Constraint keys")
        self.cb_constraints.setChecked(False)

        self.cb_custom_attrs = QtWidgets.QCheckBox("Custom attribute keys")
        self.cb_custom_attrs.setChecked(True)

        self.cb_visibility = QtWidgets.QCheckBox("Visibility keys")
        self.cb_visibility.setChecked(False)

        what_layout.addWidget(self.cb_anim_curves)
        what_layout.addWidget(self.cb_blendshape_keys)
        what_layout.addWidget(self.cb_driven_keys)
        what_layout.addWidget(self.cb_constraints)
        what_layout.addWidget(self.cb_custom_attrs)
        what_layout.addWidget(self.cb_visibility)
        what_group.setLayout(what_layout)
        layout.addWidget(what_group)

        # --- Time Range ---
        range_group = QtWidgets.QGroupBox("Time Range")
        range_layout = QtWidgets.QVBoxLayout()

        self.rb_all_time = QtWidgets.QRadioButton("All time")
        self.rb_range = QtWidgets.QRadioButton("Frame range:")
        self.rb_all_time.setChecked(True)

        range_h = QtWidgets.QHBoxLayout()
        self.spin_start = QtWidgets.QSpinBox()
        self.spin_start.setRange(-10000, 100000)
        self.spin_start.setValue(int(cmds.playbackOptions(q=True, min=True)))
        self.spin_end = QtWidgets.QSpinBox()
        self.spin_end.setRange(-10000, 100000)
        self.spin_end.setValue(int(cmds.playbackOptions(q=True, max=True)))
        range_h.addWidget(QtWidgets.QLabel("Start:"))
        range_h.addWidget(self.spin_start)
        range_h.addWidget(QtWidgets.QLabel("End:"))
        range_h.addWidget(self.spin_end)

        range_layout.addWidget(self.rb_all_time)
        range_layout.addWidget(self.rb_range)
        range_layout.addLayout(range_h)
        range_group.setLayout(range_layout)
        layout.addWidget(range_group)

        # --- Preview ---
        self.btn_preview = QtWidgets.QPushButton("Preview (count keys)")
        self.btn_preview.clicked.connect(self.preview)
        layout.addWidget(self.btn_preview)

        self.lbl_preview = QtWidgets.QLabel("")
        layout.addWidget(self.lbl_preview)

        # --- Delete ---
        self.btn_delete = QtWidgets.QPushButton("DELETE KEYS")
        self.btn_delete.setStyleSheet("background-color: #cc3333; color: white; font-weight: bold; padding: 10px;")
        self.btn_delete.clicked.connect(self.delete_keys)
        layout.addWidget(self.btn_delete)

        # --- Log ---
        self.log = QtWidgets.QTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumHeight(120)
        layout.addWidget(self.log)

    def _log(self, msg):
        self.log.append(msg)
        print(msg)
        QtWidgets.QApplication.processEvents()

    def _get_objects(self):
        """Get the list of objects based on scope selection."""
        if self.rb_all.isChecked():
            return cmds.ls(dagObjects=True, transforms=True) or []
        elif self.rb_selected.isChecked():
            return cmds.ls(selection=True, long=False) or []
        elif self.rb_hierarchy.isChecked():
            sel = cmds.ls(selection=True, long=False) or []
            result = list(sel)
            for s in sel:
                children = cmds.listRelatives(s, allDescendents=True, type="transform", fullPath=False) or []
                result.extend(children)
                joints = cmds.listRelatives(s, allDescendents=True, type="joint", fullPath=False) or []
                result.extend(joints)
            return list(set(result))
        return []

    def _get_curves(self, objects):
        """Get anim curves to delete based on options."""
        curves = set()

        # Standard anim curve types
        standard_types = []
        if self.cb_anim_curves.isChecked():
            standard_types.extend(["animCurveTL", "animCurveTA", "animCurveTU"])
        if self.cb_visibility.isChecked():
            standard_types.append("animCurveTU")

        driven_types = []
        if self.cb_driven_keys.isChecked():
            driven_types.extend(["animCurveUU", "animCurveUA", "animCurveUL", "animCurveUT"])

        all_types = list(set(standard_types + driven_types))

        for obj in objects:
            # Direct connections
            for curve_type in all_types:
                connected = cmds.listConnections(obj, type=curve_type, source=True, destination=False) or []
                curves.update(connected)

            # History-based (for blendshapes)
            if self.cb_blendshape_keys.isChecked():
                history = cmds.listHistory(obj, pruneDagObjects=True) or []
                for node in history:
                    if cmds.nodeType(node) == "blendShape":
                        targets = cmds.listAttr(node + ".weight", multi=True) or []
                        for t in targets:
                            attr = "{}.{}".format(node, t)
                            for curve_type in all_types:
                                conns = cmds.listConnections(attr, type=curve_type, source=True, destination=False) or []
                                curves.update(conns)

            # Custom attributes
            if self.cb_custom_attrs.isChecked():
                custom = cmds.listAttr(obj, userDefined=True) or []
                for attr in custom:
                    full = "{}.{}".format(obj, attr)
                    if cmds.objExists(full):
                        for curve_type in all_types:
                            conns = cmds.listConnections(full, type=curve_type, source=True, destination=False) or []
                            curves.update(conns)

            # Constraints
            if self.cb_constraints.isChecked():
                constraints = cmds.listRelatives(obj, type="constraint") or []
                for con in constraints:
                    for curve_type in all_types:
                        conns = cmds.listConnections(con, type=curve_type, source=True, destination=False) or []
                        curves.update(conns)

        # Filter driven keys if not selected
        if not self.cb_driven_keys.isChecked():
            filtered = set()
            for c in curves:
                node_type = cmds.nodeType(c)
                if node_type in ["animCurveUU", "animCurveUA", "animCurveUL", "animCurveUT"]:
                    continue
                filtered.add(c)
            curves = filtered

        return curves

    def _filter_time_range(self, curves):
        """If time range is specified, only count/delete keys within range."""
        if self.rb_all_time.isChecked():
            return curves, None, None
        start = self.spin_start.value()
        end = self.spin_end.value()
        return curves, start, end

    def preview(self):
        objects = self._get_objects()
        if not objects:
            self.lbl_preview.setText("No objects found. Select something first.")
            return

        curves = self._get_curves(objects)
        curves, start, end = self._filter_time_range(curves)

        total_keys = 0
        for c in curves:
            if not cmds.objExists(c):
                continue
            if start is not None:
                keys = cmds.keyframe(c, q=True, time=(start, end), timeChange=True) or []
            else:
                keys = cmds.keyframe(c, q=True, timeChange=True) or []
            total_keys += len(keys)

        self.lbl_preview.setText(
            "{} objects | {} anim curves | {} keyframes".format(
                len(objects), len(curves), total_keys))

    def delete_keys(self):
        objects = self._get_objects()
        if not objects:
            cmds.confirmDialog(title="Error", message="No objects found.")
            return

        curves = self._get_curves(objects)
        curves, start, end = self._filter_time_range(curves)

        if not curves:
            cmds.confirmDialog(title="Info", message="No keyframes found to delete.")
            return

        result = cmds.confirmDialog(
            title="Confirm",
            message="Delete {} anim curves on {} objects?".format(len(curves), len(objects)),
            button=["Delete", "Cancel"])
        if result != "Delete":
            return

        cmds.undoInfo(openChunk=True)
        try:
            deleted_curves = 0
            deleted_keys = 0

            for c in curves:
                if not cmds.objExists(c):
                    continue

                if start is not None:
                    # Delete keys in range
                    keys_before = cmds.keyframe(c, q=True, keyframeCount=True) or 0
                    cmds.cutKey(c, time=(start, end))
                    keys_after = cmds.keyframe(c, q=True, keyframeCount=True) or 0
                    deleted_keys += (keys_before - keys_after)
                    # If no keys left, delete the curve
                    if keys_after == 0:
                        cmds.delete(c)
                        deleted_curves += 1
                else:
                    # Delete entire curve
                    num_keys = cmds.keyframe(c, q=True, keyframeCount=True) or 0
                    deleted_keys += num_keys
                    cmds.delete(c)
                    deleted_curves += 1

            self._log("Deleted {} curves, {} keys on {} objects".format(
                deleted_curves, deleted_keys, len(objects)))

        except Exception as e:
            self._log("Error: {}".format(e))
            import traceback
            traceback.print_exc()
        finally:
            cmds.undoInfo(closeChunk=True)

        cmds.confirmDialog(title="Done",
                           message="Deleted {} curves, {} keys.".format(deleted_curves, deleted_keys))


def show_ui():
    for widget in QtWidgets.QApplication.allWidgets():
        if widget.objectName() == "DeleteKeysUI":
            widget.close()
    global _delete_keys_win
    _delete_keys_win = DeleteKeysUI()
    _delete_keys_win.setObjectName("DeleteKeysUI")
    _delete_keys_win.show()


show_ui()
