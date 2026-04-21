import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { randomGloopName } from '../character-presets.js';
import { ShadingManager } from '../shading.js';
import { autoConnectTextures, applyMaterialDefaults, randomizeCharacter } from '../character-loader.js';
import { NpcBubble, BUBBLE_EMOJIS } from './game-bubbles.js';

/**
 * Single NPC Gloop in the play world.
 *
 * For now, NPCs share visual materials with the main player (they are
 * cloned via SkeletonUtils.clone, which keeps shared materials). Each
 * NPC has its OWN AnimationMixer and plays its OWN Emotion clip
 * matching its current mood (1..16). Names + positions + moods are
 * randomized.
 *
 * TODO (v2): give each NPC its own ShadingManager so colors/patterns
 * can be randomized per NPC.
 */

// Map mood (1..16) -> emotion filename available in the manifest
const EMOTION_BY_MOOD = {
    1: '01_peace.fbx',  2: '02_waouh.fbx',  3: '03_happy.fbx',  4: '04_inlove.fbx',
    5: '05_playful.fbx', 6: '06_satisfied.fbx', 7: '07_thug.fbx', 8: '08_worried.fbx',
    9: '09_frustrated.fbx', 10: '10_disappointed.fbx', 11: '11_angry.fbx',
    12: '12_despising.fbx', 13: '13_sad.fbx', 14: '14_afraid.fbx',
    15: '15_crying.fbx', 16: '16_annihilated.fbx',
};

export class NpcGloop {
    constructor(sourceCharacter, position, options = {}) {
        this.sourceCharacter = sourceCharacter;
        this.name = options.name || randomGloopName();
        this.mood = options.mood || (1 + Math.floor(Math.random() * 16));

        // Clone the rigged model (skeleton/meshes cloned, materials still shared)
        this.model = SkeletonUtils.clone(sourceCharacter.model);
        // Forward the format tag so ShadingManager.scanModel picks the right
        // flipV default (GLB = false, FBX = true). SkeletonUtils.clone copies
        // userData by ref, but belt-and-suspenders in case that changes.
        if (sourceCharacter.model.userData) {
            this.model.userData.isGLB = sourceCharacter.model.userData.isGLB;
            this.model.userData.isFBX = sourceCharacter.model.userData.isFBX;
        }
        // Strip any paired props the player happens to be wearing right
        // now — otherwise every NPC spawns with the player's glasses/hat.
        this._stripPairedProps(this.model);
        this.model.position.copy(position);
        this.model.rotation.y = Math.random() * Math.PI * 2;

        // Own ShadingManager — replaces shared materials with fresh ones
        // bound to THIS NPC's mesh instances. Filled in by initVisuals().
        this.sm = new ShadingManager();

        // Own animation mixer
        this.mixer = new THREE.AnimationMixer(this.model);
        this._actions = new Map();
        this._moveActions = new Map();
        this._currentAction = null;
        this._currentMove = null;
        this._buildActions();
        // NO emotion on NPCs — movement anims are the ONLY driver now.
        this._zeroAllEmotions();
        // Default "wandering stupidly" loop
        this._playMove('walk_stupid.fbx');

        this._tmp = new THREE.Vector3();
        // Wander state
        this._wanderTarget = new THREE.Vector3();
        this._wanderTimer = 0;
        this._pickWanderTarget();

        // Emoji bubble above the head. Hidden by default — only shown
        // on specific events (chat, panic, donut, carrot, depressed).
        this.bubble = new NpcBubble();
        this.model.add(this.bubble.object);

        // No root bone override — Move clips play raw.
        this._rootBone = null;
    }

    /**
     * Walk the cloned model and remove any node tagged as a paired
     * prop (added at runtime by PropsManager). This prevents NPCs from
     * inheriting the player's currently-attached glasses / hats.
     */
    _stripPairedProps(root) {
        const toRemove = [];
        root.traverse((node) => {
            if (node.userData && node.userData.isPairedProp) toRemove.push(node);
        });
        for (const node of toRemove) {
            node.removeFromParent();
            node.traverse((c) => {
                if (c.isMesh || c.isSkinnedMesh) {
                    c.geometry?.dispose();
                    if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
                }
            });
        }
    }

