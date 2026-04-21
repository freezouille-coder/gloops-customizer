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
     * Load the paired-props lookup table (built by
     * `scripts/build_props_manifest.py`). Maps
     *   "Category/filename.fbx" -> "ANIM/Category/PROPS/filename.fbx"
     */
    loadPairedManifest(pairedProps) {
        this.pairedManifest = pairedProps || {};
        // propId -> { category, filename } so we can clean up old paired
        // props when the player switches animations in the same category.
        this.pairedActive = new Map();
    }

    /**
     * Load per-prop transform offsets. Keys can be exact
     * "Category/filename.fbx" or wildcards "Category/*".
     * Format: { rotation:[deg,deg,deg], position:[x,y,z], scale:n|[x,y,z] }
     */
    loadPairedOffsets(offsets) {
        this.pairedOffsets = offsets || {};
    }

    /** Wire the ShadingManager so paired-prop materials show up in the MAT panel. */
    setShadingManager(sm) {
        this.shadingManager = sm;
    }

    /** Base asset folder (`fbx` or `glb`) — set by app.js at boot. */
    setAssetRoot(root) {
        this.assetRoot = root;
    }

    /** Look up the offset for a given category/filename. Returns null if none. */
    _lookupOffset(category, filename) {
        if (!this.pairedOffsets) return null;
        const exact = this.pairedOffsets[`${category}/${filename}`];
        if (exact) return exact;
        const wildcard = this.pairedOffsets[`${category}/*`];
        if (wildcard) return wildcard;
        return null;
    }

    /** Subscribe to paired-prop add/remove/update events. */
    onPairedChange(callback) {
        this._pairedChangeCb = callback;
    }
    _firePairedChange() {
        if (this._pairedChangeCb) this._pairedChangeCb();
    }

    /** Returns [{propId, category, filename, type, offset}] for every active paired prop. */
    getActivePaired() {
        const out = [];
        if (!this.pairedActive) return out;
        for (const [propId, info] of this.pairedActive) {
            const prop = this.props.get(propId);
            if (!prop) continue;
            out.push({
                propId,
                category: info.category,
                filename: info.filename,
                type: prop.pairedType,
                offset: info.offset || { rotation: [0, 0, 0], position: [0, 0, 0], scale: 1 },
            });
        }
        return out;
    }

    /**
     * Live-update a paired prop's offset.
     *   Type A/B → applies to the prop's local transform (instant)
     *   Type C   → reloads the prop FBX with the new baked offset
     */
    async setPairedOffset(propId, offset) {
        const info = this.pairedActive?.get(propId);
        if (!info) return;
        const prop = this.props.get(propId);
        if (!prop) return;

        info.offset = offset; // remember it

        if (prop.pairedType === 'C') {
            // Re-bake: reload the prop with the new offset
            // Temporarily store the override in pairedOffsets
            const key = `${info.category}/${info.filename}`;
            const previous = this.pairedOffsets[key];
            this.pairedOffsets[key] = offset;
            try {
                await this.loadPairedProp(info.category, info.filename);
            } finally {
                if (previous === undefined) delete this.pairedOffsets[key];
                else this.pairedOffsets[key] = previous;
            }
        } else {
            // Type A/B: live transform on the model node
            this._applyOffsetToTransform(prop.model, offset);
        }
    }

    /**
     * Build a THREE.Matrix4 from an offset descriptor
     * { rotation:[xDeg,yDeg,zDeg], position:[x,y,z], scale:n|[x,y,z] }
     */
    _offsetToMatrix(offset) {
        const m = new THREE.Matrix4();
        if (!offset) return m;
        const D2R = Math.PI / 180;
        const r = offset.rotation || [0, 0, 0];
        const p = offset.position || [0, 0, 0];
        let s = offset.scale ?? 1;
        if (typeof s === 'number') s = [s, s, s];
        const eu = new THREE.Euler(r[0] * D2R, r[1] * D2R, r[2] * D2R, 'XYZ');
        const q = new THREE.Quaternion().setFromEuler(eu);
        m.compose(
            new THREE.Vector3(p[0], p[1], p[2]),
            q,
            new THREE.Vector3(s[0], s[1], s[2])
        );
        return m;
    }

    /** Apply an offset to a Transform (Type A/B). */
    _applyOffsetToTransform(node, offset) {
        if (!offset) return;
        const D2R = Math.PI / 180;
        if (offset.position) node.position.set(...offset.position);
        if (offset.rotation) {
            node.rotation.set(
                offset.rotation[0] * D2R,
                offset.rotation[1] * D2R,
                offset.rotation[2] * D2R
            );
        }
        if (offset.scale != null) {
            const s = typeof offset.scale === 'number'
                ? [offset.scale, offset.scale, offset.scale]
                : offset.scale;
            node.scale.set(s[0], s[1], s[2]);
        }
    }

    /** Bake an offset into a SkinnedMesh's geometry (Type C — only way). */
    _bakeOffsetIntoGeometry(skinnedMesh, offset) {
        if (!offset) return;
        const m = this._offsetToMatrix(offset);
        const geo = skinnedMesh.geometry;
        if (!geo) return;
        geo.applyMatrix4(m);
        // Normals need just the rotation portion
        if (geo.attributes.normal) {
            const normalMat = new THREE.Matrix3().getNormalMatrix(m);
            const arr = geo.attributes.normal.array;
            const v = new THREE.Vector3();
            for (let i = 0; i < arr.length; i += 3) {
                v.set(arr[i], arr[i + 1], arr[i + 2]).applyMatrix3(normalMat).normalize();
                arr[i] = v.x; arr[i + 1] = v.y; arr[i + 2] = v.z;
            }
            geo.attributes.normal.needsUpdate = true;
        }
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
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
        const model = await this._loadFBX((this.assetRoot || 'fbx') + '/' + catalogEntry.model);
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
            const animObj = await this._loadFBX((this.assetRoot || 'fbx') + '/' + catalogEntry.animation);
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

    /* ============================================================ */
    /*  Paired props (auto-attached when an animation is selected)  */
    /* ============================================================ */

    /**
     * Default attach bone for non-skinned (Type A) and standalone-rig
     * (Type B) paired props. Can be overridden per-prop later.
     */
    static DEFAULT_PAIRED_BONE = 'spine_05';

    /**
     * Called by the character system when the user selects an
     * animation. Looks up the manifest for a sibling FBX in
     * `<category>/PROPS/<filename>` and attaches it.
     *
     * The previous paired prop in the SAME category is removed first.
     */
    async loadPairedProp(category, filename) {
        if (!this.pairedManifest) return null;

        // Clean up the previous paired prop in this category
        for (const [propId, info] of this.pairedActive) {
            if (info.category === category) {
                this._removePairedProp(propId);
            }
        }

        if (!filename) return null;
        const key = `${category}/${filename}`;
        const relPath = this.pairedManifest[key];
        if (!relPath) return null;

        const url = (this.assetRoot || 'fbx') + '/' + relPath;
        const fbx = await this._loadFBX(url);
        if (!fbx) {
            console.warn(`[paired-prop] failed to load ${url}`);
            return null;
        }

        // Inventory: list every mesh in the prop FBX
        const allMeshes = [];
        const skinned = [];
        fbx.traverse((c) => {
            if (c.isSkinnedMesh) { skinned.push(c); allMeshes.push(c); }
            else if (c.isMesh)   { allMeshes.push(c); }
        });
        console.log(`[paired-prop] ${key}: loaded — ${allMeshes.length} mesh(es), ${skinned.length} skinned`);
        if (allMeshes.length > 1) {
            console.log(`[paired-prop] mesh names: ${allMeshes.map((m) => m.name).join(', ')}`);
        }

        let propId;
        if (skinned.length === 0) {
            // Type A — static mesh
            propId = this._attachTypeA(fbx, category, filename);
        } else {
            // Test bone-name overlap with the character skeleton
            const charBoneNames = new Set(this._boneList.map((b) => b.name));
            const propBoneNames = skinned[0].skeleton.bones.map((b) => b.name);
            const matched   = propBoneNames.filter((n) => charBoneNames.has(n));
            const unmatched = propBoneNames.filter((n) => !charBoneNames.has(n));
            const ratio = matched.length / Math.max(1, propBoneNames.length);
            console.log(`[paired-prop] bone match: ${matched.length}/${propBoneNames.length} (${(ratio * 100).toFixed(0)}%)`);
            if (unmatched.length > 0 && unmatched.length <= 12) {
                console.log(`[paired-prop] unmatched bones: ${unmatched.join(', ')}`);
            }

            if (ratio > 0.5) {
                // Type C — rebind on character skeleton (full-skeleton export)
                propId = this._attachTypeC(skinned, category, filename);
            } else {
                // Type B — mini-rig parented to the bone
                console.warn(`[paired-prop] ratio < 50% → falling back to Type B (mini-rig parented to ${PropsManager.DEFAULT_PAIRED_BONE}). Did you export with the FULL Gloops skeleton?`);
                propId = this._attachTypeB(fbx, category, filename);
            }
        }

        if (propId) {
            this.pairedActive.set(propId, {
                category,
                filename,
                offset: this._lookupOffset(category, filename) || { rotation: [0,0,0], position: [0,0,0], scale: 1 },
            });

            // Register the prop's materials in the MAT panel — using a
            // SHARED per-category pool, so all 13 Eyes props (for example)
            // share the same Glass / GlassStructure shaders.
            if (this.shadingManager) {
                const prop = this.props.get(propId);
                if (prop) {
                    this.shadingManager.addCategoryMaterials(prop.model, category);
                }
            }
        }
        this._firePairedChange();
        return propId;
    }

    /** Type A: parent a static mesh under DEFAULT_PAIRED_BONE. */
    _attachTypeA(fbx, category, filename) {
        const bone = this.getBone(PropsManager.DEFAULT_PAIRED_BONE);
        if (!bone) {
            console.warn(`[paired-prop] default bone "${PropsManager.DEFAULT_PAIRED_BONE}" not found`);
            return null;
        }
        this._fixPropMaterials(fbx);
        bone.add(fbx);
        fbx.position.set(0, 0, 0);
        fbx.rotation.set(0, 0, 0);
        fbx.scale.set(1, 1, 1);
        // Tag so NPC clones can strip this prop out of the cloned hierarchy
        fbx.userData.isPairedProp = true;

        // Apply user offset (config/paired-offsets.json)
        const offset = this._lookupOffset(category, filename);
        if (offset) this._applyOffsetToTransform(fbx, offset);

        const propId = `paired_${category}_${filename}`;
        const prop = new Prop(filename, fbx, bone);
        prop.pairedType = 'A';
        this.props.set(propId, prop);
        console.log(`[paired-prop A] ${category}/${filename} -> ${bone.name}${offset ? ' (offset applied)' : ''}`);
        return propId;
    }

    /** Type B: parent a mini-rig (root + own joints) under DEFAULT_PAIRED_BONE. */
    _attachTypeB(fbx, category, filename) {
        const bone = this.getBone(PropsManager.DEFAULT_PAIRED_BONE);
        if (!bone) return null;
        this._fixPropMaterials(fbx);
        bone.add(fbx);
        fbx.position.set(0, 0, 0);
        fbx.rotation.set(0, 0, 0);
        fbx.scale.set(1, 1, 1);
        fbx.userData.isPairedProp = true;

        const offset = this._lookupOffset(category, filename);
        if (offset) this._applyOffsetToTransform(fbx, offset);

        const propId = `paired_${category}_${filename}`;
        const prop = new Prop(filename, fbx, bone);
        prop.pairedType = 'B';
        this.props.set(propId, prop);
        console.log(`[paired-prop B] ${category}/${filename} -> ${bone.name} (mini-rig)${offset ? ' (offset applied)' : ''}`);
        return propId;
    }

    /**
     * Type C: prop FBX exported with the FULL Gloops skeleton.
     * We rebind every SkinnedMesh to the live character skeleton and
     * add the meshes as children of the character root. The duplicated
     * bones from the prop FBX are discarded.
     */
    _attachTypeC(skinnedMeshes, category, filename) {
        const charBoneByName = new Map();
        this._boneList.forEach((b) => charBoneByName.set(b.name, b));

        // Cached inverses computed from the character's T-pose at load
        // time. Using THESE (instead of the prop's own boneInverses)
        // makes the rebind correct even if the prop was authored with
        // a slightly different bind pose (offsets/rotations baked into
        // some bones like spine_05).
        const charBoneInverses = this.character._baseBoneInverses || {};

        // Build a wrapper group so we can remove the prop in one call.
        const group = new THREE.Group();
        group.name = `pairedC_${category}_${filename}`;
        group.userData.isPairedProp = true;

        // Bake the user offset into geometry (Type C can't use a transform
        // node — the verts are driven by character bones).
        const offset = this._lookupOffset(category, filename);

        for (const sm of skinnedMeshes) {
            if (offset) this._bakeOffsetIntoGeometry(sm, offset);
            // Map the prop's skeleton bones onto the live character bones
            const remappedBones = [];
            const remappedInverses = [];
            for (let i = 0; i < sm.skeleton.bones.length; i++) {
                const srcBone = sm.skeleton.bones[i];
                const charBone = charBoneByName.get(srcBone.name);
                if (charBone) {
                    remappedBones.push(charBone);
                    // Prefer the character's bind-pose inverse; fall back
                    // to the prop's only if we somehow don't have one.
                    const inv = charBoneInverses[srcBone.name];
                    remappedInverses.push(inv ? inv.clone() : sm.skeleton.boneInverses[i]);
                } else {
                    // Bone not in character → keep the prop's bone (rare)
                    remappedBones.push(srcBone);
                    remappedInverses.push(sm.skeleton.boneInverses[i]);
                }
            }
            const newSkeleton = new THREE.Skeleton(remappedBones, remappedInverses);

            // Detach from the original parent (the prop's own armature)
            sm.removeFromParent();

            // Reset transform — the skin lives in the character's world
            sm.position.set(0, 0, 0);
            sm.quaternion.identity();
            sm.scale.set(1, 1, 1);

            // Fresh material
            this._fixPropMaterials(sm);

            // Rebind. Identity bind matrix means "the skin is authored
            // in world space at the character's T-pose"
            sm.bind(newSkeleton, new THREE.Matrix4());
            sm.frustumCulled = false;
            sm.castShadow = true;
            sm.receiveShadow = true;

            group.add(sm);
        }

        // Attach the group to the character root (NOT a bone)
        this.character.model.add(group);

        const propId = `paired_${category}_${filename}`;
        const prop = new Prop(filename, group, this.character.model);
        prop.pairedType = 'C';
        this.props.set(propId, prop);
        console.log(`[paired-prop C] ${category}/${filename} rebound on character skeleton (${skinnedMeshes.length} skinnedMesh)${offset ? ' (offset baked)' : ''}`);
        return propId;
    }

    /** Internal: remove a paired prop and dispose its resources.
     *  Materials are NOT removed from the MAT panel — they live in
     *  the shared per-category pool and are reused by the next prop. */
    _removePairedProp(propId) {
        const prop = this.props.get(propId);
        if (!prop) return;

        // Drop this prop's mesh references from any pooled MaterialEntry
        // so subsequent shader edits don't iterate stale objects.
        if (this.shadingManager) {
            const propMeshes = new Set();
            prop.model.traverse((c) => {
                if (c.isMesh || c.isSkinnedMesh) propMeshes.add(c);
            });
            for (const entry of this.shadingManager.entries.values()) {
                if (!entry.meshes || entry.meshes.length === 0) continue;
                entry.meshes = entry.meshes.filter((m) => !propMeshes.has(m));
            }
        }

        prop.model.removeFromParent();
        prop.model.traverse((c) => {
            if (c.isMesh) {
                c.geometry?.dispose();
                if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
                else c.material?.dispose();
            }
        });
        this.props.delete(propId);
        this.pairedActive.delete(propId);
        console.log(`[paired-prop] removed ${propId}`);
        this._firePairedChange();
    }

    /** Replace prop materials with a uniform MeshPhysicalMaterial.
     *  Handles BOTH single-material and multi-material (array) meshes.
     *  Multi-material meshes use geometry.groups for per-face slot assignment. */
    _fixPropMaterials(root) {
        const replaceOne = (src, fallbackName) => new THREE.MeshPhysicalMaterial({
            color: src?.color || new THREE.Color(0xffffff),
            roughness: 1.0,
            metalness: 0,
            name: src?.name || fallbackName,
        });

        root.traverse((child) => {
            if (!(child.isMesh || child.isSkinnedMesh)) return;
            child.castShadow = true;
            child.receiveShadow = true;
            const mat = child.material;
            if (!mat) return;
            if (Array.isArray(mat)) {
                child.material = mat.map((m, i) => replaceOne(m, `${child.name}_${i}`));
            } else {
                child.material = replaceOne(mat, child.name);
            }
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
