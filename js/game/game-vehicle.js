import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Drivable vehicle using Sketchbook's real car/airplane/heli GLB assets.
 *
 * The glb visual replaces my earlier hand-built boxes. Physics stay
 * arcade (no Cannon.js port) but the model looks like a real car now.
 *
 * Wheel meshes are picked up by name if present ("wheel_*" or "RL"/"RR"/"FL"/"FR")
 * so they can spin with speed; otherwise we just translate/rotate the whole group.
 */

const SHARED_LOADER = new GLTFLoader();

const MODEL_URL = 'assets/sketchbook/car.glb';
const AIRPLANE_URL = 'assets/sketchbook/airplane.glb';

// Cache by URL so every vehicle instance reuses the same parsed scene.
const _gltfCache = new Map();

function loadGLTF(url) {
    if (_gltfCache.has(url)) {
        return Promise.resolve(_gltfCache.get(url));
    }
    return new Promise((resolve, reject) => {
        SHARED_LOADER.load(url, (gltf) => {
            _gltfCache.set(url, gltf);
            resolve(gltf);
        }, undefined, reject);
    });
}

export class GameVehicle {
    constructor(scene, opts = {}) {
        this.scene = scene;
        this.url = opts.url || MODEL_URL;
        this.kind = opts.kind || 'car';   // 'car' or 'plane'
        this.group = new THREE.Group();
        this.group.name = 'Vehicle_' + this.kind;

        // Body group so we can tilt/roll independently of wheels
        this.body = new THREE.Group();
        this.group.add(this.body);

        this.wheels = [];        // { mesh, isFront }
        this.loaded = false;

        // Physics state
        this.speed = 0;
        this.maxForwardSpeed = 18;
        this.maxReverseSpeed = -7;
        this.accel = 14;
        this.brake = 22;
        this.friction = 3.5;
        this.turnSpeed = 2.4;
        this.turnSpeedMin = 0.9;

        // Occupant
        this._occupant = null;

        scene.add(this.group);
        this.group.position.set(4, 0, 4);
        this.group.rotation.y = -0.3;

        // Load GLB asynchronously — instance becomes fully visual when done
        this._loadPromise = this._loadModel();
    }

    async _loadModel() {
        try {
            const gltf = await loadGLTF(this.url);
            const model = gltf.scene.clone(true);

            // First pass: hide Sketchbook's Cannon.js collider proxies.
            // Those are meshes whose material is empty (no texture, no
            // material name) — they exist only to build physics bodies.
            const proxiesToHide = [];
            model.traverse((child) => {
                if (!child.isMesh) return;
                const mat = child.material;
                const hasMat = mat && (mat.name || mat.map);
                if (!hasMat) proxiesToHide.push(child);
            });
            for (const m of proxiesToHide) m.visible = false;

            // Second pass: center on ground
            const bbox = new THREE.Box3();
            // Build bbox from visible meshes only (proxies are large boxes)
            model.traverse(c => { if (c.isMesh && c.visible) bbox.expandByObject(c); });
            if (!isFinite(bbox.min.y)) bbox.setFromObject(model);
            const minY = bbox.min.y;
            model.position.y -= minY;

            // Third pass: register visible wheel meshes + shadows
            model.traverse((child) => {
                if (!child.isMesh || !child.visible) return;
                child.castShadow = true;
                child.receiveShadow = true;
                const n = (child.name || '').toLowerCase();
                const matName = (child.material && child.material.name || '').toLowerCase();
                if (n.includes('wheel') || matName === 'wheel' || /cylinder/.test(n)) {
                    if (!n.includes('steering')) {
                        this.wheels.push({
                            mesh: child,
                            baseRot: child.rotation.clone(),
                        });
                    }
                }
            });

            this.body.add(model);
            this.model = model;
            this.loaded = true;
        } catch (e) {
            console.error('[GameVehicle] Failed to load', this.url, e);
            this._addFallbackBox();
        }
    }

    _addFallbackBox() {
        // If the GLB fails to load, at least show something red.
        const fallback = new THREE.Mesh(
            new THREE.BoxGeometry(1.6, 0.6, 3),
            new THREE.MeshStandardMaterial({ color: 0xe94560 })
        );
        fallback.position.y = 0.4;
        this.body.add(fallback);
    }

    get position() { return this.group.position; }
    getCameraTarget() { return this.group.position; }

    enter(character) {
        if (this._occupant) return false;
        this._occupant = character;
        // Keep the character visible — in T-pose (no animation weights)
        character.model.visible = true;
        return true;
    }

    exit() {
        const c = this._occupant;
        if (!c) return null;
        c.model.visible = true;
        const leftX = this.group.position.x - Math.cos(this.group.rotation.y) * 1.8;
        const leftZ = this.group.position.z + Math.sin(this.group.rotation.y) * 1.8;
        c.model.position.set(leftX, 0, leftZ);
        this._occupant = null;
        return c;
    }

    isOccupied() { return !!this._occupant; }