    _pickWanderTarget() {
        // NPCs patrol around a city block. Each NPC is assigned a block
        // center (±14 × ±14) on first call; subsequent wander targets
        // trace the 4 corners of the sidewalk ring around that block.
        if (!this._patrolBlock) {
            const blocks = [
                [14, 14], [-14, 14], [14, -14], [-14, -14],
                [14, 42], [-14, 42], [14, -42], [-14, -42],
                [42, 14], [-42, 14], [42, -14], [-42, -14],
            ];
            this._patrolBlock = blocks[Math.floor(Math.random() * blocks.length)];
            this._patrolStep = Math.floor(Math.random() * 4);
        }
        const [bx, bz] = this._patrolBlock;
        // 4 sidewalk corners around the block (offset 9m from block center)
        const corners = [
            [bx + 9, bz + 9], [bx - 9, bz + 9],
            [bx - 9, bz - 9], [bx + 9, bz - 9],
        ];
        this._patrolStep = (this._patrolStep + 1) % 4;
        let tx = corners[this._patrolStep][0];
        let tz = corners[this._patrolStep][1];
        // Clamp to island play area
        const r = Math.hypot(tx, tz);
        const MAX = 55;
        if (r > MAX) {
            const k = MAX / r;
            tx *= k; tz *= k;
        }

        // NPCs are PEDESTRIANS — push them off the road onto a sidewalk.
        // Roads live at x=0, x=±28, z=0, z=±28 with half-width 3 m.
        // We snap to the sidewalk ~5 m from the road centerline.
        const ROAD_AXES_X = [0, 28, -28];
        const ROAD_AXES_Z = [0, 28, -28];
        for (const rx of ROAD_AXES_X) {
            if (Math.abs(tx - rx) < 3) {
                tx = rx + (tx >= rx ? 5 : -5);
                break;
            }
        }
        for (const rz of ROAD_AXES_Z) {
            if (Math.abs(tz - rz) < 3) {
                tz = rz + (tz >= rz ? 5 : -5);
                break;
            }
        }
        this._wanderTarget.set(tx, 0, tz);
        this._wanderTimer = 4 + Math.random() * 6;
    }

    /**
     * Async setup of per-NPC materials. Must be called before adding to scene.
     * Runs the same scan + auto-connect + defaults pipeline as the player,
     * then applies a random preset.
     */
    async initVisuals(manifestData, characterConfig) {
        this.sm.scanModel(this.model);
        await autoConnectTextures(this.sm, manifestData.autoConnect || {});
        applyMaterialDefaults(this.sm, characterConfig);
        await randomizeCharacter(this.sm, characterConfig);
    }

    _buildActions() {
        // Emotion clips (loaded so we can zero them later)
        const emoCat = this.sourceCharacter.categories.get('Emotion');
        if (emoCat) {
            for (const [filename, item] of emoCat.items) {
                const action = this.mixer.clipAction(item.clip);
                action.setEffectiveWeight(0);
                action.enabled = true;
                action.play();
                this._actions.set(filename, action);
            }
        }
        // Move clips (full-body locomotion)
        const moveCat = this.sourceCharacter.categories.get('Move');
        if (moveCat) {
            for (const [filename, item] of moveCat.items) {
                const action = this.mixer.clipAction(item.clip);
                action.setEffectiveWeight(0);
                action.enabled = true;
                action.play();
                this._moveActions.set(filename, action);
            }
        }
        // Teeth variation (random per NPC — gives each NPC a distinct mouth)
        const teethCat = this.sourceCharacter.categories.get('Teeths');
        this._teethActions = new Map();
        if (teethCat && teethCat.items.size > 0) {
            for (const [filename, item] of teethCat.items) {
                const action = this.mixer.clipAction(item.clip);
                action.setEffectiveWeight(0);
                action.enabled = true;
                action.play();
                this._teethActions.set(filename, action);
            }
            const keys = [...this._teethActions.keys()];
            const pick = keys[Math.floor(Math.random() * keys.length)];
            this._teethActions.get(pick).setEffectiveWeight(1);
        }

        // Horns / hair variation (random per NPC)
        const hornsCat = this.sourceCharacter.categories.get('Horns');
        this._hornsActions = new Map();
        if (hornsCat && hornsCat.items.size > 0) {
            for (const [filename, item] of hornsCat.items) {
                const action = this.mixer.clipAction(item.clip);
                action.setEffectiveWeight(0);
                action.enabled = true;
                action.play();
                this._hornsActions.set(filename, action);
            }
            const keys = [...this._hornsActions.keys()];
            const pick = keys[Math.floor(Math.random() * keys.length)];
            this._hornsActions.get(pick).setEffectiveWeight(1);
        }
    }

