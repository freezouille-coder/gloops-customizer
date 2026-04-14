import * as THREE from 'three';

// Version marker — check console to verify this is the loaded version
console.log('[GameCamera] v6 Sketchbook-direct loaded at', new Date().toISOString());

/**
 * Camera — 1:1 port of swift502/Sketchbook CameraOperator.update()
 *
 * Direct trig formulas, no Object3D pivot, no matrix tricks.
 * Each frame:
 *   1. target.copy(player.getWorldPosition())
 *   2. target.y += height
 *   3. radius = lerp(radius, targetRadius, 0.1)
 *   4. camera.position = target + sphericalOffset(theta°, phi°, radius)
 *   5. camera.updateMatrix()
 *   6. camera.lookAt(target)
 *
 * Sketchbook formulas (verbatim):
 *   theta -= dx * sensitivity.x / 2
 *   phi   += dy * sensitivity.y / 2
 *   phi clamped ±85, theta wraps mod 360
 *   x = target.x + r * sin(θ°) * cos(φ°)
 *   y = target.y + r * sin(φ°)
 *   z = target.z + r * cos(θ°) * cos(φ°)
 */
export class GameCamera {
    constructor(camera, getTarget) {
        this.camera = camera;
        // target is mutated in place every frame (matches Sketchbook)
        this.target = new THREE.Vector3();
        this._getTarget = getTarget;

        this.theta = 0;              // yaw, degrees
        this.phi = 15;               // pitch, degrees
        this.sensitivityX = 0.24;
        this.sensitivityY = this.sensitivityX * 0.8;

        this.targetRadius = 5.0;
        this.radius = 5.0;
        this.height = 1.45;          // how high above player feet the camera looks

        this._obstacles = [];
        this._raycaster = new THREE.Raycaster();
        this._rayDir = new THREE.Vector3();

        this.enabled = false;
    }

    setObstacles(meshes) { this._obstacles = meshes || []; }

    enable(canvas) {
        if (this.enabled) return;
        this.enabled = true;
        this._canvas = canvas;
        canvas.addEventListener('click', this._onCanvasClick);
        window.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('pointerlockchange', this._onLockChange);
        if (canvas.requestPointerLock) canvas.requestPointerLock();
    }

    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        if (document.pointerLockElement) document.exitPointerLock();
        if (this._canvas) this._canvas.removeEventListener('click', this._onCanvasClick);
        window.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('pointerlockchange', this._onLockChange);
    }

    isLocked() { return document.pointerLockElement === this._canvas; }

    _onCanvasClick = () => {
        if (!this.isLocked() && this._canvas.requestPointerLock) {
            this._canvas.requestPointerLock();
        }
    };

    _onLockChange = () => {};

    // Direct Sketchbook port: theta -= dx * sens/2, phi += dy * sens/2
    move(dx, dy) {
        this.theta -= dx * (this.sensitivityX / 2);
        this.theta %= 360;
        this.phi += dy * (this.sensitivityY / 2);
        this.phi = Math.min(85, Math.max(-85, this.phi));
    }

    _onMouseMove = (e) => {
        if (!this.enabled || !this.isLocked()) return;
        const rawDx = e.movementX || 0;
        const rawDy = e.movementY || 0;
        // Sub-pixel dead-zone
        const dx = Math.abs(rawDx) < 1 ? 0 : rawDx;
        const dy = Math.abs(rawDy) < 1 ? 0 : rawDy;
        // Anti-spike clamp
        const MAX = 80;
        this.move(
            Math.max(-MAX, Math.min(MAX, dx)),
            Math.max(-MAX, Math.min(MAX, dy))
        );
    };

    /** Instant snap (skip the radius lerp). */
    snap() {
        this.radius = this.targetRadius;
        this._apply();
    }

    update(dt) {
        // Lerp the radius toward its target (used for smooth collision pull-out)
        this.radius = this.radius + (this.targetRadius - this.radius) * 0.1;
        this._apply();
    }

    _apply() {
        // 1. Copy player world position into `target`
        const p = this._getTarget();
        if (!p) return;
        this.target.set(p.x, p.y + this.height, p.z);

        // 2. Sketchbook formulas (verbatim, angles in degrees)
        const tRad = this.theta * Math.PI / 180;
        const pRad = this.phi * Math.PI / 180;
        const sinT = Math.sin(tRad), cosT = Math.cos(tRad);
        const sinP = Math.sin(pRad), cosP = Math.cos(pRad);

        let r = this.radius;

        // 3. Camera collision raycast: shrink r if an obstacle is in the way.
        if (this._obstacles.length > 0) {
            this._rayDir.set(sinT * cosP, sinP, cosT * cosP);  // normalized unit
            this._raycaster.set(this.target, this._rayDir);
            this._raycaster.far = this.radius + 0.3;
            const hits = this._raycaster.intersectObjects(this._obstacles, true);
            if (hits.length > 0 && hits[0].distance < r) {
                r = Math.max(1.2, hits[0].distance - 0.25);
            }
        }

        this.camera.position.x = this.target.x + r * sinT * cosP;
        this.camera.position.y = this.target.y + r * sinP;
        this.camera.position.z = this.target.z + r * cosT * cosP;
        this.camera.updateMatrix();
        this.camera.lookAt(this.target);
    }

    /**
     * Flat-Y camera forward direction — the horizontal direction the camera
     * is LOOKING (used by the player controller for W = "forward").
     * At theta=0, camera is at +Z, looking toward -Z → flat view = (0, 0, -1).
     */
    getFlatView(out) {
        const tRad = this.theta * Math.PI / 180;
        out.set(-Math.sin(tRad), 0, -Math.cos(tRad));
        return out;
    }
}