    drive(dt, input, world, npcManager) {
        if (this.kind === 'plane') {
            this._flyPlane(dt, input);
            return;
        }
        const { forward, strafe } = input;

        // Accelerate / brake
        if (forward > 0) {
            this.speed += this.accel * dt * forward;
        } else if (forward < 0) {
            if (this.speed > 0) this.speed += -this.brake * dt;
            else this.speed += -this.accel * dt;
        } else {
            const decel = this.friction * dt;
            if (Math.abs(this.speed) < decel) this.speed = 0;
            else this.speed -= Math.sign(this.speed) * decel;
        }
        this.speed = Math.max(this.maxReverseSpeed, Math.min(this.maxForwardSpeed, this.speed));

        // Turning
        let turnAmount = 0;
        if (Math.abs(this.speed) > 0.2) {
            const speedFactor = Math.abs(this.speed) / this.maxForwardSpeed;
            const turnScale = this.turnSpeed + (this.turnSpeedMin - this.turnSpeed) * speedFactor;
            const dir = this.speed > 0 ? 1 : -1;
            turnAmount = strafe * turnScale * dt * dir;
            this.group.rotation.y -= turnAmount;
        }

        // Move along new heading
        const yaw = this.group.rotation.y;
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        this.group.position.x += fx * this.speed * dt;
        this.group.position.z += fz * this.speed * dt;

        // Collisions with world obstacles — kill speed on hit
        if (world && world.collideVehicle) {
            const hit = world.collideVehicle(this.group.position, 0.95);
            if (hit) {
                // Bounce back and lose most of our speed
                this.speed *= -0.2;
            }
        }

        // Crush NPCs on impact at speed
        if (npcManager && Math.abs(this.speed) > 4) {
            const carX = this.group.position.x;
            const carZ = this.group.position.z;
            for (const npc of npcManager.npcs) {
                if (npc._crushed) continue;
                const dx = npc.model.position.x - carX;
                const dz = npc.model.position.z - carZ;
                if (dx * dx + dz * dz < 1.8 * 1.8) {
                    npc.crush(fx, fz, Math.abs(this.speed));
                }
            }
        }

        // Spin wheels
        const rot = this.speed * dt / 0.35;
        for (const w of this.wheels) {
            w.mesh.rotation.x += rot;
        }

        // Body juice: roll + pitch
        const rollTarget = -turnAmount * 9;
        const pitchTarget = (forward !== 0 ? -forward * 0.05 : 0);
        const k = Math.min(1, 10 * dt);
        this.body.rotation.z += (rollTarget - this.body.rotation.z) * k;
        this.body.rotation.x += (pitchTarget - this.body.rotation.x) * k;

        // Occupant (in T-pose) sits on top of the chassis and rotates with the car
        if (this._occupant) {
            this._occupant.model.position.set(
                this.group.position.x,
                this.group.position.y + 0.9,
                this.group.position.z
            );
            this._occupant.model.rotation.y = this.group.rotation.y;
        }
    }

    /**
     * Arcade flight physics for the airplane.
     *
     * Controls:
     *   W / S       → throttle up / down
     *   A / D       → yaw left / right
     *   Space       → pitch up (climb)
     *   Shift       → pitch down (dive)
     */
    _flyPlane(dt, input) {
        const { forward, strafe, climb, dive } = input;
        // Throttle
        if (forward > 0) this.speed += this.accel * dt;
        else if (forward < 0) this.speed -= this.brake * dt;
        else this.speed -= this.friction * dt * 0.5;
        this.speed = Math.max(0, Math.min(22, this.speed));

        // Yaw (A/D)
        this.group.rotation.y -= strafe * 0.9 * dt;

        // Pitch (Space climb / Shift dive)
        const pitchInput = (climb ? 1 : 0) - (dive ? 1 : 0);
        this.group.rotation.x -= pitchInput * 0.8 * dt;
        this.group.rotation.x = Math.max(-0.8, Math.min(0.8, this.group.rotation.x));

        // Forward velocity in world space (considering pitch)
        const yaw = this.group.rotation.y;
        const pitch = this.group.rotation.x;
        const cosP = Math.cos(pitch);
        const fx = Math.sin(yaw) * cosP;
        const fy = -Math.sin(pitch);
        const fz = Math.cos(yaw) * cosP;
        this.group.position.x += fx * this.speed * dt;
        this.group.position.y += fy * this.speed * dt;
        this.group.position.z += fz * this.speed * dt;

        // Subtle gravity if we're above the ground — lose altitude slowly
        if (this.group.position.y > 0) this.group.position.y -= 1.5 * dt;
        // Ground collision
        if (this.group.position.y < 0) {
            this.group.position.y = 0;
            this.speed *= 0.6;
        }

        // Propeller spin (first wheel if any — used as visual prop)
        if (this.wheels.length > 0) {
            this.wheels[0].mesh.rotation.x += this.speed * dt * 4;
        }

        // Occupant (T-pose) sits on the plane
        if (this._occupant) {
            this._occupant.model.position.set(
                this.group.position.x,
                this.group.position.y + 0.9,
                this.group.position.z
            );
            this._occupant.model.rotation.y = this.group.rotation.y;
        }
    }

    /** Extra flight input flags set by the Player read-input hook. */
    setFlightInput(flags) { this._input = flags; }
}
