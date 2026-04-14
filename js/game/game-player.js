import * as THREE from 'three';

/**
 * Sketchbook-inspired third-person character controller.
 *
 * Ported concepts from swift502/Sketchbook Character.ts:
 *   - `orientation`        : current facing direction on XZ plane (Vector3)
 *   - `orientationTarget`  : desired facing (= camera-relative move direction)
 *   - Smooth rotation toward target using a spring-style lerp
 *   - Character ALWAYS faces its movement direction (not the camera)
 *   - Camera is free to orbit independently — strafing left = character
 *     turns 90° and runs left; mouse pan doesn't turn the character
 *   - Movement is in world direction `moveVector` (camera-relative)
 *   - Speed via Shift sprint; Space jump with gravity
 */
export class GamePlayer {
    constructor(character, gameCamera) {
        this.character = character;
        this.model = character.model;
        this.gameCamera = gameCamera;

        this.walkSpeed = 4.5;
        this.runSpeed = 8.0;
        this.accelSmoothing = 10;
        this.velocity = new THREE.Vector3();
        // Body lean (Sketchbook-style): the character tilts on Z when
        // strafing at speed, giving the motion weight.
        this.leanAmount = 0.30;       // max lean angle in radians
        this.leanSmoothing = 8;       // higher = snappier
        this._leanZ = 0;
        // Set the Euler order so Z (roll) is applied AFTER Y (yaw)
        character.model.rotation.order = 'YXZ';
        // No root bone override — Move clips are played raw.
        this._rootBone = null;

        // Current and target facing direction on XZ plane (unit vectors).
        // Default = -Z, which is "away from the camera" at theta=0 (camera at +Z).
        this.orientation = new THREE.Vector3(0, 0, -1);
        this.orientationTarget = new THREE.Vector3(0, 0, -1);

        // Face direction matches orientation direction directly.
        this.facingOffset = 0;

        // Vertical
        this._velY = 0;
        this._grounded = true;
        this.gravity = -20;
        this.jumpVelocity = 7.5;

        // Input
        this._keys = new Set();
        this._joyVec = new THREE.Vector2();
        this._enabled = false;

        // Scratch
        this._localMove = new THREE.Vector3();
        this._moveVec = new THREE.Vector3();
        this._flatView = new THREE.Vector3();
        this.speed = 0;
    }

    enable() {
        this._enabled = true;
        window.addEventListener('keydown', this._onKey);
        window.addEventListener('keyup', this._onKeyUp);
    }

    disable() {
        this._enabled = false;
        window.removeEventListener('keydown', this._onKey);
        window.removeEventListener('keyup', this._onKeyUp);
        this._keys.clear();
        this._joyVec.set(0, 0);
        this.speed = 0;
    }

    setJoystick(x, y) { this._joyVec.set(x, y); }
    setInteractHandler(fn) { this._onInteract = fn; }

    /** Read raw input (used by the vehicle when the player is driving). */
    readInput() {
        let forward = 0, strafe = 0;
        if (this._keys.has('w') || this._keys.has('z') || this._keys.has('arrowup')) forward += 1;
        if (this._keys.has('s') || this._keys.has('arrowdown')) forward -= 1;
        if (this._keys.has('a') || this._keys.has('q') || this._keys.has('arrowleft')) strafe -= 1;
        if (this._keys.has('d') || this._keys.has('arrowright')) strafe += 1;
        forward += this._joyVec.y;
        strafe += this._joyVec.x;
        return {
            forward, strafe,
            climb: this._keys.has(' '),
            dive: this._keys.has('shift'),
        };
    }

    _onKey = (e) => {
        const k = e.key.toLowerCase();
        const tracked = ['w','a','s','d','z','q','arrowup','arrowdown','arrowleft','arrowright','shift',' ','f','enter'];
        if (tracked.includes(k)) {
            this._keys.add(k);
            if (k === ' ' && this._grounded) {
                this._velY = this.jumpVelocity;
                this._grounded = false;
            }
            if ((k === 'f' || k === 'enter') && this._onInteract) {
                this._onInteract();
            }
            e.preventDefault();
        }
    };
    _onKeyUp = (e) => { this._keys.delete(e.key.toLowerCase()); };

