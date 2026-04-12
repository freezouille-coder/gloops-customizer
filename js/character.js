import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

export class Character {
    constructor() {
        this.model = null;
        this.mixer = null;
        this.loader = new FBXLoader();
        this.categories = new Map();
        this._categoryOrder = [];
        this._basePose = null; // T-pose reference values
    }

    async load(url) {
        return new Promise((resolve, reject) => {
            this.loader.load(
                url,
                (object) => {
                    this.model = object;
                    this.mixer = new THREE.AnimationMixer(this.model);

                    // Capture T-pose reference from the loaded model
                    this._captureBasePose();

                    console.log('Base model loaded');
                    resolve(this);
                },
                null,
                (error) => {
                    console.error('Error loading FBX:', error);
                    reject(error);
                }
            );
        });
    }

    /**
     * Capture the T-pose (rest pose) values from the base model.
     * Used to compare overlay animation tracks against.
     */
    _captureBasePose() {
        this._basePose = {};
        this.model.traverse((bone) => {
            if (bone.isBone || bone.type === 'Bone') {
                const name = bone.name;
                this._basePose[name] = {
                    pos: bone.position.clone(),
                    quat: bone.quaternion.clone(),
                    scale: bone.scale.clone(),
                };
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
        // Build a list of bone name patterns to KEEP based on category
        const keepPatterns = {
            'Teeths': ['Teeth', 'teeth'],
            // Add more category patterns as needed
        };

        const patterns = keepPatterns[categoryName] || [];

        const dominated = [];
        for (let i = clip.tracks.length - 1; i >= 0; i--) {
            const track = clip.tracks[i];

            // Keep morph target tracks ONLY if they match the category
            if (track.name.includes('morphTargetInfluences')) {
                // For Teeths, only keep teeths_low morphs
                if (patterns.length > 0) {
                    const meshName = track.name.split('.')[0].toLowerCase();
                    const shouldKeepMorph = patterns.some(p => meshName.includes(p.toLowerCase()));
                    if (!shouldKeepMorph) {
                        dominated.push(i);
                    }
                }
                continue;
            }

            // If no patterns defined for this category, keep everything
            if (patterns.length === 0) continue;

            // Check if bone name matches any keep pattern
            const boneName = track.name.split('.')[0];
            const shouldKeep = patterns.some(p => boneName.includes(p));

            if (!shouldKeep) {
                dominated.push(i);
            }
        }

        for (const idx of dominated) {
            clip.tracks.splice(idx, 1);
        }

        if (dominated.length > 0) {
            console.log(`Pruned ${dominated.length} non-${categoryName} tracks from "${clip.name}" (${clip.tracks.length} remaining)`);
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
            this.loader.load(
                url,
                (object) => {
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
                },
                null,
                (error) => {
                    console.error(`Error loading ${url}:`, error);
                    reject(error);
                }
            );
        });
    }

    selectItem(categoryName, filename) {
        const cat = this.categories.get(categoryName);
        if (!cat) return;

        for (const [fname, item] of cat.items) {
            if (fname === filename) {
                item.action.setEffectiveWeight(1);
                item.action.enabled = true;
                if (cat.type === 'pose') {
                    item.action.paused = true;
                    item.action.time = 0;
                } else {
                    item.action.time = 0;
                }
            } else {
                item.action.setEffectiveWeight(0);
            }
        }
        cat.active = filename;
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