    /**
     * Extension-tolerant lookup in one of our action Maps.
     * We can't replace the Map with the resolved key because multiple
     * call sites pass ".fbx" strings; instead we search by basename.
     */
    _findAction(actionMap, filename) {
        if (actionMap.has(filename)) return actionMap.get(filename);
        const stripExt = (s) => s.replace(/\.(fbx|glb|gltf)$/i, '').toLowerCase();
        const needle = stripExt(filename);
        for (const [key, action] of actionMap) {
            if (stripExt(key) === needle) return action;
        }
        return null;
    }

    _playMove(filename) {
        // Normalise to basename so different call sites ("walk.fbx" vs
        // "walk.glb") don't defeat the "already playing" short-circuit.
        const basename = filename.replace(/\.(fbx|glb|gltf)$/i, '').toLowerCase();
        if (this._currentMove === basename) return;
        const target = this._findAction(this._moveActions, filename);
        if (!target) return;
        for (const a of this._moveActions.values()) {
            if (a === target) a.setEffectiveWeight(1);
            else a.setEffectiveWeight(0);
        }
        this._currentMove = basename;
    }

    _zeroAllEmotions() {
        for (const a of this._actions.values()) {
            a.setEffectiveWeight(0);
        }
    }

    // Kept around so dialogue code can still track mood, but it NO LONGER
    // drives any animation. Emotion clips stay at weight 0.
    setMood(newMood) {
        this.mood = Math.max(1, Math.min(16, newMood));
    }

    feedDonut() {
        this.setMood(this.mood + 1);
        this.bubble?.set(BUBBLE_EMOJIS.DONUT, 2500);
    }
    feedVeggie() {
        this.setMood(this.mood - 1);
        this.bubble?.set(BUBBLE_EMOJIS.CARROT, 2500);
    }

    /**
     * Called when the player's car runs over this NPC.
     * Sends it flying with spin; on landing, sets mood to 16 (depression).
     */
    crush(dirX, dirZ, speed) {
        if (this._crushed) return;
        this._crushed = true;
        this._crushVel = {
            x: dirX * (2 + speed * 0.3),
            y: 7 + Math.random() * 3,
            z: dirZ * (2 + speed * 0.3),
        };
        this._spinSpeed = 10 + Math.random() * 6;
        this._crushTimer = 0;
        // Freeze all locomotion clips → the ragdoll looks crushed
        for (const a of this._moveActions.values()) a.setEffectiveWeight(0);
        this._currentMove = null;
        this.bubble?.set(BUBBLE_EMOJIS.DEPRESSED);
    }

