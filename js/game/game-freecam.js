import * as THREE from 'three';

/**
 * Free fly camera for debugging. Toggled with the `C` key while in
 * game mode. Disconnects from the GameCamera follow rig, swaps to
 * direct WASD + mouse-look control, flies anywhere on the map.
 *
 *  Controls:
 *    WASD / ZQSD   →  move horizontally
 *    Space / Ctrl  →  rise / sink
 *    Shift         →  move 3× faster
 *    Mouse         →  look (pointer lock)
 *    C             →  exit freecam (back to follow cam)
 */
export class FreeCam {
    constructor(camera, renderer) {
        this.camera = camera;
        this.renderer = renderer;
        this.active = false;
        this.yaw = 0;
        this.pitch = 0;
        this._savedPos = new THREE.Vector3();
        this._savedQuat = new THREE.Quaternion();
        this._keys = new Set();
        this._tmp = new THREE.Vector3();
        this._fwd = new THREE.Vector3();
        this._right = new THREE.Vector3();

        this._onKeyDown = (e) => {
            if (!this.active) return;
            this._keys.add(e.key.toLowerCase());
        };
        this._onKeyUp = (e) => {
            this._keys.delete(e.key.toLowerCase());
        };
        this._onMouseMove = (e) => {
            if (!this.active) return;
            if (document.pointerLockElement !== renderer.domElement) return;
            const sens = 0.0025;
            this.yaw   -= e.movementX * sens;
            this.pitch -= e.movementY * sens;
            this.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.pitch));
            this._applyRotation();
        };
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
        window.addEventListener('mousemove', this._onMouseMove);
    }

    enter() {
        if (this.active) return;
        this.active = true;
        this._savedPos.copy(this.camera.position);
        this._savedQuat.copy(this.camera.quaternion);
        // Seed yaw/pitch from the current camera orientation
        const eu = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
        this.yaw = eu.y;
        this.pitch = eu.x;
        this._keys.clear();
        // Try to lock the pointer
        this.renderer.domElement.requestPointerLock?.();
        console.log('[freecam] entered — WASD+Space/Ctrl, Shift=fast, C=exit');
    }

    exit() {
        if (!this.active) return;
        this.active = false;
        this.camera.position.copy(this._savedPos);
        this.camera.quaternion.copy(this._savedQuat);
        document.exitPointerLock?.();
        console.log('[freecam] exited');
    }

    toggle() {
        if (this.active) this.exit(); else this.enter();
    }

    _applyRotation() {
        const eu = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
        this.camera.quaternion.setFromEuler(eu);
    }

    update(dt) {
        if (!this.active) return;
        const speed = this._keys.has('shift') ? 45 : 15;

        this._fwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        this._right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);

        let fx = 0, fz = 0, fy = 0;
        if (this._keys.has('w') || this._keys.has('z')) fz += 1;
        if (this._keys.has('s'))                         fz -= 1;
        if (this._keys.has('a') || this._keys.has('q')) fx -= 1;
        if (this._keys.has('d'))                         fx += 1;
        if (this._keys.has(' '))                         fy += 1;
        if (this._keys.has('control') || this._keys.has('c') === false && this._keys.has('shift') && false) fy -= 1;
        // Simpler: use C for toggle only, so ctrl alone sinks
        if (this._keys.has('control'))                   fy -= 1;

        this._tmp.set(0, 0, 0)
            .addScaledVector(this._fwd,   fz)
            .addScaledVector(this._right, fx);
        this._tmp.y = 0;
        if (this._tmp.lengthSq() > 0) this._tmp.normalize();
        this._tmp.y = fy;
        this.camera.position.addScaledVector(this._tmp, speed * dt);
    }
}
