/**
 * GTA-style "WASTED" drowning system.
 *
 * The player can walk past the city edge onto the beach and into the
 * sea. As soon as their Y drops below a small threshold (they're
 * wading) the run-panic animation plays. If they keep going and their
 * Y drops below DROWN_Y, they die: big WASTED overlay fades in, the
 * camera tilts, then we respawn them in the city plaza.
 *
 * Usage from Game:
 *   this.wasted = new WastedManager(character, scene);
 *   // each frame, after player update:
 *   this.wasted.update(dt);
 *   // check wasted.isDead to freeze input during the death sequence
 */
import * as THREE from 'three';

export class WastedManager {
    constructor(character, scene, opts = {}) {
        this.character = character;
        this.scene = scene;
        // Sea level is at y = -1.6. Gloops height is ~1.7 m. To be
        // "fully underwater", the character's Y must be below the sea
        // surface by more than its own height — meaning head + torso
        // are below water. So DROWN_Y = sea - gloopsHeight = -3.3.
        this.PANIC_Y = opts.panicY ?? -1.3;   // head going under
        this.DROWN_Y = opts.drownY ?? -3.3;   // fully submerged
        this.respawnPos = opts.respawnPos
            ?? new THREE.Vector3(0, 0, 42);   // city spawn
        this.state = 'ALIVE';                 // ALIVE | PANIC | DEAD
        this._panicTimer = 0;
        this._deadTimer = 0;
        this._panicPrev = null;

        this._buildOverlay();
    }

    _buildOverlay() {
        const el = document.createElement('div');
        el.id = 'gh-wasted';
        el.className = 'gh-wasted hidden';
        el.textContent = 'WASTED';
        document.body.appendChild(el);
        this.overlay = el;
    }

    /** Is the player currently in a death sequence (freeze input). */
    get isDead() { return this.state === 'DEAD'; }
    /** Is the player currently panicking (almost drowning). */
    get isPanicking() { return this.state === 'PANIC'; }

    update(dt) {
        if (this.state === 'DEAD') {
            this._deadTimer += dt;
            // Fade in the overlay over the first 0.4 s
            const opacity = Math.min(1, this._deadTimer / 0.4);
            this.overlay.style.opacity = opacity;
            this.overlay.classList.remove('hidden');
            // After 2.2 s, respawn
            if (this._deadTimer > 2.2) this._respawn();
            return;
        }

        const y = this.character.model.position.y;

        if (y < this.DROWN_Y) {
            this._die();
            return;
        }

        if (y < this.PANIC_Y) {
            if (this.state !== 'PANIC') {
                this.state = 'PANIC';
                this._panicTimer = 0;
                this._activateRunPanic();
            }
            this._panicTimer += dt;
        } else if (this.state === 'PANIC') {
            // Back on dry ground — stop panicking
            this.state = 'ALIVE';
            this._deactivateRunPanic();
        }
    }

    _activateRunPanic() {
        // Switch Move category to run_panic.fbx
        const moveCat = this.character.categories?.get('Move');
        if (!moveCat) return;
        // Remember current active so we can restore
        this._panicPrev = moveCat.active;
        const target = [...moveCat.items.keys()].find((k) =>
            k.toLowerCase().includes('panic'));
        if (target) this.character.selectItem('Move', target);
    }

    _deactivateRunPanic() {
        const moveCat = this.character.categories?.get('Move');
        if (!moveCat) return;
        // Restore to walk or the previous Move
        const stripExt = (k) => k.replace(/\.(fbx|glb|gltf)$/i, '').toLowerCase();
        const restore = this._panicPrev
            || [...moveCat.items.keys()].find((k) => stripExt(k) === 'walk')
            || [...moveCat.items.keys()][0];
        if (restore) this.character.selectItem('Move', restore);
        this._panicPrev = null;
    }

    _die() {
        this.state = 'DEAD';
        this._deadTimer = 0;
        // Slam the character down
        this.character.model.position.y = -1.5;
        // Stop panicking anim → static T-pose
        this._deactivateRunPanic();
    }

    _respawn() {
        this.character.model.position.copy(this.respawnPos);
        this.character.model.rotation.y = 0;
        this.state = 'ALIVE';
        this.overlay.classList.add('hidden');
        this.overlay.style.opacity = 0;
    }

    /** Manual trigger (debug / testing). */
    forceDeath() { this._die(); }
}