    update(dt, paused, threatPos, world, allNpcs, characterPos) {
        if (this.mixer) this.mixer.update(dt);
        if (paused) return;

        // Depressed → frozen ragdoll on the ground, nothing updates
        if (this._depressed) return;

        // --- Chatting state: two NPCs meeting each other ---
        // Gets interrupted if the player comes too close — we want flee
        // to take precedence, so check the distance before returning.
        if (this._chatting) {
            // CAR interrupt → break chat, let the flee block run
            const playerClose = threatPos && (
                Math.hypot(
                    threatPos.x - this.model.position.x,
                    threatPos.z - this.model.position.z
                ) < 5
            );
            if (playerClose) {
                this._chatting = false;
                this._chatPartner = null;
            } else {
                this._chatTimer -= dt;
                if (this._chatPartner && !this._chatPartner._depressed) {
                    const dx = this._chatPartner.model.position.x - this.model.position.x;
                    const dz = this._chatPartner.model.position.z - this.model.position.z;
                    this.model.rotation.y = Math.atan2(dx, dz);
                }
                if (this._chatTimer <= 0) {
                    this._chatting = false;
                    this._chatPartner = null;
                    this._playMove('walk_stupid.fbx');
                    this._pickWanderTarget();
                    this.bubble?.hideIfNotHolding();
                }
                return;
            }
        }

        // --- Crush airborne state ---
        if (this._crushed) {
            this._crushTimer += dt;
            // Gravity + horizontal velocity
            this._crushVel.y -= 22 * dt;
            this.model.position.x += this._crushVel.x * dt;
            this.model.position.z += this._crushVel.z * dt;
            this.model.position.y += this._crushVel.y * dt;
            // Air friction
            this._crushVel.x *= 0.96;
            this._crushVel.z *= 0.96;
            // Spin around Y
            this.model.rotation.y += this._spinSpeed * dt;
            // Wobble slightly on X/Z for the "tumbling" look
            this.model.rotation.x = Math.sin(this._crushTimer * 12) * 0.5;
            this.model.rotation.z = Math.cos(this._crushTimer * 9) * 0.4;
            // Ground landing
            if (this.model.position.y <= 0 && this._crushVel.y < 0) {
                this.model.position.y = 0;
                this._crushVel.y = 0;
                this._crushVel.x *= 0.2;
                this._crushVel.z *= 0.2;
                this._spinSpeed *= 0.6;
                // Once we're really stopped, lock depression
                if (Math.abs(this._spinSpeed) < 1.5 && this._crushTimer > 1.0) {
                    // Lock in depression pose: body laid flat on the ground,
                    // movement animations stay zeroed → frozen ragdoll look.
                    this._crushed = false;
                    this._depressed = true;
                    this.model.rotation.x = Math.PI / 2 * 0.85;
                    this.model.rotation.z = (Math.random() - 0.5) * 0.6;
                    this.model.position.y = 0.3;
                    this.setMood(16);
                }
            }
            return; // skip flee logic while crushed
        }

        // --- Panic flee when the CAR approaches (walking player doesn't trigger) ---
        if (threatPos) {
            const dx = threatPos.x - this.model.position.x;
            const dz = threatPos.z - this.model.position.z;
            const d = Math.hypot(dx, dz);
            const FLEE_START = 4.5;
            const FLEE_STOP = 9;
            const wasNotFleeing = !this._fleeing;
            if (wasNotFleeing && d < FLEE_START) {
                this._fleeing = true;
                this._fleeTimer = 2 + Math.random() * 2;
                this._playMove('run_panic.fbx');
                this.bubble?.set(BUBBLE_EMOJIS.PANIC);
                // Base direction = away from player, plus a random kick
                // so the NPC doesn't just run in a straight line.
                const safe = Math.max(0.1, d);
                let fx = -dx / safe;
                let fz = -dz / safe;
                // Random perpendicular offset (±90°)
                const kick = (Math.random() - 0.5) * 1.8;
                const px = -fz, pz = fx;         // perpendicular in XZ
                fx += px * kick;
                fz += pz * kick;
                const nn = Math.hypot(fx, fz) || 1;
                this._fleeDirX = fx / nn;
                this._fleeDirZ = fz / nn;
                // Direction change cooldown so they occasionally swerve
                this._fleeSwerveTimer = 0.8 + Math.random();
            }
            if (this._fleeing) {
                this._fleeTimer -= dt;
                // Occasionally swerve mid-flee for comic effect
                this._fleeSwerveTimer -= dt;
                if (this._fleeSwerveTimer <= 0) {
                    const safe = Math.max(0.1, d);
                    const awayX = -dx / safe;
                    const awayZ = -dz / safe;
                    const kick = (Math.random() - 0.5) * 2.2;
                    const px = -awayZ, pz = awayX;
                    let fx = awayX + px * kick;
                    let fz = awayZ + pz * kick;
                    const nn = Math.hypot(fx, fz) || 1;
                    this._fleeDirX = fx / nn;
                    this._fleeDirZ = fz / nn;
                    this._fleeSwerveTimer = 0.5 + Math.random() * 0.9;
                }
                const fleeSpeed = 10.0;
                this.model.position.x += this._fleeDirX * fleeSpeed * dt;
                this.model.position.z += this._fleeDirZ * fleeSpeed * dt;
                this.model.rotation.y = Math.atan2(this._fleeDirX, this._fleeDirZ);
                const r = Math.hypot(this.model.position.x, this.model.position.z);
                if (r > 46) {
                    const k = 46 / r;
                    this.model.position.x *= k;
                    this.model.position.z *= k;
                }
                if (this._fleeTimer <= 0 && d > FLEE_STOP) {
                    this._fleeing = false;
                    this._playMove('walk_stupid.fbx');
                    this._pickWanderTarget();
                    this.bubble?.hideIfNotHolding();
                }
                return;
            }
        }

        // --- Wander (default idle behavior) ---
        this._wanderTimer -= dt;
        if (this._wanderTimer <= 0) {
            this._pickWanderTarget();
        }
        this._tmp.set(
            this._wanderTarget.x - this.model.position.x,
            0,
            this._wanderTarget.z - this.model.position.z
        );
        const wd = Math.hypot(this._tmp.x, this._tmp.z);
        if (wd > 0.4) {
            const invD = 1 / wd;
            const wx = this._tmp.x * invD;
            const wz = this._tmp.z * invD;
            const wanderSpeed = 1.6;
            this.model.position.x += wx * wanderSpeed * dt;
            this.model.position.z += wz * wanderSpeed * dt;
            // Face the wander direction INSTANTLY — so orientation
            // always matches movement direction (no backward walking).
            this.model.rotation.y = Math.atan2(wx, wz);
        } else {
            // Arrived → pick a new target soon
            if (this._wanderTimer > 1.2) this._wanderTimer = 1.2;
        }

        // --- Collide with world obstacles (trees, rocks, mountains, fountain) ---
        if (world && world.collidePlayer) {
            world.collidePlayer(this.model.position, 0.55);
        }
        if (world && world.collideDynamic) {
            world.collideDynamic(this.model.position, 0.55);
        }
        // --- NPC vs NPC push-out ---
        if (allNpcs) {
            for (const other of allNpcs) {
                if (other === this || other._depressed) continue;
                const dx = this.model.position.x - other.model.position.x;
                const dz = this.model.position.z - other.model.position.z;
                const d2 = dx * dx + dz * dz;
                const minD = 1.1;
                if (d2 < minD * minD && d2 > 0.0001) {
                    const d = Math.sqrt(d2);
                    const push = (minD - d) * 0.5 / d;
                    this.model.position.x += dx * push;
                    this.model.position.z += dz * push;
                    other.model.position.x -= dx * push;
                    other.model.position.z -= dz * push;
                }
            }
        }
        // --- Player push-out (character position, always) ---
        if (characterPos) {
            const dx = this.model.position.x - characterPos.x;
            const dz = this.model.position.z - characterPos.z;
            const d2 = dx * dx + dz * dz;
            const minD = 1.0;
            if (d2 < minD * minD && d2 > 0.0001) {
                const d = Math.sqrt(d2);
                const push = (minD - d) / d;
                this.model.position.x += dx * push;
                this.model.position.z += dz * push;
            }
        }

        // --- Look for another NPC nearby to start a conversation ---
        if (allNpcs && !this._chatting && !this._fleeing && !this._crushed) {
            // Throttle: only check occasionally
            this._meetCheck = (this._meetCheck || 0) - dt;
            if (this._meetCheck <= 0) {
                this._meetCheck = 0.6 + Math.random() * 0.4;
                for (const other of allNpcs) {
                    if (other === this) continue;
                    if (other._chatting || other._fleeing || other._crushed || other._depressed) continue;
                    const dx = other.model.position.x - this.model.position.x;
                    const dz = other.model.position.z - this.model.position.z;
                    const d = Math.hypot(dx, dz);
                    if (d < 2.3 && d > 0.4) {
                        // Both enter chatting state
                        this._startChatWith(other);
                        other._startChatWith(this);
                        break;
                    }
                }
            }
        }
    }

