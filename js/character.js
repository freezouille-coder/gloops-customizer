import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { makeGLTFLoader } from './gltf-loader.js';

export class Character {
    constructor() {
        this.model = null;
        this.mixer = null;
        this.fbxLoader = new FBXLoader();
        this.gltfLoader = makeGLTFLoader();
        // Kept for backward compatibility — the FBX loader was exposed
        // directly before we added GLB support.
        this.loader = this.fbxLoader;
        this.categories = new Map();
        this._categoryOrder = [];
        this._basePose = null; // T-pose reference values
    }

    /**
     * Load a URL and return { object, animations }.
     * Dispatches on file extension: .glb / .gltf → GLTFLoader,
     * anything else → FBXLoader.
     */
    _loadAny(url) {
        const ext = url.split('?')[0].split('.').pop().toLowerCase();
        this._lastLoadExt = ext;
        return new Promise((resolve, reject) => {
            if (ext === 'glb' || ext === 'gltf') {
                this.gltfLoader.load(
                    url,
                    (gltf) => {
                        const obj = gltf.scene;
                        obj.animations = gltf.animations || [];
                        obj.userData.isGLB = true;
                        resolve(obj);
                    },
                    null,
                    (err) => reject(err)
                );
            } else {
                this.fbxLoader.load(url, (o) => {
                    o.userData.isFBX = true;
                    resolve(o);
                }, null, (err) => reject(err));
            }
        });
    }

    async load(url) {
        try {
            const object = await this._loadAny(url);
            this.model = object;
            this.mixer = new THREE.AnimationMixer(this.model);
            this._captureBasePose();
            console.log('Base model loaded (' + url.split('.').pop() + ')');
            return this;
        } catch (err) {
            console.error('Error loading model:', err);
            throw err;
        }
    }

    /**
     * Capture the T-pose (rest pose) values from the base model.
     * Used to compare overlay animation tracks against.
     */
    _captureBasePose() {
        this._basePose = {};
        this._baseBoneInverses = {};
        // Make sure world matrices reflect the just-loaded T-pose
        this.model.updateMatrixWorld(true);
        this.model.traverse((bone) => {
            if (bone.isBone || bone.type === 'Bone') {
                const name = bone.name;
                this._basePose[name] = {
                    pos: bone.position.clone(),
                    quat: bone.quaternion.clone(),
                    scale: bone.scale.clone(),
                };
                // Cache the world-space inverse at bind time so paired
                // props (Type C) can rebind onto the character's REAL
                // T-pose, ignoring whatever bind pose was baked into
                // their FBX.
                this._baseBoneInverses[name] = new THREE.Matrix4()
                    .copy(bone.matrixWorld)
                    .invert();
            }
        });
        console.log(`Captured T-pose: ${Object.keys(this._basePose).length} bones`);
    }

    /**
     * Remove tracks from an overlay clip that don't belong.
     * Strategy: only keep morph targets and bone tracks whose names
     * match the category (e.g. "Teeth" bones for Teeths category).
     * Everything else (body, arms, eyes, etc.) is removed.
     */
    _pruneOverlayClip(clip, categoryName) {
        // Patterns to KEEP per category. Prefix a pattern with "exact:" to
        // require strict bone-name equality (no children, no substring).
        const keepPatterns = {
            'Teeths': ['Teeth', 'teeth'],
            // Horns: keep only horns-related bones + morphs so the clip
            // doesn't clobber body/arms/legs posed by Move animations.
            'Horns': ['Horns', 'horns', 'BS_Horns', 'Sk_Main_Horns'],
            // Eyes: ONLY the two main eye joints, no children below them.
            // Eyes animations don't touch any morph or body bone.
            'Eyes':  ['exact:Sk_Main_Eye_Lt', 'exact:Sk_Main_Eye_Rt'],
        };
        // Patterns to DROP per category (blacklist). Horn bones should
        // stay still during locomotion so a separately-chosen Horns
        // style isn't perturbed by walk/run/shake. Any bone matching a
        // drop pattern is removed from the clip.
        const dropPatterns = {
            'Move': ['Horns', 'horns', 'BS_Horns', 'Sk_Main_Horns'],
        };

        const patterns = keepPatterns[categoryName] || [];
        const drops    = dropPatterns[categoryName] || [];

        // Helper: does a bone name match any pattern (exact or substring) ?
        const matches = (boneName, pats) => pats.some((p) => {
            if (p.startsWith('exact:')) return boneName === p.slice(6);
            return boneName.includes(p);
        });

        const dominated = [];
        for (let i = clip.tracks.length - 1; i >= 0; i--) {
            const track = clip.tracks[i];
            const trackTargetName = track.name.split('.')[0];

            // Drop-list — always wins over any keep-list.
            if (drops.length > 0 && matches(trackTargetName, drops)) {
                dominated.push(i);
                continue;
            }

            // Morph tracks
            if (track.name.includes('morphTargetInfluences')) {
                if (patterns.length > 0) {
                    const meshName = trackTargetName;
                    // Only substring patterns can match morph mesh names;
                    // exact: patterns are bone-only, so they drop morphs.
                    const shouldKeepMorph = patterns.some((p) => {
                        if (p.startsWith('exact:')) return false;
                        return meshName.toLowerCase().includes(p.toLowerCase());
                    });
                    if (!shouldKeepMorph) dominated.push(i);
                }
                continue;
            }

            // No keep-patterns → keep all (remaining) bone tracks
            if (patterns.length === 0) continue;

            if (!matches(trackTargetName, patterns)) {
                dominated.push(i);
            }
        }

        for (const idx of dominated) {
            clip.tracks.splice(idx, 1);
        }

        if (dominated.length > 0) {
            console.log(`Pruned ${dominated.length} tracks from "${clip.name}" [${categoryName}] (${clip.tracks.length} remaining)`);
        }
    }

