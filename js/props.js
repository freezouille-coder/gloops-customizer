import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

/**
 * A single attached prop.
 */
class Prop {
    constructor(name, model, bone) {
        this.name = name;
        this.model = model;       // THREE.Group
        this.bone = bone;         // THREE.Bone reference
        this.boneName = bone.name;
        this.action = null;       // Animation action (if prop has animation)
        this.materials = new Map();
    }
}

export class PropsManager {
    constructor(scene, character) {
        this.scene = scene;
        this.character = character;
        this.loader = new FBXLoader();
        this.props = new Map();     // propId -> Prop (active props)
        this.catalog = {};          // from manifest: propName -> { model, animation, bone, category }
        this._boneList = [];
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
     * Load props catalog from manifest.
     */
    loadCatalog(manifestProps) {
        this.catalog = manifestProps || {};
    }

    /**
     * Get catalog grouped by category.
     */
    getCatalogByCategory() {
        const groups = {};
        for (const [name, data] of Object.entries(this.catalog)) {
            const cat = data.category || 'Other';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push({ name, ...data });
        }
        return groups;
    }

    /**
     * Activate a prop from the catalog by name.
     * Loads the model FBX, attaches to bone, and plays animation if exists.
     */
    async activateProp(propName) {
        const catalogEntry = this.catalog[propName];
        if (!catalogEntry) return null;

        // Deactivate existing prop in same category
        const cat = catalogEntry.category || 'Other';
        for (const [id, prop] of this.props) {
            const pCat = this.catalog[prop.name]?.category;
            if (pCat === cat) {
                this.deactivateProp(id);
                break;
            }
        }

        const boneName = catalogEntry.bone || 'head';
        const bone = this.getBone(boneName);
        if (!bone) return null;

        // Load model
        const model = await this._loadFBX('fbx/' + catalogEntry.model);
        if (!model) return null;

        // Fix materials
        model.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                const mat = child.material;
                if (mat) {
                    child.material = new THREE.MeshPhysicalMaterial({
                        color: mat.color || new THREE.Color(0xffffff),
                        roughness: 1.0,
                        metalness: 0,
                        name: mat.name || child.name,
                    });
                }
            }
        });

        // Attach to bone
        bone.add(model);
        model.position.set(0, 0, 0);
        model.rotation.set(0, 0, 0);
        model.scale.set(1, 1, 1);

        const propId = 'prop_' + propName;
        const prop = new Prop(propName, model, bone);

        // Collect materials
        model.traverse((child) => {
            if (child.isMesh && child.material) {
                prop.materials.set(child.material.name || child.name, child.material);
            }
        });

        // Load and play animation if exists
        if (catalogEntry.animation) {
            const animObj = await this._loadFBX('fbx/' + catalogEntry.animation);
            if (animObj && animObj.animations && animObj.animations.length > 0) {
                const clip = animObj.animations[0];
                clip.name = propName + '_anim';

                const mixer = this.character.mixer;
                const action = mixer.clipAction(clip);
                action.setEffectiveWeight(1);
                action.setLoop(THREE.LoopOnce);
                action.clampWhenFinished = true;
                action.play();

                prop.action = action;
                console.log(`Prop animation loaded: ${propName}`);
            }
        }

        this.props.set(propId, prop);
        console.log(`Prop activated: ${propName} -> ${boneName}`);
        return propId;
    }

    /**
     * Deactivate a prop.
     */
    deactivateProp(propId) {
        const prop = this.props.get(propId);
        if (!prop) return;

        // Stop animation
        if (prop.action) {
            prop.action.setEffectiveWeight(0);
            prop.action.stop();
        }

        // Remove model from bone
        prop.bone.remove(prop.model);

        // Dispose
        prop.model.traverse((child) => {
            if (child.isMesh) {
                child.geometry?.dispose();
                child.material?.dispose();
            }
        });

        this.props.delete(propId);
        console.log(`Prop deactivated: ${prop.name}`);
    }

    /**
     * Check if a prop is active.
     */
    isActive(propName) {
        return [...this.props.values()].some(p => p.name === propName);
    }

    /**
     * Get active props.
     */
    getActiveProps() {
        const result = [];
        for (const [id, prop] of this.props) {
            result.push({ id, name: prop.name, boneName: prop.boneName });
        }
        return result;
    }

    /**
     * Set prop offset.
     */
    setPosition(propId, x, y, z) {
        const prop = this.props.get(propId);
        if (prop) prop.model.position.set(x, y, z);
    }

    setRotation(propId, x, y, z) {
        const prop = this.props.get(propId);
        if (prop) prop.model.rotation.set(x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180);
    }

    setScale(propId, s) {
        const prop = this.props.get(propId);
        if (prop) prop.model.scale.setScalar(s);
    }

    /**
     * Load a prop from a File object (custom upload).
     */
    async loadPropFromFile(file, boneName) {
        const bone = this.getBone(boneName);
        if (!bone) throw new Error('Bone not found: ' + boneName);

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const blob = new Blob([e.target.result]);
                const url = URL.createObjectURL(blob);
                this.loader.load(url, (model) => {
                    URL.revokeObjectURL(url);
                    model.traverse(child => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.material = new THREE.MeshPhysicalMaterial({
                                color: child.material?.color || new THREE.Color(0xffffff),
                                roughness: 1, metalness: 0,
                            });
                        }
                    });
                    bone.add(model);
                    const propName = file.name.replace(/\.fbx$/i, '');
                    const propId = 'prop_custom_' + propName;
                    const prop = new Prop(propName, model, bone);
                    this.props.set(propId, prop);
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
     * Load an FBX file. Returns the loaded object or null.
     */
    _loadFBX(url) {
        return new Promise((resolve) => {
            this.loader.load(url,
                (obj) => resolve(obj),
                null,
                () => resolve(null)
            );
        });
    }
}