    _startChatWith(partner) {
        this._chatting = true;
        this._chatPartner = partner;
        this._chatTimer = 4 + Math.random() * 4;
        this._playMove('walk_stupid.fbx');
        this.bubble?.set(BUBBLE_EMOJIS.CHAT);
    }

    distanceTo(pos) {
        const dx = this.model.position.x - pos.x;
        const dz = this.model.position.z - pos.z;
        return Math.hypot(dx, dz);
    }

    addToScene(scene) { scene.add(this.model); }
    removeFromScene(scene) { scene.remove(this.model); }
}

export class NpcManager {
    constructor(sourceCharacter, scene) {
        this.sourceCharacter = sourceCharacter;
        this.scene = scene;
        this.npcs = [];
        this._manifestData = null;
        this._characterConfig = null;
    }

    setLoaderData(manifestData, characterConfig) {
        this._manifestData = manifestData;
        this._characterConfig = characterConfig;
    }

    setWorld(world) { this._world = world; }

    async spawn(count = 4) {
        for (let i = 0; i < count; i++) {
            // Spawn on a sidewalk (not on the road, not in a building)
            const pos = this._pickSidewalkSpawn(i, count);
            const npc = new NpcGloop(this.sourceCharacter, pos);
            npc.model.rotation.y = Math.atan2(-pos.x, -pos.z);
            if (this._manifestData && this._characterConfig) {
                await npc.initVisuals(this._manifestData, this._characterConfig);
            }
            npc.addToScene(this.scene);
            this.npcs.push(npc);
        }
    }