    /**
     * Remove root-motion tracks from a clip: any track targeting the
     * top-most bone (usually "root", "Armature", "hips", "pelvis") and
     * its quaternion or position. Keeps the in-place pose animation but
     * prevents the character from being dragged around or rotated by
     * the clip itself.
     */
    /**
     * Keep only quaternion (rotation) + morphTargetInfluences (face)
     * tracks on locomotion clips. Drops position/scale tracks that would
     * push bones into wrong places (causing visible body drift) but keeps
     * the face morph tracks so the "idiot" expression still plays during
     * walk_stupid, etc.
     */
    _stripRootMotion(clip) {
        const before = clip.tracks.length;
        clip.tracks = clip.tracks.filter((t) =>
            /\.quaternion$/.test(t.name) || t.name.includes('morphTargetInfluences')
        );
        const removed = before - clip.tracks.length;
        if (removed > 0) {
            console.log(`[stripRootMotion] "${clip.name}" kept ${clip.tracks.length}/${before} (quat + morphs)`);
        }
    }

    registerCategory(name, type, folder) {
        const isBase = this._categoryOrder.length === 0;
        this.categories.set(name, {
            type, folder,
            items: new Map(),
            active: null,
            isBase,
        });
        this._categoryOrder.push(name);
    }

    async loadItem(categoryName, filename, url) {
        const cat = this.categories.get(categoryName);
        if (!cat) return null;

        return new Promise((resolve, reject) => {
            this._loadAny(url).then((object) => {
                    if (!object.animations || object.animations.length === 0) {
                        console.warn(`No animation in ${url}`);
                        resolve(null);
                        return;
                    }

                    let clip = object.animations[0];
                    const label = filename.replace(/\.fbx$/i, '').replace(/[_-]/g, ' ');
                    clip.name = label;

                    // For overlay categories: remove tracks that don't belong
                    if (!cat.isBase) {
                        this._pruneOverlayClip(clip, categoryName);
                    }

                    // Move animations are played RAW, no filtering,
                    // no root motion stripping — the user wants them
                    // exactly as exported from Maya.

                    const action = this.mixer.clipAction(clip);
                    action.setEffectiveWeight(0);
                    action.enabled = true;

                    if (cat.type === 'pose') {
                        action.setLoop(THREE.LoopOnce);
                        action.clampWhenFinished = true;
                        action.time = 0;
                        action.paused = true;
                    } else {
                        action.setLoop(THREE.LoopRepeat);
                    }

                    action.play();
                    cat.items.set(filename, { clip, action, label });
                    resolve({ filename, label });
            }).catch((error) => {
                console.error(`Error loading ${url}:`, error);
                reject(error);
            });
        });
    }

    /**
     * Resolve a filename against a category's items, accepting either
     * the original extension or any equivalent (.fbx ↔ .glb ↔ .gltf).
     * Used so legacy call sites hardcoded with ".fbx" keep working after
     * the GLB switch.
     * Returns the actual key stored in cat.items, or null.
     */
    _resolveItemKey(cat, filename) {
        if (!filename) return null;
        if (cat.items.has(filename)) return filename;
        const stripExt = (s) => s.replace(/\.(fbx|glb|gltf)$/i, '');
        const needle = stripExt(filename).toLowerCase();
        for (const key of cat.items.keys()) {
            if (stripExt(key).toLowerCase() === needle) return key;
        }
        return null;
    }

