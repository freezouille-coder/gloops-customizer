import * as THREE from 'three';
import { BUBBLE_EMOJIS } from './game-bubbles.js';

/**
 * Mission Manager — Crazy Taxi style delivery loop.
 *
 * States:
 *   IDLE         → no mission, waiting for one to spawn
 *   OFFERED      → a random NPC is marked as a client (❓ bubble above head),
 *                  player must approach + press F to accept
 *   IN_CAR       → client picked up, timer running, destination marker active,
 *                  player drives to the destination
 *   COMPLETED    → drop-off reached → reward paid, short celebration, back to IDLE
 *   FAILED       → timer expired or client ragdolled mid-mission → back to IDLE
 *
 * Missions only spawn while the player is driving a ground vehicle.
 * The manager drives its own UI widget (destination pillar + HUD banner).
 */
export class MissionManager {
    constructor(scene, game) {
        this.scene = scene;
        this.game = game;          // back-ref for access to npcs, vehicle, hud, world
        this.state = 'IDLE';

        this.currentClient = null; // NpcGloop ref
        this.destPos = new THREE.Vector3();
        this.timer = 0;            // seconds remaining
        this.timerMax = 0;
        this.score = 0;
        this.deliveries = 0;

        // Auto-spawn a new mission N seconds after IDLE starts
        this._idleCooldown = 0;

        this._destMarker = null;
        this._buildDestMarker();

        // Event listeners
        this._listeners = { onState: null, onScore: null };
    }

    /* --------------------------------------------------------------
     *  Public API
     * -------------------------------------------------------------- */

    onStateChange(cb) { this._listeners.onState = cb; }
    onScoreChange(cb) { this._listeners.onScore = cb; }

    getState()  { return this.state; }
    getTimer()  { return this.timer; }
    getScore()  { return this.score; }
    getDeliveries() { return this.deliveries; }
    getClientName() { return this.currentClient?.name || ''; }
    getClientMood() { return this.currentClient?.mood || 8; }
    getDestination() { return this.destPos; }

    /** Force-start a mission. Used for debug / testing. */
    forceStart() {
        if (this.state === 'IDLE') this._spawnOffer();
    }

    /** Called by the Game when player presses F near the client NPC. */
    tryPickup(playerPos) {
        if (this.state !== 'OFFERED') return false;
        if (!this.currentClient) return false;
        const dx = this.currentClient.model.position.x - playerPos.x;
        const dz = this.currentClient.model.position.z - playerPos.z;
        const d = Math.hypot(dx, dz);
        if (d > 6) return false;
        this._pickup();
        return true;
    }

    reset() {
        this._clearClient();
        this._hideDest();
        this.state = 'IDLE';
        this._idleCooldown = 2;
        this._fire('onState');
    }

    /* --------------------------------------------------------------
     *  Update loop
     * -------------------------------------------------------------- */

    update(dt) {
        // Missions only run while driving a car (not plane/heli).
        // Require both refs non-null so minimal mode (vehicle=null) doesn't
        // match (null === null) and try to spawn offers on a null vehicle.
        const drivingCar = !!this.game.vehicle
            && this.game.drivingVehicle === this.game.vehicle;
        if (!drivingCar) {
            if (this.state !== 'IDLE') this.reset();
            return;
        }

        switch (this.state) {
            case 'IDLE': {
                this._idleCooldown -= dt;
                if (this._idleCooldown <= 0) this._spawnOffer();
                break;
            }
            case 'OFFERED': {
                // If the client got crushed/depressed before we picked him up, abort
                const c = this.currentClient;
                if (!c || c._crushed || c._depressed) {
                    this._fail('Client went down before pickup');
                }
                break;
            }
            case 'IN_CAR': {
                this.timer -= dt;
                if (this.timer <= 0) {
                    this._fail('Time out');
                    break;
                }
                // Arrived at destination?
                const playerPos = this.game.drivingVehicle.group.position;
                const dx = this.destPos.x - playerPos.x;
                const dz = this.destPos.z - playerPos.z;
                const d = Math.hypot(dx, dz);
                if (d < 5 && this._vehicleSpeed() < 6) {
                    this._complete();
                }
                break;
            }
        }

        this._updateDestMarker(dt);
    }

    /* --------------------------------------------------------------
     *  State transitions (private)
     * -------------------------------------------------------------- */

    _spawnOffer() {
        const npcs = this.game.npcs?.npcs || [];
        const playerPos = this.game.drivingVehicle.group.position;
        // Pick a non-crushed NPC within a reasonable radius
        const candidates = npcs.filter((n) => {
            if (n._crushed || n._depressed || n._chatting) return false;
            const dx = n.model.position.x - playerPos.x;
            const dz = n.model.position.z - playerPos.z;
            const d = Math.hypot(dx, dz);
            return d > 10 && d < 60;
        });
        if (candidates.length === 0) {
            this._idleCooldown = 1.5;
            return;
        }
        const client = candidates[Math.floor(Math.random() * candidates.length)];
        this.currentClient = client;
        // Tag the NPC so wander code can pause / AI can ignore
        client._isMissionClient = true;
        client.bubble?.set(BUBBLE_EMOJIS.QUESTION || '❓', 999999);

        this.state = 'OFFERED';
        this._fire('onState');
    }

