import maya.cmds as cmds
import maya.OpenMayaUI as omui

try:
    # Maya 2025+ uses PySide6
    from PySide6 import QtWidgets, QtCore
    import shiboken6 as shiboken
except ImportError:
    try:
        # Maya 2022-2024 uses PySide2
        from PySide2 import QtWidgets, QtCore
        import shiboken2 as shiboken
    except ImportError:
        cmds.error("Ce script necessite PySide2 ou PySide6.")

def get_maya_main_window():
    ptr = omui.MQtUtil.mainWindow()
    return shiboken.wrapInstance(int(ptr), QtWidgets.QWidget)

def cleanTargetShapes(target):
    shapes = cmds.listRelatives(target, shapes=True, noIntermediate=True, fullPath=True) or []
    if len(shapes) > 1:
        for s in shapes[1:]:
            cmds.delete(s)
        print("Nettoyage du target : shapes supplementaires supprimes.")

class BlendTransferUI(QtWidgets.QDialog):
    def __init__(self, parent=get_maya_main_window()):
        super(BlendTransferUI, self).__init__(parent)
        self.setWindowTitle("Transfert BlendShape & Skinning")
        self.setMinimumWidth(420)
        self.source = None
        self.target = None
        self.faceCut = None
        self.buildUI()

    def buildUI(self):
        layout = QtWidgets.QVBoxLayout(self)

        selLayout = QtWidgets.QHBoxLayout()
        self.btnSelectSource = QtWidgets.QPushButton("Selectionner Source")
        self.leSource = QtWidgets.QLineEdit()
        self.leSource.setReadOnly(True)
        selLayout.addWidget(self.btnSelectSource)
        selLayout.addWidget(self.leSource)
        layout.addLayout(selLayout)

        selLayout2 = QtWidgets.QHBoxLayout()
        self.btnSelectTarget = QtWidgets.QPushButton("Selectionner Target")
        self.leTarget = QtWidgets.QLineEdit()
        self.leTarget.setReadOnly(True)
        selLayout2.addWidget(self.btnSelectTarget)
        selLayout2.addWidget(self.leTarget)
        layout.addLayout(selLayout2)

        selLayout3 = QtWidgets.QHBoxLayout()
        self.btnSelectFaceCut = QtWidgets.QPushButton("Selectionner FaceCut")
        self.leFaceCut = QtWidgets.QLineEdit()
        self.leFaceCut.setReadOnly(True)
        selLayout3.addWidget(self.btnSelectFaceCut)
        selLayout3.addWidget(self.leFaceCut)
        layout.addLayout(selLayout3)

        self.btnResetWeights = QtWidgets.QPushButton("Reinitialiser poids source")
        layout.addWidget(self.btnResetWeights)

        self.btnTransfertBS = QtWidgets.QPushButton("Transfert BlendShape")
        self.btnTransfertSkin = QtWidgets.QPushButton("Transfert Skinning")
        layout.addWidget(self.btnTransfertBS)
        layout.addWidget(self.btnTransfertSkin)

        self.logLabel = QtWidgets.QLabel("")
        layout.addWidget(self.logLabel)
        self.progressBar = QtWidgets.QProgressBar()
        self.progressBar.setMinimum(0)
        self.progressBar.setMaximum(100)
        self.progressBar.setValue(0)
        layout.addWidget(self.progressBar)

        self.btnSelectSource.clicked.connect(self.selectSource)
        self.btnSelectTarget.clicked.connect(self.selectTarget)
        self.btnSelectFaceCut.clicked.connect(self.selectFaceCut)
        self.btnResetWeights.clicked.connect(self.resetSourceWeights)
        self.btnTransfertBS.clicked.connect(self.transferBlendShape)
        self.btnTransfertSkin.clicked.connect(self.transferSkinning)

    def selectSource(self):
        sel = cmds.ls(selection=True)
        if sel:
            self.source = sel[0]
            self.leSource.setText(self.source)
        else:
            cmds.confirmDialog(title="Erreur", message="Selectionnez un mesh source.")

    def selectTarget(self):
        sel = cmds.ls(selection=True)
        if sel:
            self.target = sel[0]
            self.leTarget.setText(self.target)
        else:
            cmds.confirmDialog(title="Erreur", message="Selectionnez un mesh target.")

    def selectFaceCut(self):
        sel = cmds.ls(selection=True)
        if sel:
            self.faceCut = sel[0]
            self.leFaceCut.setText(self.faceCut)
        else:
            cmds.confirmDialog(title="Erreur", message="Selectionnez un mesh FaceCut.")

    def resetSourceWeights(self):
        if not self.source:
            cmds.confirmDialog(title="Erreur", message="Selectionnez d'abord le mesh source.")
            return
        history = cmds.listHistory(self.source)
        bsNodes = cmds.ls(history, type="blendShape")
        if not bsNodes:
            cmds.confirmDialog(title="Erreur", message="Aucun blendShape trouve sur le source.")
            return
        sourceBS = bsNodes[0]
        aliasList = cmds.aliasAttr(sourceBS, q=True)
        if not aliasList:
            return
        for i in range(0, len(aliasList), 2):
            name = aliasList[i]
            attr = sourceBS + "." + name
            # Disconnect drivers temporarily
            conns = cmds.listConnections(attr, s=True, d=False, p=True) or []
            for src in conns:
                try:
                    cmds.disconnectAttr(src, attr)
                except:
                    pass
            if cmds.getAttr(attr, lock=True):
                cmds.setAttr(attr, lock=False)
            try:
                cmds.setAttr(attr, 0)
            except:
                pass
            # Reconnect
            for src in conns:
                try:
                    cmds.connectAttr(src, attr, f=True)
                except:
                    pass
        self.logLabel.setText("Poids reinitialises.")

    def transferBlendShape(self):
        if not self.source or not self.target:
            cmds.confirmDialog(title="Erreur", message="Source et Target doivent etre selectionnes.")
            return

        dupMesh = self.faceCut if self.faceCut else self.target

        # --- Wrap ---
        try:
            preWrapNodes = set(cmds.ls(type='wrap') or [])
            cmds.select(dupMesh, r=True)
            cmds.select(self.source, add=True)
            self.logLabel.setText("Creation du wrap...")
            QtWidgets.QApplication.processEvents()

            wrapResult = cmds.CreateWrap()
            if wrapResult and len(wrapResult) > 0:
                wrapNode = wrapResult[0]
            else:
                postWrapNodes = set(cmds.ls(type='wrap') or [])
                newWraps = list(postWrapNodes - preWrapNodes)
                if newWraps:
                    wrapNode = newWraps[0]
                else:
                    raise RuntimeError("CreateWrap failed.")

            if cmds.attributeQuery("exclusiveBindOn", node=wrapNode, exists=True):
                cmds.setAttr(wrapNode + ".exclusiveBindOn", 1)
            if cmds.attributeQuery("falloffMode", node=wrapNode, exists=True):
                cmds.setAttr(wrapNode + ".falloffMode", 1)
            print("Wrap cree: {}".format(wrapNode))
        except Exception as e:
            print("Erreur wrap: {}".format(e))
            cmds.confirmDialog(title="Erreur", message="Erreur wrap. Voir Script Editor.")
            return

        # --- Get blendshape source ---
        history = cmds.listHistory(self.source)
        bsNodes = cmds.ls(history, type="blendShape")
        if not bsNodes:
            cmds.confirmDialog(title="Erreur", message="Aucun blendShape sur le source.")
            return
        sourceBS = bsNodes[0]

        # --- Save connections ---
        aliasList = cmds.aliasAttr(sourceBS, q=True)
        if not aliasList:
            cmds.confirmDialog(title="Erreur", message="Aucun alias sur le blendShape source.")
            return

        blendShapeNames = []
        bsConnections = {}
        for i in range(0, len(aliasList), 2):
            name = aliasList[i]
            fullAttr = sourceBS + "." + aliasList[i + 1]
            blendShapeNames.append(name)
            conns = cmds.listConnections(fullAttr, s=True, d=False, plugs=True) or []
            bsConnections[name] = conns
            # Disconnect
            for conn in conns:
                try:
                    cmds.disconnectAttr(conn, fullAttr)
                except:
                    pass

        # Reset all weights to 0
        for name in blendShapeNames:
            attr = sourceBS + "." + name
            if cmds.getAttr(attr, lock=True):
                cmds.setAttr(attr, lock=False)
            try:
                cmds.setAttr(attr, 0)
            except:
                pass

        # --- Extract each target ---
        duplicates = []
        totalShapes = len(blendShapeNames)
        for i, name in enumerate(blendShapeNames):
            self.logLabel.setText("[{}/{}] {}".format(i + 1, totalShapes, name))
            QtWidgets.QApplication.processEvents()

            attr = sourceBS + "." + name
            if cmds.getAttr(attr, lock=True):
                cmds.setAttr(attr, lock=False)
            try:
                cmds.setAttr(attr, 1)
            except Exception as e:
                print("Cannot set {}: {}".format(name, e))

            try:
                dupTrans = cmds.duplicate(dupMesh, name=name + "_tmp")[0]
                dupTrans = cmds.rename(dupTrans, name)
                duplicates.append(dupTrans)
            except Exception as e:
                print("Duplicate error {}: {}".format(name, e))

            try:
                cmds.setAttr(attr, 0)
            except:
                pass

            self.progressBar.setValue(int(100 * (i + 1) / totalShapes))
            QtWidgets.QApplication.processEvents()

        # Delete wrap
        try:
            cmds.delete(wrapNode)
            # Also delete base mesh created by wrap
            baseMeshes = cmds.ls("*Base", type="transform")
            for bm in baseMeshes:
                if cmds.objExists(bm):
                    try:
                        cmds.delete(bm)
                    except:
                        pass
        except:
            pass

        cleanTargetShapes(self.target)

        # --- Create new blendshape on target ---
        try:
            self.logLabel.setText("Creation du blendShape sur target...")
            QtWidgets.QApplication.processEvents()
            newBS = cmds.blendShape(duplicates, self.target,
                                     name="transferedBlendShape",
                                     topologyCheck=False)[0]
            print("Nouveau blendShape: {}".format(newBS))

            for idx, name in enumerate(blendShapeNames):
                try:
                    current = cmds.aliasAttr("{}.weight[{}]".format(newBS, idx), q=True)
                    if current and current != name:
                        cmds.aliasAttr("{}.{}".format(newBS, current), remove=True)
                    cmds.aliasAttr(name, "{}.weight[{}]".format(newBS, idx))
                except:
                    pass
        except Exception as e:
            print("BlendShape creation error: {}".format(e))
            cmds.confirmDialog(title="Erreur", message="Erreur creation blendShape.")
            return

        # --- Reconnect on new BS ---
        for name, conns in bsConnections.items():
            newAttr = newBS + "." + name
            for sourceConn in conns:
                try:
                    cmds.connectAttr(sourceConn, newAttr, f=True)
                except:
                    pass

        # --- Reconnect on SOURCE BS (restore original) ---
        for name, conns in bsConnections.items():
            origAttr = sourceBS + "." + name
            if cmds.objExists(origAttr):
                for sourceConn in conns:
                    try:
                        cmds.connectAttr(sourceConn, origAttr, f=True)
                    except:
                        pass

        # --- Cleanup ---
        try:
            cmds.delete(duplicates)
        except:
            pass

        self.logLabel.setText("Transfert BlendShape termine!")
        self.progressBar.setValue(100)
        cmds.confirmDialog(title="Done", message="Transfert BlendShape termine!")

    def transferSkinning(self):
        if not self.source or not self.target:
            cmds.confirmDialog(title="Erreur", message="Source et Target doivent etre selectionnes.")
            return
        try:
            self.logLabel.setText("Skin transfer...")
            QtWidgets.QApplication.processEvents()

            skinClusters = cmds.ls(cmds.listHistory(self.source), type="skinCluster")
            if not skinClusters:
                cmds.confirmDialog(title="Erreur", message="Aucun skinCluster sur le source.")
                return
            sourceSkin = skinClusters[0]
            influences = cmds.skinCluster(sourceSkin, q=True, inf=True)
            if not influences:
                cmds.confirmDialog(title="Erreur", message="Aucune influence dans le skinCluster source.")
                return

            cleanTargetShapes(self.target)

            cmds.select(influences + [self.target], r=True)
            newSkin = cmds.skinCluster(toSelectedBones=True, bindMethod=0,
                                        skinMethod=0, normalizeWeights=1)[0]

            cmds.copySkinWeights(sourceSkin=sourceSkin, destinationSkin=newSkin,
                                 noMirror=True, surfaceAssociation='closestPoint',
                                 influenceAssociation=['oneToOne', 'closestJoint'])

            self.logLabel.setText("Transfert Skinning termine!")
            cmds.confirmDialog(title="Done", message="Transfert Skinning termine!")
        except Exception as e:
            print("Skin transfer error: {}".format(e))
            cmds.confirmDialog(title="Erreur", message="Erreur skin transfer. Voir Script Editor.")

def showUI():
    for widget in QtWidgets.QApplication.allWidgets():
        if widget.objectName() == "BlendTransferUI":
            widget.close()
    global win
    win = BlendTransferUI()
    win.setObjectName("BlendTransferUI")
    win.show()

showUI()
