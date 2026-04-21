import * as THREE from 'three';
import { GameVehicle } from './game-vehicle.js';

/**
 * AI-driven traffic cars that follow CITY STREETS. Each driver has a
 * predefined rectangular loop along the grid of avenues (not the old
 * oval track). Cars move at constant speed and smoothly yaw through
 * intersections.
 *
 * Routes are defined as arrays of {x, z} waypoints. The car drives from
 * one waypoint to the next, looping forever.
 */

// Traffic routes trace rectangles around city blocks on the grid.
// Streets live at x=0, ±28 and z=0, ±28. Blocks at (±14, ±14).
// Inner cars loop around a single block (1×1), outer cars do a 2×2.
const ROUTES = [
    // Outer square — clockwise, the big ±28 rectangle
    [{x: -28, z: -28}, {x: 28, z: -28}, {x: 28, z: 28}, {x: -28, z: 28}],
    // Inner loops around a single block (1×1 at (±14, ±14))
    [{x: 0, z: 0},  {x: 28, z: 0},  {x: 28, z: 28}, {x: 0, z: 28}],   // NE block
    [{x: 0, z: 0},  {x: 0, z: -28}, {x: 28, z: -28}, {x: 28, z: 0}],  // SE block (reversed)
    [{x: 0, z: 0},  {x: -28, z: 0}, {x: -28, z: -28}, {x: 0, z: -28}],// SW block
    [{x: 0, z: 0},  {x: 0, z: 28},  {x: -28, z: 28}, {x: -28, z: 0}], // NW block (reversed)
];

export class NpcDriver {
    constructor(scene, opts = {}) {
        this.vehicle = new GameVehicle(scene, opts);
        this.vehicle.group.visible = false;

        // Assign a route (wraps around if more drivers than routes)
        this.route = ROUTES[(opts.routeIndex ?? 0) % ROUTES.length];
        this.waypointIdx = 0;
        this.speed = 8 + Math.random() * 4;   // m/s
        this._yaw = 0;

        this.vehicle._loadPromise.then(() => {
            this.vehicle.group.visible = true;
            this._placeOnRoute();
        });
    }

    _currentTarget() {
        return this.route[this.waypointIdx];
    }

    _advanceWaypoint() {
        this.waypointIdx = (this.waypointIdx + 1) % this.route.length;
    }

    _placeOnRoute() {
        const wp = this._currentTarget();
        this.vehicle.group.position.set(wp.x, 0, wp.z);
        const next = this.route[(this.waypointIdx + 1) % this.route.length];
        this._yaw = Math.atan2(next.x - wp.x, next.z - wp.z);
        this.vehicle.group.rotation.y = this._yaw;
        this._advanceWaypoint();
    }

    /** Player has hijacked this vehicle → stop AI control. */
    evict() { this._evicted = true; }

    update(dt) {
        if (!this.vehicle.loaded) return;
        if (this._evicted) return;

        const pos = this.vehicle.group.position;
        const target = this._currentTarget();
        const dx = target.x - pos.x;
        const dz = target.z - pos.z;
        const dist = Math.hypot(dx, dz);

        // Reached waypoint?
        if (dist < 1.5) {
            this._advanceWaypoint();
            return;
        }

        // Move toward target
        const step = Math.min(dist, this.speed * dt);
        pos.x += (dx / dist) * step;
        pos.z += (dz / dist) * step;

        // Smooth yaw toward the target direction
        const targetYaw = Math.atan2(dx, dz);
        let diff = targetYaw - this._yaw;
        while (diff >  Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this._yaw += diff * Math.min(1, 6 * dt);
        this.vehicle.group.rotation.y = this._yaw;

        // Spin wheels
        const rot = this.speed * dt / 0.35;
        for (const w of this.vehicle.wheels) {
            w.mesh.rotation.x += rot;
        }
    }
}

export class NpcDriverManager {
    constructor(scene) {
        this.scene = scene;
        this.drivers = [];
    }

    spawn(count = 2) {
        for (let i = 0; i < count; i++) {
            const driver = new NpcDriver(this.scene, { routeIndex: i });
            this.drivers.push(driver);
        }
    }

    update(dt) {
        for (const d of this.drivers) d.update(dt);
    }

    clear() {
        for (const d of this.drivers) {
            d.vehicle.group.removeFromParent();
        }
        this.drivers.length = 0;
    }

    show() {
        for (const d of this.drivers) {
            if (d.vehicle.loaded) d.vehicle.group.visible = true;
        }
    }

    hide() {
        for (const d of this.drivers) {
            d.vehicle.group.visible = false;
        }
    }
}