    /** Returns a Vector3 on a city sidewalk, far from buildings and roads.
     *  In non-city worlds (Sketchbook), falls back to raycast-based ring. */
    _pickSidewalkSpawn(i, count) {
        // Non-city world? Use random ring around player spawn + terrain raycast
        if (this._world && this._world.isCity === false) {
            const origin = this._world.spawns?.player ?? { x: 0, z: 0 };
            for (let tries = 0; tries < 20; tries++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = 6 + Math.random() * 20;
                const x = origin.x + Math.cos(angle) * dist;
                const z = origin.z + Math.sin(angle) * dist;
                const y = this._world.heightAt(x, z);
                if (y > 0.1) return new THREE.Vector3(x, y, z);
            }
            return new THREE.Vector3(origin.x, 0, origin.z);
        }
        // Sidewalks live at ±5m from each road axis (axes at 0, ±28).
        // Pick a road axis, a side, and a position along that axis.
        const axes = [0, 28, -28];
        for (let tries = 0; tries < 40; tries++) {
            const axisIsX = Math.random() < 0.5;
            const axisValue = axes[Math.floor(Math.random() * axes.length)];
            const side = Math.random() < 0.5 ? -1 : 1;
            // Sidewalk strip at offset 5 m from the axis
            const offset = axisValue + side * 5;
            // Position along the perpendicular: spread across the map, avoid
            // crossing other roads (±3 of each axis)
            const alongMax = 45;
            const along = (Math.random() - 0.5) * 2 * alongMax;
            let tooCloseToOtherRoad = false;
            for (const otherAxis of axes) {
                if (otherAxis === axisValue && axisIsX === axisIsX) continue;
                if (Math.abs(along - otherAxis) < 3) { tooCloseToOtherRoad = true; break; }
            }
            if (tooCloseToOtherRoad) continue;
            const x = axisIsX ? offset : along;
            const z = axisIsX ? along  : offset;
            // Stay on the island
            if (Math.hypot(x, z) > 55) continue;
            // Don't spawn inside a block (approximate by distance to block centers)
            let insideBlock = false;
            for (const [bx, bz] of [[14,14],[14,-14],[-14,14],[-14,-14],[14,42],[14,-42],[-14,42],[-14,-42],[42,14],[42,-14],[-42,14],[-42,-14],[42,42],[42,-42],[-42,42],[-42,-42]]) {
                if (Math.abs(x - bx) < 9 && Math.abs(z - bz) < 9) { insideBlock = true; break; }
            }
            if (insideBlock) continue;
            const y = this._world ? this._world.heightAt(x, z) : 0;
            return new THREE.Vector3(x, y, z);
        }
        // Fallback — center plaza
        const angle = (i / count) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(angle) * 8, 0, Math.sin(angle) * 8);
    }

    findClosest(pos, maxDist = 1.8) {
        let best = null;
        let bestD = maxDist;
        for (const npc of this.npcs) {
            const d = npc.distanceTo(pos);
            if (d < bestD) { best = npc; bestD = d; }
        }
        return best;
    }

    update(dt, dialogueOpen, threatPos, world, characterPos) {
        for (const npc of this.npcs) {
            npc.update(dt, dialogueOpen, threatPos, world, this.npcs, characterPos);
        }
    }

    show() { for (const npc of this.npcs) npc.model.visible = true; }
    hide() { for (const npc of this.npcs) npc.model.visible = false; }
    clear() {
        for (const npc of this.npcs) npc.removeFromScene(this.scene);
        this.npcs = [];
    }
}