    _pickup() {
        const c = this.currentClient;
        if (!c) return;
        // Hide the NPC (simulates entering the vehicle)
        c.model.visible = false;
        c.bubble?.set('', 0);

        // Pick a random destination ~40-80m from the pickup point
        const origin = c.model.position;
        const angle = Math.random() * Math.PI * 2;
        const dist = 40 + Math.random() * 40;
        this.destPos.set(
            origin.x + Math.cos(angle) * dist,
            0,
            origin.z + Math.sin(angle) * dist,
        );
        // Clamp inside play area (use world radius if available)
        const r = Math.hypot(this.destPos.x, this.destPos.z);
        const MAX = (this.game.world?.RADIUS ?? 60) - 10;
        if (r > MAX) {
            const k = MAX / r;
            this.destPos.x *= k;
            this.destPos.z *= k;
        }

        // Timer based on distance (~0.8s per meter, minimum 30s)
        const origDist = Math.hypot(
            this.destPos.x - this.game.drivingVehicle.group.position.x,
            this.destPos.z - this.game.drivingVehicle.group.position.z,
        );
        this.timer = Math.max(30, Math.ceil(origDist * 0.8));
        this.timerMax = this.timer;

        this._showDest();
        this.state = 'IN_CAR';
        this._fire('onState');
    }

    _complete() {
        // Drop off the client near the destination
        const c = this.currentClient;
        if (c) {
            c.model.visible = true;
            c.model.position.copy(this.destPos);
            c.model.position.y = 0;
            c._isMissionClient = false;
            c.bubble?.set(BUBBLE_EMOJIS.HAPPY || '😊', 2500);
        }

        // Score reward — base + speed bonus
        const speedBonus = Math.max(0, Math.floor(this.timer * 2));
        const reward = 50 + speedBonus;
        this.score += reward;
        this.deliveries += 1;
        this._fire('onScore', { reward, speedBonus, total: this.score });

        this._clearClient();
        this._hideDest();

        this.state = 'COMPLETED';
        this._fire('onState');

        // Auto-reset after celebration
        setTimeout(() => {
            if (this.state === 'COMPLETED') {
                this.state = 'IDLE';
                this._idleCooldown = 3;
                this._fire('onState');
            }
        }, 2000);
    }

    _fail(reason) {
        console.log(`[mission] FAILED — ${reason}`);
        const c = this.currentClient;
        if (c) {
            c.model.visible = true;
            c._isMissionClient = false;
            c.bubble?.set(BUBBLE_EMOJIS.DEPRESSED || '💔', 2000);
        }
        this._clearClient();
        this._hideDest();
        this.state = 'FAILED';
        this._fire('onState');
        setTimeout(() => {
            if (this.state === 'FAILED') {
                this.state = 'IDLE';
                this._idleCooldown = 4;
                this._fire('onState');
            }
        }, 1500);
    }

    _clearClient() {
        if (this.currentClient) {
            this.currentClient._isMissionClient = false;
            this.currentClient.bubble?.set('', 0);
        }
        this.currentClient = null;
    }

    /* --------------------------------------------------------------
     *  Destination marker (glowing pillar)
     * -------------------------------------------------------------- */

    _buildDestMarker() {
        const group = new THREE.Group();
        const geo = new THREE.CylinderGeometry(0.6, 0.6, 18, 12, 1, true);
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffe680,
            transparent: true,
            opacity: 0.55,
            side: THREE.DoubleSide,
            depthWrite: false,
        });
        const cyl = new THREE.Mesh(geo, mat);
        cyl.position.y = 9;
        group.add(cyl);

        // Disk on the ground
        const disk = new THREE.Mesh(
            new THREE.CircleGeometry(2.2, 24),
            new THREE.MeshBasicMaterial({
                color: 0xffe680, transparent: true, opacity: 0.7, depthWrite: false,
            }),
        );
        disk.rotation.x = -Math.PI / 2;
        disk.position.y = 0.02;
        group.add(disk);

        group.visible = false;
        this.scene.add(group);
        this._destMarker = group;
    }

    _showDest() {
        if (!this._destMarker) return;
        this._destMarker.position.copy(this.destPos);
        this._destMarker.position.y = 0;
        this._destMarker.visible = true;
    }
    _hideDest() { if (this._destMarker) this._destMarker.visible = false; }

    _updateDestMarker(dt) {
        if (!this._destMarker || !this._destMarker.visible) return;
        // Gentle pulse
        const s = 1 + Math.sin(performance.now() * 0.004) * 0.12;
        this._destMarker.scale.setScalar(s);
    }

    /* --------------------------------------------------------------
     *  Utilities
     * -------------------------------------------------------------- */

    _vehicleSpeed() {
        const v = this.game.drivingVehicle;
        if (!v) return 0;
        // Vehicle exposes its current speed via a .speed getter or ._speed field
        return Math.abs(v.speed ?? v._speed ?? 0);
    }

    _fire(name, arg) {
        const cb = this._listeners[name];
        if (cb) cb(arg);
    }
}