    /**
     * Build the camera-relative movement vector from keyboard input.
     * Returns a Vector3 on the XZ plane (Y=0). Empty if no input.
     */
    _computeMoveVector() {
        // Local input: +Z is forward in Sketchbook local space
        let lx = 0, lz = 0;
        if (this._keys.has('w') || this._keys.has('z') || this._keys.has('arrowup')) lz += 1;
        if (this._keys.has('s') || this._keys.has('arrowdown')) lz -= 1;
        if (this._keys.has('a') || this._keys.has('q') || this._keys.has('arrowleft')) lx -= 1;
        if (this._keys.has('d') || this._keys.has('arrowright')) lx += 1;
        lx += this._joyVec.x;
        lz += this._joyVec.y;

        if (Math.abs(lx) < 0.01 && Math.abs(lz) < 0.01) {
            return this._moveVec.set(0, 0, 0);
        }

        // Normalize to unit vector (preserve diagonal cap)
        const mag = Math.min(1, Math.hypot(lx, lz));
        const n = Math.max(Math.hypot(lx, lz), 0.0001);
        lx = (lx / n) * mag;
        lz = (lz / n) * mag;

        // Camera forward direction (flat on XZ plane)
        this.gameCamera.getFlatView(this._flatView);
        // Right vector = cross(forward, up) on XZ plane.
        // For forward=(fx, 0, fz) and up=(0,1,0): right = (-fz, 0, fx)
        const rx = -this._flatView.z;
        const rz = this._flatView.x;

        // World move vector = forward*lz + right*lx
        this._moveVec.set(
            this._flatView.x * lz + rx * lx,
            0,
            this._flatView.z * lz + rz * lx
        );
        return this._moveVec;
    }