    /**
     * Meshes owning the morph targets for a given overlay category.
     * Substring match (case-insensitive) on mesh name.
     * Used to reset morph influences when switching variants — otherwise
     * morphs the previous variant drove stay frozen at their last value
     * and ghost through the new variant. Three.js AnimationMixer does not
     * auto-reset untracked morphs.
     */
    static _MORPH_MESHES = {
        'Horns':  ['BS_Horns', 'bs_horns', 'Horn', 'horn'],
        'Teeths': ['BS_Teeth', 'bs_teeth', 'Teeth', 'teeth'],
    };

    /**
     * Bone-name substring patterns that identify which skeleton joints
     * belong to each overlay category. Three.js's AnimationMixer doesn't
     * auto-reset bones no action currently drives, so without this the
     * previous variant's last joint rotation "sticks" when switching.
     * E.g. Horns variant A rotates Sk_Main_Horns_0001 by 45°, variant B
     * doesn't touch that joint → the 45° rotation bleeds into B.
     */
    static _CATEGORY_BONES = {
        'Horns':  ['Sk_Main_Horns'],
        'Teeths': ['Sk_Main_Teeth'],
    };

    _resetCategoryMorphs(categoryName) {
        const patterns = Character._MORPH_MESHES[categoryName];
        if (!patterns || !this.model) return;
        this.model.traverse((child) => {
            if (!child.morphTargetInfluences || child.morphTargetInfluences.length === 0) return;
            const name = (child.name || '').toLowerCase();
            for (const pat of patterns) {
                if (name.includes(pat.toLowerCase())) {
                    child.morphTargetInfluences.fill(0);
                    return;
                }
            }
        });
    }

    /**
     * Reset every bone in the category (e.g. all Sk_Main_Horns_*) to
     * its base rest pose captured at model load. Called just before a
     * new variant's action takes weight 1, so stale joint rotations
     * from the previous variant don't bleed through.
     */
    _resetCategoryBones(categoryName) {
        const patterns = Character._CATEGORY_BONES[categoryName];
        if (!patterns || !this.model || !this._basePose) return;
        this.model.traverse((bone) => {
            if (!(bone.isBone || bone.type === 'Bone')) return;
            const name = bone.name || '';
            let match = false;
            for (const pat of patterns) {
                if (name.includes(pat)) { match = true; break; }
            }
            if (!match) return;
            const base = this._basePose[name];
            if (!base) return;
            bone.position.copy(base.pos);
            bone.quaternion.copy(base.quat);
            bone.scale.copy(base.scale);
        });
    }

    selectItem(categoryName, filename) {
        const cat = this.categories.get(categoryName);
        if (!cat) return;

        // Extension-tolerant: callers can pass "walk.fbx" even when
        // items are keyed by "walk.glb".
        const resolved = this._resolveItemKey(cat, filename) || filename;

        // Flush stale morphs AND joint rotations from the previous
        // variant so they don't bleed through the new one. See the docs
        // on _resetCategoryMorphs / _resetCategoryBones for why.
        this._resetCategoryMorphs(categoryName);
        this._resetCategoryBones(categoryName);

        for (const [fname, item] of cat.items) {
            if (fname === resolved) {
                item.action.setEffectiveWeight(1);
                item.action.enabled = true;
                item.action.time = 0;
                if (cat.type === 'pose') {
                    item.action.paused = true;
                } else {
                    item.action.paused = false;
                    item.action.play(); // ensure it's playing and reset
                }
            } else {
                item.action.setEffectiveWeight(0);
            }
        }
        cat.active = resolved;

        // Auto-load a paired prop FBX if one exists for this animation.
        // The PropsManager is wired in by app.js after both are created;
        // the call is a no-op when no manifest entry matches.
        if (this.props && typeof this.props.loadPairedProp === 'function') {
            this.props.loadPairedProp(categoryName, resolved);
        }
    }

    getActive(categoryName) {
        const cat = this.categories.get(categoryName);
        return cat ? cat.active : null;
    }

    getCategoryNames() {
        return [...this.categories.keys()];
    }

    getCategoryItems(categoryName) {
        const cat = this.categories.get(categoryName);
        if (!cat) return [];
        return [...cat.items.entries()].map(([filename, item]) => ({ filename, label: item.label }));
    }

    getCategoryType(categoryName) {
        const cat = this.categories.get(categoryName);
        return cat ? cat.type : null;
    }

    resetAll() {
        for (const name of this.categories.keys()) {
            this.selectItem(name, null);
        }
    }

    update(delta) {
        if (this.mixer) this.mixer.update(delta);
    }
}
