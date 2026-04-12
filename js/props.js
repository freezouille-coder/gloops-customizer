import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

/**
 * A single attached prop.
 */
class Prop {
    constructor(name, model, bone, maintainOffset) {
        this.name = name;
        this.model = model;       // THREE.Group
        this.bone = bone;         // THREE.Bone reference
        this.boneName = bone.name;
        this.maintainOffset = maintainOffset;
        this.offset = {
            position: new THREE.Vector3(0, 0, 0),
            rotation: new THREE.Euler(0, 0, 0),
            scale: new THREE.Vector3(1, 1, 1),
        };
        this.materials = new Map(); // materialName -> material
    }
}

export class PropsManager {
    constructor(scene, character) {
        this.scene = scene;
        this.character = character;
        this.loader = new FBXLoader();
        this.props = new Map(); // propId -> Prop
        this._nextId = 0;
        this._boneList = [];

        // Collect all bones from character
        this._collectBones();
    }

    _collectBones() {
        this._boneList = [];
        if (!this.character.model) return;
        this.character.model.traverse((child) => {
            if (child.isBone || child.type === 'Bone') {
                this._boneList.push(child);
            }
        });
        this._boneList.sort((a, b) => a.name.localeCompare(b.name));
    }

    getBoneNames() {
        return this._boneList.map(b => b.name);
    }

    getBone(name) {
        return this._boneList.find(b => b.name === name) || null;
    }

    /**
     * Load a prop FBX from file (File object or URL).
     * Returns a promise with the prop ID.
     */
    async loadProp(file, boneName, maintainOffset = true) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const buffer = e.target.result;
                const blob = new Blob([buffer]);
                const url = URL.createObjectURL(blob);

                this.loader.load(url, (object) => {
                    URL.revokeObjectURL(url);

                    const bone = this.getBone(boneName);
                    if (!bone) {
                        reject(new Error(`Bone "${boneName}" not found`));
                        return;
                    }

                    // Auto-scale prop
                    const box = new THREE.Box3().setFromObject(object);
                    const size = box.getSize(new THREE.Vector3());
                    const maxDim = Math.max(size.x, size.y, size.z);
                    if (maxDim > 2) {
                        object.scale.setScalar(0.5 / maxDim);
                    }

                    // Fix materials
                    object.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                            const mat = child.material;
                            if (mat) {
                                if (mat.color && mat.color.getHSL({}).l < 0.05) {
                                    mat.color.set(0x88aacc);
                                }
                                child.material = new THREE.MeshPhysicalMaterial({
                                    color: mat.color || new THREE.Color(0x88aacc),
                                    roughness: 1.0,
                                    metalness: 0.1,
                                    name: mat.name || child.name,
                                });
                            }
                        }
                    });

                    // Attach to bone
                    const propName = file.name.replace(/\.fbx$/i, '');
                    const propId = 'prop_' + (this._nextId++);

                    if (maintainOffset) {
                        // Parent to bone, keep current world transform
                        bone.add(object);
                    } else {
                        // Parent to bone, reset local transform
                        bone.add(object);
                        object.position.set(0, 0, 0);
                        object.rotation.set(0, 0, 0);
                        object.scale.set(1, 1, 1);
                    }

                    const prop = new Prop(propName, object, bone, maintainOffset);

                    // Collect materials
                    object.traverse((child) => {
                        if (child.isMesh && child.material) {
                            const matName = child.material.name || child.name;
                            prop.materials.set(matName, child.material);
                        }
                    });

                    this.props.set(propId, prop);
                    console.log(`Prop loaded: ${propName} -> ${boneName} (${prop.materials.size} materials)`);
                    resolve(propId);
                }, null, (err) => {
                    URL.revokeObjectURL(url);
                    reject(err);
                });
            };
            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * Remove a prop.
     */
    removeProp(propId) {
        const prop = this.props.get(propId);
        if (!prop) return;
        prop.bone.remove(prop.model);
        // Dispose materials and geometry
        prop.model.traverse((child) => {
            if (child.isMesh) {
                child.geometry?.dispose();
                child.material?.dispose();
            }
        });
        this.props.delete(propId);
    }

    /**
     * Set prop offset.
     */
    setPosition(propId, x, y, z) {
        const prop = this.props.get(propId);
        if (!prop) return;
        prop.model.position.set(x, y, z);
        prop.offset.position.set(x, y, z);
    }

    setRotation(propId, x, y, z) {
        const prop = this.props.get(propId);
        if (!prop) return;
        prop.model.rotation.set(
            x * Math.PI / 180,
            y * Math.PI / 180,
            z * Math.PI / 180
        );
        prop.offset.rotation.set(x, y, z);
    }

    setScale(propId, s) {
        const prop = this.props.get(propId);
        if (!prop) return;
        prop.model.scale.setScalar(s);
        prop.offset.scale.setScalar(s);
    }

    /**
     * Change the bone a prop is attached to.
     */
    reparent(propId, newBoneName) {
        const prop = this.props.get(propId);
        if (!prop) return;
        const newBone = this.getBone(newBoneName);
        if (!newBone) return;

        // Remove from old bone
        prop.bone.remove(prop.model);
        // Add to new bone
        newBone.add(prop.model);
        prop.bone = newBone;
        prop.boneName = newBoneName;
    }

    /**
     * Toggle maintain offset.
     */
    setMaintainOffset(propId, value) {
        const prop = this.props.get(propId);
        if (!prop) return;
        prop.maintainOffset = value;
        if (!value) {
            prop.model.position.set(0, 0, 0);
            prop.model.rotation.set(0, 0, 0);
        }
    }

    /**
     * Get all prop IDs and names.
     */
    getProps() {
        const result = [];
        for (const [id, prop] of this.props) {
            result.push({ id, name: prop.name, boneName: prop.boneName, materials: [...prop.materials.keys()] });
        }
        return result;
    }

    getProp(id) {
        return this.props.get(id) || null;
    }
}