    update(dt, world) {
        if (!this._enabled || !this.model) return;

        const move = this._computeMoveVector();
        const moving = move.lengthSq() > 0.0001;

        // ----- Orientation SMOOTH (Sketchbook-style spring to target) -----
        if (moving) {
            this.orientationTarget.copy(move).normalize();
        }
        // Smoothly rotate the `orientation` vector toward the target.
        // Works on the angle so wraparound is handled correctly.
        const currentAngle = Math.atan2(this.orientation.x, this.orientation.z);
        const targetAngle  = Math.atan2(this.orientationTarget.x, this.orientationTarget.z);
        let diff = targetAngle - currentAngle;
        while (diff >  Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const turnSpeed = 5;   // rad/s — smooth Sketchbook-like turn
        const newAngle = currentAngle + diff * Math.min(1, turnSpeed * dt);
        this.orientation.set(Math.sin(newAngle), 0, Math.cos(newAngle));
        this.model.rotation.y = newAngle + this.facingOffset;

        // ----- Body lean (Sketchbook-style) -----
        // When strafing at speed, lean the body Z into the motion.
        let strafeInput = 0;
        if (this._keys.has('a') || this._keys.has('q') || this._keys.has('arrowleft')) strafeInput -= 1;
        if (this._keys.has('d') || this._keys.has('arrowright')) strafeInput += 1;
        strafeInput += this._joyVec.x;
        const speedN = Math.min(1, Math.hypot(this.velocity.x, this.velocity.z) / this.runSpeed);
        const targetLean = -strafeInput * this.leanAmount * speedN;
        const k = Math.min(1, this.leanSmoothing * dt);
        this._leanZ += (targetLean - this._leanZ) * k;
        this.model.rotation.z = this._leanZ;

        // (No root bone override — raw clip playback)

        // ----- Velocity smoothing (Sketchbook-style spring) -----
        const isRunning = this._keys.has('shift');
        const speed = (isRunning ? this.runSpeed : this.walkSpeed);
        const targetVx = moving ? this.orientation.x * speed : 0;
        const targetVz = moving ? this.orientation.z * speed : 0;
        const t = Math.min(1, this.accelSmoothing * dt);
        this.velocity.x += (targetVx - this.velocity.x) * t;
        this.velocity.z += (targetVz - this.velocity.z) * t;
        this.speed = Math.hypot(this.velocity.x, this.velocity.z);
        this.model.position.x += this.velocity.x * dt;
        this.model.position.z += this.velocity.z * dt;

        // ----- Pick locomotion animation based on actual speed -----
        this._updateLocomotion(moving, isRunning);

        // ----- Vertical (gravity + jump) -----
        this._velY += this.gravity * dt;
        this.model.position.y += this._velY * dt;
        const groundH = world && world.heightAt
            ? world.heightAt(this.model.position.x, this.model.position.z)
            : 0;
        // Vehicles as standable surfaces — if player is above one, land on top
        let standY = groundH;
        if (world && world._vehicles) {
            for (const v of world._vehicles) {
                if (!v.group.visible) continue;
                const dx = this.model.position.x - v.group.position.x;
                const dz = this.model.position.z - v.group.position.z;
                // Vehicle top area rough AABB (x ±1.2, z ±1.8)
                if (Math.abs(dx) < 1.2 && Math.abs(dz) < 1.8) {
                    const vehTop = v.group.position.y + 1.5;
                    if (this.model.position.y < vehTop + 0.1 &&
                        this._velY <= 0 &&
                        this.model.position.y > vehTop - 1.5) {
                        standY = Math.max(standY, vehTop);
                    }
                }
            }
        }
        if (this.model.position.y <= standY) {
            this.model.position.y = standY;
            this._velY = 0;
            this._grounded = true;
        }

        // ----- World bounds: soft island edge EXCEPT for the open beach
        // sector, where the player can walk straight into the sea. -----
        const r = Math.hypot(this.model.position.x, this.model.position.z);
        const MAX_R = 52;
        const inBeach = world && world.isInBeachSector
            && world.isInBeachSector(this.model.position.x, this.model.position.z);
        if (r > MAX_R && !inBeach) {
            const k = MAX_R / r;
            this.model.position.x *= k;
            this.model.position.z *= k;
        }
        // Beach fall → respawn near the fountain when we walk off the edge
        if (inBeach && r > 56) {
            this._respawnNearFountain();
        }
        if (world && world.collidePlayer) {
            world.collidePlayer(this.model.position, 0.55);
        }
        if (world && world.collideDynamic) {
            world.collideDynamic(this.model.position, 0.55);
        }

        // ----- Push physics objects (balls, bricks) -----
        if (moving && world && world.pushObjects) {
            world.pushObjects(this.model.position, this.orientation, speed);
        }
    }

    isRunning() { return this._keys.has('shift'); }
    isGrounded() { return this._grounded; }

    /** Teleport the player back to the edge of the fountain. */
    _respawnNearFountain() {
        // 4 units south of the fountain, facing north
        this.model.position.set(0, 0, -4);
        this.velocity.set(0, 0, 0);
        this._velY = 0;
        this.orientation.set(0, 0, 1);
        this.orientationTarget.set(0, 0, 1);
    }

    /**
     * Pick the locomotion animation (walk / run / idle) by selecting the
     * right clip in the Move category of the underlying character.
     * Idle = no move clip weighted (fall back to current Emotion pose).
     */
    _updateLocomotion(moving, isRunning) {
        if (!this.character.categories.has('Move')) return;
        let target = null;
        if (moving) target = isRunning ? 'run.fbx' : 'walk.fbx';
        if (this._currentLocomotion === target) return;
        // Use selectItem for walk/run; if idle, zero out all Move weights.
        if (target) {
            this.character.selectItem('Move', target);
        } else {
            const cat = this.character.categories.get('Move');
            if (cat) {
                for (const item of cat.items.values()) {
                    item.action.setEffectiveWeight(0);
                }
                cat.active = null;
            }
        }
        this._currentLocomotion = target;
    }
}
