import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { makeGLTFLoader } from '../gltf-loader.js';

/**
 * Drivable vehicle using Sketchbook's real car/airplane/heli GLB assets.
 *
 * The glb visual replaces my earlier hand-built boxes. Physics stay
 * arcade (no Cannon.js port) but the model looks like a real car now.
 *
 * Wheel meshes are picked up by name if present ("wheel_*" or "RL"/"RR"/"FL"/"FR")
 * so they can spin with speed; otherwise we just translate/rotate the whole group.
 */

const SHARED_LOADER = makeGLTFLoader();

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

        // Cannon-es physics (enabled only for cars, after the model loads
        // and Game wires the physics world via setPhysicsWorld)
        this.physicsWorld  = null;
        this.chassisBody   = null;
        this.raycastVehicle = null;
        this._usePhysics    = false;
        this._tmpV3 = new CANNON.Vec3();

        scene.add(this.group);
        // Default spawn at a clear, open spot — overridden by Game.enter()
        // for the main car using world.carSpawn
        this.group.position.set(4, 0, 4);
        this.group.rotation.y = -0.3;

        // Load GLB asynchronously — instance becomes fully visual when done
        this._loadPromise = this._loadModel();
    }

    /**
     * Wire the cannon-es world. Triggers physics init once the model is
     * loaded (cars only). Planes/helis keep arcade physics.
     */
    setPhysicsWorld(physicsWorld) {
        this.physicsWorld = physicsWorld;
        const init = () => {
            if (this.kind === 'car') this._initPhysics();
            else if (this.kind === 'heli') this._initHeliPhysics();
            else if (this.kind === 'plane') this._initPlanePhysics();
        };
        if (this.loaded) init();
        else this._loadPromise.then(init);
    }

    /**
     * Sketchbook-style helicopter physics (ported from Helicopter.ts).
     * A cannon body has a preStep callback that applies thrust, yaw,
     * pitch, roll and vertical stabilization based on input state.
     */
    _initHeliPhysics() {
        if (!this.physicsWorld || this._usePhysicsHeli) return;
        const world = this.physicsWorld.world;

        const body = new CANNON.Body({
            mass: 50,
            material: this.physicsWorld.getMaterial('heli', {
                friction: 0.4, restitution: 0.1,
            }),
        });
        body.addShape(new CANNON.Box(new CANNON.Vec3(1.8, 0.8, 2.2)));
        body.position.set(
            this.group.position.x,
            this.group.position.y + 1.0,
            this.group.position.z,
        );
        body.quaternion.setFromEuler(0, this.group.rotation.y, 0);
        body.linearDamping = 0;
        body.angularDamping = 0;
        body.allowSleep = false;

        this.chassisBody = body;
        this._usePhysicsHeli = true;
        this._enginePower = 0;
        this._bodyRestHeight = 1.0;
        this._heliInput = { ascend:false, descend:false, pitchUp:false, pitchDown:false,
                            yawLeft:false, yawRight:false, rollLeft:false, rollRight:false };

        world.addBody(body);
        // Subscribe to the cannon world's preStep event so our forces
        // are applied every SUB-STEP (1/60s), matching Sketchbook.
        world.addEventListener('preStep', this._heliPreStepListener = () => this._heliPreStep());
        console.log('[vehicle] cannon helicopter physics attached');
    }

    /**
     * Sketchbook-style airplane physics (ported from Airplane.ts).
     * Throttle → forward thrust. Lift & drag ∝ velocity². Stabilization
     * aligns the plane with its velocity direction.
     */
    _initPlanePhysics() {
        if (!this.physicsWorld || this._usePhysicsPlane) return;
        const world = this.physicsWorld.world;

        const body = new CANNON.Body({
            mass: 50,
            material: this.physicsWorld.getMaterial('plane', {
                friction: 0.4, restitution: 0.1,
            }),
        });
        body.addShape(new CANNON.Box(new CANNON.Vec3(2.0, 0.6, 3.0)));
        body.position.set(
            this.group.position.x,
            this.group.position.y + 0.8,
            this.group.position.z,
        );
        body.quaternion.setFromEuler(0, this.group.rotation.y, 0);
        body.linearDamping = 0;
        body.angularDamping = 0;
        body.allowSleep = false;

        this.chassisBody = body;
        this._usePhysicsPlane = true;
        this._enginePower = 0;
        this._bodyRestHeight = 0.8;
        this._lastDrag = 0;
        this._planeInput = { throttle:false, brake:false, pitchUp:false, pitchDown:false,
                              yawLeft:false, yawRight:false, rollLeft:false, rollRight:false };

        world.addBody(body);
        world.addEventListener('preStep', this._planePreStepListener = () => this._planePreStep());
        console.log('[vehicle] cannon airplane physics attached');
    }

    /** Applied every frame — Sketchbook's heli math scaled up 4× to
     *  compensate for running once/frame instead of once/sub-step. */
    _heliPreStep() {
        const body = this.chassisBody;
        if (!body) return;
        const q = body.quaternion;
        const tq = new THREE.Quaternion(q.x, q.y, q.z, q.w);
        const right   = new THREE.Vector3(1, 0, 0).applyQuaternion(tq);
        const up      = new THREE.Vector3(0, 1, 0).applyQuaternion(tq);
        const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(tq);
        const globalUp = new THREE.Vector3(0, 1, 0);
        const inp = this._heliInput;
        const power = this._enginePower;
        // Thrust multiplier — snappy Sketchbook feel at our framerate.
        const K = 3;

        // Ascend / descend thrust along local up
        if (inp.ascend) {
            body.velocity.x += up.x * 0.15 * power * K;
            body.velocity.y += up.y * 0.15 * power * K;
            body.velocity.z += up.z * 0.15 * power * K;
        }
        if (inp.descend) {
            body.velocity.x -= up.x * 0.15 * power * K;
            body.velocity.y -= up.y * 0.15 * power * K;
            body.velocity.z -= up.z * 0.15 * power * K;
        }

        // Vertical stabilization — counter gravity when the rotor is spinning
        const gravity = this.physicsWorld.world.gravity;
        let gravComp = Math.sqrt(gravity.x * gravity.x + gravity.y * gravity.y + gravity.z * gravity.z);
        gravComp *= this.physicsWorld._fixedTimeStep;
        gravComp *= 0.98;
        gravComp *= K;
        const dot = Math.max(0, Math.min(1, globalUp.dot(up)));
        gravComp *= Math.sqrt(dot);
        const vertDamp = -body.velocity.y * 0.04;
        body.velocity.x += up.x * gravComp * power;
        body.velocity.y += (up.y * gravComp + vertDamp) * power;
        body.velocity.z += up.z * gravComp * power;

        // Positional damping (air resistance)
        const damp = THREE.MathUtils.lerp(1, 0.995, power);
        body.velocity.x *= damp;
        body.velocity.z *= damp;

        // Rotation self-level when someone is in the seat
        if (this._occupant) {
            const rotStab = new THREE.Quaternion().setFromUnitVectors(up, globalUp);
            const rotEuler = new THREE.Euler().setFromQuaternion(rotStab);
            body.angularVelocity.x += rotEuler.x * 0.3 * power;
            body.angularVelocity.y += rotEuler.y * 0.3 * power;
            body.angularVelocity.z += rotEuler.z * 0.3 * power;
        }

        const KA = 2;
        // Pitch (W down, S up)
        if (inp.pitchUp) {
            body.angularVelocity.x -= right.x * 0.07 * power * KA;
            body.angularVelocity.y -= right.y * 0.07 * power * KA;
            body.angularVelocity.z -= right.z * 0.07 * power * KA;
        }
        if (inp.pitchDown) {
            body.angularVelocity.x += right.x * 0.07 * power * KA;
            body.angularVelocity.y += right.y * 0.07 * power * KA;
            body.angularVelocity.z += right.z * 0.07 * power * KA;
        }
        // Yaw (A/D)
        if (inp.yawLeft) {
            body.angularVelocity.x += up.x * 0.07 * power * KA;
            body.angularVelocity.y += up.y * 0.07 * power * KA;
            body.angularVelocity.z += up.z * 0.07 * power * KA;
        }
        if (inp.yawRight) {
            body.angularVelocity.x -= up.x * 0.07 * power * KA;
            body.angularVelocity.y -= up.y * 0.07 * power * KA;
            body.angularVelocity.z -= up.z * 0.07 * power * KA;
        }
        // Roll (Q/E)
        if (inp.rollLeft) {
            body.angularVelocity.x -= forward.x * 0.07 * power;
            body.angularVelocity.y -= forward.y * 0.07 * power;
            body.angularVelocity.z -= forward.z * 0.07 * power;
        }
        if (inp.rollRight) {
            body.angularVelocity.x += forward.x * 0.07 * power;
            body.angularVelocity.y += forward.y * 0.07 * power;
            body.angularVelocity.z += forward.z * 0.07 * power;
        }

        // Angular damping
        body.angularVelocity.x *= 0.97;
        body.angularVelocity.y *= 0.97;
        body.angularVelocity.z *= 0.97;
    }

    /** Applied every physics step by cannon — Sketchbook's plane math. */
    _planePreStep() {
        const body = this.chassisBody;
        if (!body) return;
        const q = body.quaternion;
        const tq = new THREE.Quaternion(q.x, q.y, q.z, q.w);
        const right   = new THREE.Vector3(1, 0, 0).applyQuaternion(tq);
        const up      = new THREE.Vector3(0, 1, 0).applyQuaternion(tq);
        const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(tq);
        const inp = this._planeInput;
        const power = this._enginePower;

        const velLen = Math.sqrt(
            body.velocity.x * body.velocity.x +
            body.velocity.y * body.velocity.y +
            body.velocity.z * body.velocity.z
        );
        const currentSpeed =
            body.velocity.x * forward.x +
            body.velocity.y * forward.y +
            body.velocity.z * forward.z;
        let flightInfluence = THREE.MathUtils.clamp(currentSpeed / 10, 0, 1);

        // Rotation stabilization — align the nose with the velocity vector
        if (velLen > 0.1) {
            const lookVel = new THREE.Vector3(
                body.velocity.x, body.velocity.y, body.velocity.z
            ).normalize();
            const stabQ = new THREE.Quaternion().setFromUnitVectors(forward, lookVel);
            const stabEul = new THREE.Euler().setFromQuaternion(stabQ);
            const infl = Math.min(0.1, Math.max(0, velLen - 1));
            const loopFix = (inp.throttle && currentSpeed > 0) ? 0 : 1;
            body.angularVelocity.x += stabEul.x * infl * loopFix * 0.3;
            body.angularVelocity.y += stabEul.y * infl * 0.3;
            body.angularVelocity.z += stabEul.z * infl * loopFix * 0.3;
        }

        // Pitch (W down / S up)
        if (inp.pitchUp) {
            body.angularVelocity.x -= right.x * 0.04 * flightInfluence * power;
            body.angularVelocity.y -= right.y * 0.04 * flightInfluence * power;
            body.angularVelocity.z -= right.z * 0.04 * flightInfluence * power;
        }
        if (inp.pitchDown) {
            body.angularVelocity.x += right.x * 0.04 * flightInfluence * power;
            body.angularVelocity.y += right.y * 0.04 * flightInfluence * power;
            body.angularVelocity.z += right.z * 0.04 * flightInfluence * power;
        }
        // Yaw
        if (inp.yawLeft) {
            body.angularVelocity.x += up.x * 0.02 * flightInfluence * power;
            body.angularVelocity.y += up.y * 0.02 * flightInfluence * power;
            body.angularVelocity.z += up.z * 0.02 * flightInfluence * power;
        }
        if (inp.yawRight) {
            body.angularVelocity.x -= up.x * 0.02 * flightInfluence * power;
            body.angularVelocity.y -= up.y * 0.02 * flightInfluence * power;
            body.angularVelocity.z -= up.z * 0.02 * flightInfluence * power;
        }
        // Roll
        if (inp.rollLeft) {
            body.angularVelocity.x -= forward.x * 0.055 * flightInfluence * power;
            body.angularVelocity.y -= forward.y * 0.055 * flightInfluence * power;
            body.angularVelocity.z -= forward.z * 0.055 * flightInfluence * power;
        }
        if (inp.rollRight) {
            body.angularVelocity.x += forward.x * 0.055 * flightInfluence * power;
            body.angularVelocity.y += forward.y * 0.055 * flightInfluence * power;
            body.angularVelocity.z += forward.z * 0.055 * flightInfluence * power;
        }

        const K = 3;

        // Thrust — accumulates forward velocity, held in check by drag
        let speedMod = 0.02;
        if (inp.throttle && !inp.brake) speedMod = 0.06;
        else if (!inp.throttle && inp.brake) speedMod = -0.05;
        const thrust = (velLen * this._lastDrag + speedMod) * power * K;
        body.velocity.x += forward.x * thrust;
        body.velocity.y += forward.y * thrust;
        body.velocity.z += forward.z * thrust;

        // Drag ∝ |v|
        const drag = velLen * 0.003 * power;
        body.velocity.x -= body.velocity.x * drag;
        body.velocity.y -= body.velocity.y * drag;
        body.velocity.z -= body.velocity.z * drag;
        this._lastDrag = drag;

        // Lift ∝ |v| along local up (like a real wing)
        const lift = Math.min(0.2, velLen * 0.005 * power * K);
        body.velocity.x += up.x * lift;
        body.velocity.y += up.y * lift;
        body.velocity.z += up.z * lift;

        // Angular damping in flight mode
        const ad = THREE.MathUtils.lerp(1, 0.98, flightInfluence);
        body.angularVelocity.x *= ad;
        body.angularVelocity.y *= ad;
        body.angularVelocity.z *= ad;
    }

    _initPhysics() {
        if (!this.physicsWorld || this._usePhysics) return;

        const world = this.physicsWorld.world;

        // Chassis collider is INTENTIONALLY smaller than the visual car:
        // - half-width  (X): 0.75  (vs visible ~1.0)
        // - half-height (Y): 0.30  — thin so it clears ramp edges
        // - half-length (Z): 1.4   (vs visible ~2.0)
        // Wheels carry all ground contact; the chassis shape is there
        // only to collide with walls/buildings from the side.
        const halfEx = new CANNON.Vec3(0.75, 0.30, 1.4);
        const chassisShape = new CANNON.Box(halfEx);
        const chassisBody = new CANNON.Body({
            mass: 200,
            material: this.physicsWorld.getMaterial('vehicle', {
                friction: 0.3,
                restitution: 0.1,
            }),
        });
        chassisBody.addShape(chassisShape);
        // Seed chassis above the ground so wheels can settle
        chassisBody.position.set(
            this.group.position.x,
            this.group.position.y + 0.9,
            this.group.position.z,
        );
        chassisBody.quaternion.setFromEuler(0, this.group.rotation.y, 0);
        chassisBody.angularDamping = 0.35;
        chassisBody.linearDamping  = 0.01;
        // Important for stability: prevent the chassis from sleeping
        chassisBody.allowSleep = false;

        // RaycastVehicle
        const vehicle = new CANNON.RaycastVehicle({
            chassisBody,
            indexRightAxis:   0,   // X
            indexUpAxis:      1,   // Y
            indexForwardAxis: 2,   // Z
        });

        const WHEEL_R = 0.35;
        const REST_LEN = 0.8;    // long — ray reaches down well below rest

        const wheelOptions = {
            radius: WHEEL_R,
            directionLocal: new CANNON.Vec3(0, -1, 0),
            suspensionStiffness: 25,
            suspensionRestLength: REST_LEN,
            frictionSlip: 3.0,
            dampingRelaxation: 2.3,
            dampingCompression: 4.4,
            maxSuspensionForce: 100000,
            rollInfluence: 0.03,
            axleLocal: new CANNON.Vec3(1, 0, 0),
            chassisConnectionPointLocal: new CANNON.Vec3(0, 0, 0),
            maxSuspensionTravel: 0.6,
            customSlidingRotationalSpeed: -30,
            useCustomSlidingRotationalSpeed: true,
        };
        const halfWidth  = 0.75;
        const halfLength = 1.2;
        const connectY   = 0;    // wheels attach at body center; long suspension extends down
        // FL / FR / RL / RR
        wheelOptions.chassisConnectionPointLocal.set(-halfWidth, connectY,  halfLength);
        vehicle.addWheel(wheelOptions);
        wheelOptions.chassisConnectionPointLocal.set( halfWidth, connectY,  halfLength);
        vehicle.addWheel(wheelOptions);
        wheelOptions.chassisConnectionPointLocal.set(-halfWidth, connectY, -halfLength);
        vehicle.addWheel(wheelOptions);
        wheelOptions.chassisConnectionPointLocal.set( halfWidth, connectY, -halfLength);
        vehicle.addWheel(wheelOptions);

        vehicle.addToWorld(world);

        // Resting height: body.y = |connectY| + REST_LEN + WHEEL_R
        // With connectY=-0.2, REST=0.6, WHEEL=0.4 → body.y=1.2 at rest.
        this._bodyRestHeight = Math.abs(connectY) + REST_LEN + WHEEL_R;

        this.chassisBody   = chassisBody;
        this.raycastVehicle = vehicle;
        this._usePhysics    = true;

        console.log('[vehicle] cannon-es RaycastVehicle attached');
    }

    /** Sync visuals from the chassis body + anti-fall safety.
     *  Works for car (_usePhysics), heli (_usePhysicsHeli) and plane
     *  (_usePhysicsPlane). */
    syncVisuals() {
        if (!this.chassisBody) return;
        if (!this._usePhysics && !this._usePhysicsHeli && !this._usePhysicsPlane) return;
        const body = this.chassisBody;
        const h = this._bodyRestHeight ?? 0.9;
        // Safety: if the body sinks below the ground, put it back up.
        // We DON'T do this for flyers in the air — they can legitimately
        // be at y>0. Only fires when they're clearly underground.
        if (body.position.y < -2) {
            body.position.y = h + 1;
            body.velocity.set(0, 0, 0);
            body.angularVelocity.set(0, 0, 0);
        }
        this.group.position.set(body.position.x, body.position.y - h, body.position.z);
        this.group.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    }

    /** Teleport the physics body to match the current visual group position.
     *  Adds a small extra-lift so wheels immediately detect ground even if
     *  raycast length is borderline (floating-point safety). */
    teleportBodyToGroup() {
        if (!this.chassisBody) return;
        const g = this.group.position;
        const h = (this._bodyRestHeight ?? 0.9) + 0.15;   // safety margin
        this.chassisBody.position.set(g.x, g.y + h, g.z);
        this.chassisBody.velocity.set(0, 0, 0);
        this.chassisBody.angularVelocity.set(0, 0, 0);
        this.chassisBody.quaternion.setFromEuler(0, this.group.rotation.y, 0);
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

            // Third pass: register visible wheel / rotor / prop meshes
            // (Sketchbook uses userData.data==='rotor' tags — we fall
            //  back to name matching since our GLBs don't carry those).
            this.rotors = [];
            model.traverse((child) => {
                if (!child.isMesh || !child.visible) return;
                child.castShadow = true;
                child.receiveShadow = true;
                const n = (child.name || '').toLowerCase();
                const matName = (child.material && child.material.name || '').toLowerCase();
                // Strict wheel detection — only tag meshes that EXPLICITLY
                // say wheel in their name or material. The previous regex
                // /cylinder/ caught unrelated cylindrical details (exhaust
                // pipe, steering column, etc.) and made them spin, which
                // ended up looking like a wheel popping out of the car.
                const isWheel =
                    (n.includes('wheel') || matName.includes('wheel'))
                    && !n.includes('steering')
                    && !n.includes('fender')
                    && !n.includes('arch');
                if (isWheel) {
                    this.wheels.push({
                        mesh: child,
                        baseRot: child.rotation.clone(),
                    });
                }
                // Rotor detection (heli/plane) — named rotor, blade, prop
                if (n.includes('rotor') || n.includes('blade') || n.includes('prop') || n.includes('helice')) {
                    this.rotors.push({
                        mesh: child,
                        axis: n.includes('tail') ? 'z' : 'y',
                    });
                }
            });
            // Fallback for heli/plane GLBs without named rotors: pick
            // the flattest wide meshes (rotor blades are typically
            // very thin on one axis compared to the other two).
            if (this.rotors.length === 0 && (this.kind === 'heli' || this.kind === 'plane')) {
                const candidates = [];
                model.traverse((c) => {
                    if (!c.isMesh || !c.visible) return;
                    c.geometry?.computeBoundingBox?.();
                    const bb = c.geometry?.boundingBox;
                    if (!bb) return;
                    const dx = bb.max.x - bb.min.x;
                    const dy = bb.max.y - bb.min.y;
                    const dz = bb.max.z - bb.min.z;
                    const volume = dx * dy * dz;
                    const min = Math.min(dx, dy, dz);
                    const max = Math.max(dx, dy, dz);
                    const flatness = min / max;   // rotor blades are very flat → flatness near 0
                    const center = new THREE.Vector3(
                        (bb.min.x + bb.max.x) / 2,
                        (bb.min.y + bb.max.y) / 2,
                        (bb.min.z + bb.max.z) / 2,
                    );
                    candidates.push({ mesh: c, flatness, centerY: center.y, max, volume });
                });
                // Prefer very flat + wide mesh high on the body (Y-topmost)
                candidates.sort((a, b) => {
                    // lower flatness first, then higher Y
                    if (Math.abs(a.flatness - b.flatness) > 0.02) return a.flatness - b.flatness;
                    return b.centerY - a.centerY;
                });
                if (candidates[0] && candidates[0].flatness < 0.25) {
                    this.rotors.push({ mesh: candidates[0].mesh, axis: 'y' });
                }
            }
            console.log(`[vehicle ${this.kind}] loaded — ${this.wheels.length} wheels, ${this.rotors.length} rotors`);

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
        const g = this.group.position;
        const leftX = g.x - Math.cos(this.group.rotation.y) * 1.8;
        const leftZ = g.z + Math.sin(this.group.rotation.y) * 1.8;
        // Place character at the vehicle's Y (not forced to ground).
        // If the vehicle is airborne, the player starts falling and the
        // GamePlayer gravity integrator takes over → skydive from heli/plane.
        c.model.position.set(leftX, g.y + 0.5, leftZ);
        this._occupant = null;
        // Return exit info so Game can decide to trigger a fall state
        return { character: c, exitY: g.y + 0.5, wasAirborne: g.y > 1.5 };
    }

    isOccupied() { return !!this._occupant; }

    drive(dt, input, world, npcManager) {
        if (this.kind === 'plane') {
            if (this._usePhysicsPlane) { this._drivePlanePhysics(dt, input); return; }
            this._flyPlane(dt, input);
            return;
        }
        if (this.kind === 'heli') {
            if (this._usePhysicsHeli)  { this._driveHeliPhysics(dt, input);  return; }
            this._flyHeli(dt, input);
            return;
        }
        if (this._usePhysics && this.raycastVehicle) {
            this._drivePhysics(dt, input, world, npcManager);
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
     * Cannon-es RaycastVehicle driver. Sends inputs (forward/strafe) as
     * engine force, steering angle and brake pressure, then syncs the
     * visual group position/quaternion to the chassis body.
     *
     * Crushes NPCs on impact when the chassis velocity is high enough.
     */
    _drivePhysics(dt, input, world, npcManager) {
        const { forward, strafe } = input;
        const rv = this.raycastVehicle;
        const body = this.chassisBody;

        // Tunables (beefier so the car can actually climb steep ramps)
        const MAX_ENGINE   = 4200;      // N on each rear wheel
        const BRAKE_STRONG = 30;
        const BRAKE_IDLE   = 1.0;
        const STEER_MAX    = 0.55;
        const STEER_SPEED_DAMP = 0.55;

        // Current speed (forward component along chassis +Z)
        const vel = body.velocity;
        const fwdLocal = new CANNON.Vec3(0, 0, 1);
        const fwdWorld = new CANNON.Vec3();
        body.quaternion.vmult(fwdLocal, fwdWorld);
        const forwardSpeed = vel.dot(fwdWorld);
        this.speed = forwardSpeed;   // expose for legacy consumers (HUD etc.)

        // Engine force on rear wheels (2, 3). Negative pushes in local
        // -Z which for this car model is "forward" (nose direction).
        let engine = 0;
        if (forward > 0) engine = -MAX_ENGINE * forward;
        else if (forward < 0) engine = -MAX_ENGINE * forward * 0.55;
        rv.applyEngineForce(engine, 2);
        rv.applyEngineForce(engine, 3);
        // Increase engine power when on a ramp (boost to climb)
        const upY = fwdWorld.y;   // forward-world Y component (non-zero on slope)
        void upY;

        // Brakes on all wheels — strong when input opposes current motion
        let brake = 0;
        if (forward < 0 && forwardSpeed > 1)  brake = BRAKE_STRONG;
        else if (forward > 0 && forwardSpeed < -1) brake = BRAKE_STRONG;
        else if (forward === 0) brake = BRAKE_IDLE;
        for (let i = 0; i < 4; i++) rv.setBrake(brake, i);

        // Steering on front wheels (0, 1) — less lock at high speed
        const speedAbs = Math.abs(forwardSpeed);
        const lock = STEER_MAX * (1 - Math.min(1, speedAbs / 18) * STEER_SPEED_DAMP);
        const steerAngle = -strafe * lock;
        rv.setSteeringValue(steerAngle, 0);
        rv.setSteeringValue(steerAngle, 1);

        // Sync visuals — group follows chassis body.
        const syncH = this._bodyRestHeight ?? 0.9;
        this.group.position.set(body.position.x, body.position.y - syncH, body.position.z);
        this.group.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
        // Reset the inner "body" roll/pitch cosmetics (chassis does it now)
        this.body.rotation.set(0, 0, 0);

        // Spin wheel meshes (visual only — not synced to RaycastVehicle yet)
        const wheelRot = forwardSpeed * dt / 0.35;
        for (const w of this.wheels) {
            w.mesh.rotation.x += wheelRot;
        }

        // Crush NPCs on high-speed contact
        if (npcManager && speedAbs > 4) {
            const px = body.position.x;
            const pz = body.position.z;
            const fx = fwdWorld.x, fz = fwdWorld.z;
            for (const npc of npcManager.npcs) {
                if (npc._crushed) continue;
                const dx = npc.model.position.x - px;
                const dz = npc.model.position.z - pz;
                if (dx * dx + dz * dz < 1.8 * 1.8) {
                    npc.crush(fx, fz, speedAbs);
                }
            }
        }

        // Keep the occupant sitting on the chassis
        if (this._occupant) {
            this._occupant.model.position.set(
                this.group.position.x,
                this.group.position.y + 0.9,
                this.group.position.z,
            );
            // Yaw only, to avoid the character tilting sideways when the car does
            const yaw = Math.atan2(fwdWorld.x, fwdWorld.z);
            this._occupant.model.rotation.y = yaw;
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
    _driveHeliPhysics(dt, input) {
        // Engine spins up FAST so the chopper doesn't plummet on entry
        if (this._occupant) {
            this._enginePower = Math.min(1, (this._enginePower || 0) + dt * 3);
        } else {
            this._enginePower = Math.max(0, (this._enginePower || 0) - dt * 0.4);
        }
        const { forward, strafe, climb, dive } = input;
        this._heliInput.ascend    = !!climb;
        this._heliInput.descend   = !!dive;
        this._heliInput.pitchDown = forward > 0.2;
        this._heliInput.pitchUp   = forward < -0.2;
        this._heliInput.yawLeft   = strafe < -0.2;
        this._heliInput.yawRight  = strafe > 0.2;
        this._heliInput.rollLeft  = false;
        this._heliInput.rollRight = false;
        // (preStep runs automatically via world 'preStep' event)

        // Sync visuals from the chassis body
        const body = this.chassisBody;
        const h = this._bodyRestHeight ?? 1.0;
        this.group.position.set(body.position.x, body.position.y - h, body.position.z);
        this.group.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);

        // Spin the rotors (named rotor/blade/prop in the GLB — falls
        // back to "wheels" if none were found)
        const spin = this._enginePower * dt * 40;
        if (this.rotors && this.rotors.length > 0) {
            for (const r of this.rotors) {
                r.mesh.rotation[r.axis] += spin;
            }
        } else {
            for (const w of this.wheels) w.mesh.rotation.y += spin;
        }

        // Occupant
        if (this._occupant) {
            this._occupant.model.position.set(
                this.group.position.x,
                this.group.position.y + 0.9,
                this.group.position.z,
            );
            this._occupant.model.rotation.y = this.group.rotation.y;
        }
    }

    _drivePlanePhysics(dt, input) {
        if (this._occupant) {
            this._enginePower = Math.min(1, (this._enginePower || 0) + dt * 2);
        } else {
            this._enginePower = Math.max(0, (this._enginePower || 0) - dt * 0.2);
        }
        const { forward, strafe, climb, dive } = input;
        this._planeInput.throttle  = forward > 0.2;     // W = throttle
        this._planeInput.brake     = forward < -0.2;    // S = brake/reverse
        this._planeInput.pitchDown = !!dive;            // Shift → dive
        this._planeInput.pitchUp   = !!climb;           // Space → climb
        this._planeInput.yawLeft   = strafe < -0.2;     // A
        this._planeInput.yawRight  = strafe > 0.2;      // D
        this._planeInput.rollLeft  = false;
        this._planeInput.rollRight = false;

        const body = this.chassisBody;
        const h = this._bodyRestHeight ?? 0.8;
        this.group.position.set(body.position.x, body.position.y - h, body.position.z);
        this.group.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);

        // Spin the prop (named in GLB; fallback to first wheel)
        const spinP = this._enginePower * dt * 60;
        if (this.rotors && this.rotors.length > 0) {
            for (const r of this.rotors) r.mesh.rotation[r.axis] += spinP;
        } else if (this.wheels[0]) {
            this.wheels[0].mesh.rotation.x += spinP;
        }

        if (this._occupant) {
            this._occupant.model.position.set(
                this.group.position.x,
                this.group.position.y + 0.9,
                this.group.position.z,
            );
            this._occupant.model.rotation.y = this.group.rotation.y;
        }
    }

    _flyPlane(dt, input) {
        const { forward, strafe, climb, dive } = input;
        // Sketchbook-style plane: throttle builds lift, gravity eats
        // altitude if speed is too low.
        // Throttle
        if (forward > 0) this.speed += 10 * dt;
        else if (forward < 0) this.speed -= 14 * dt;
        else this.speed -= 2 * dt;    // passive drag
        this.speed = Math.max(0, Math.min(30, this.speed));

        // Yaw (A/D) — scales with speed so plane can't pirouette on ground
        const yawScale = Math.min(1, this.speed / 8);
        this.group.rotation.y -= strafe * 1.1 * yawScale * dt;

        // Pitch (Space climb / Shift dive)
        const pitchInput = (climb ? 1 : 0) - (dive ? 1 : 0);
        this.group.rotation.x -= pitchInput * 1.0 * dt;
        this.group.rotation.x = Math.max(-0.9, Math.min(0.9, this.group.rotation.x));
        // Bank roll while yawing — looks like a real plane leaning
        const targetRoll = strafe * 0.45;
        this.group.rotation.z += (targetRoll - this.group.rotation.z) * Math.min(1, 4 * dt);

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

        // Lift vs gravity: need airspeed to stay up. Below ~8 m/s the
        // plane loses altitude; above it, gravity is cancelled.
        const stallSpeed = 8;
        const liftRatio = Math.min(1, this.speed / stallSpeed);
        const gravity = 6 * (1 - liftRatio);   // up to 6 m/s^2 when stalled
        if (this.group.position.y > 0) this.group.position.y -= gravity * dt;
        if (this.group.position.y < 0) {
            this.group.position.y = 0;
            this.speed *= 0.65;
            this.group.rotation.x *= 0.3;  // level out on ground
            this.group.rotation.z *= 0.3;
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

    /**
     * Helicopter — vertical takeoff with strafe/throttle giving
     * horizontal drift (not pitch). Much easier to fly than the plane.
     *
     *   W/S      → forward / reverse drift (slight nose pitch)
     *   A/D      → yaw (rotate heading)
     *   Space    → climb (ascend)
     *   Shift    → descend
     */
    _flyHeli(dt, input) {
        const { forward, strafe, climb, dive } = input;

        // Sketchbook-style helicopter: vertical thrust + tilt for
        // horizontal drift + direct yaw.
        // Yaw — rotates the chopper heading
        this.group.rotation.y -= strafe * 1.6 * dt;

        // Vertical — Space climbs, Shift descends, otherwise slow fall
        const climbInput = (climb ? 1 : 0) - (dive ? 1 : 0);
        const riseRate = 9;
        this._vy = (this._vy ?? 0);
        const targetVy = climbInput !== 0
            ? climbInput * riseRate
            : -1;    // tiny passive drop when you do nothing (feels alive)
        this._vy += (targetVy - this._vy) * Math.min(1, 5 * dt);
        this.group.position.y += this._vy * dt;

        // Forward drift — W/S build horizontal velocity in the heading direction
        this._hSpeed = (this._hSpeed ?? 0);
        const maxH = 18;
        if (forward !== 0) {
            this._hSpeed += forward * 10 * dt;
            this._hSpeed = Math.max(-maxH * 0.4, Math.min(maxH, this._hSpeed));
        } else {
            const damp = 2.5 * dt;
            if (Math.abs(this._hSpeed) < damp) this._hSpeed = 0;
            else this._hSpeed -= Math.sign(this._hSpeed) * damp;
        }
        const yaw = this.group.rotation.y;
        this.group.position.x += Math.sin(yaw) * this._hSpeed * dt;
        this.group.position.z += Math.cos(yaw) * this._hSpeed * dt;

        // Cosmetic tilt — nose pitches down when driftin' forward, bank when yawing
        const targetPitch = -this._hSpeed * 0.03;
        this.group.rotation.x += (targetPitch - this.group.rotation.x) * Math.min(1, 6 * dt);
        const targetRoll = -strafe * 0.35;
        this.group.rotation.z += (targetRoll - this.group.rotation.z) * Math.min(1, 6 * dt);

        // Ground clamp
        if (this.group.position.y < 0) {
            this.group.position.y = 0;
            this._vy = Math.max(0, this._vy);
        }

        // Spin the main rotor (use all wheels/rotor-like meshes)
        for (const w of this.wheels) {
            w.mesh.rotation.y += 30 * dt;
        }

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
