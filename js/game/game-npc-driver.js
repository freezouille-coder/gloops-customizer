import * as THREE from 'three';
import { GameVehicle } from './game-vehicle.js';

/**
 * Simple AI-driven traffic cars. They follow the oval race track
 * (radius 23, X-scale 1.25) at constant speed with smooth steering.
 *
 * Each car has a parameter `t` (0..1) along the track curve that
 * advances over time. The car position is sampled from the oval,
 * the heading is the tangent direction.
 */
export class NpcDriver {
    constructor(scene, opts = {}) {
        this.vehicle = new GameVehicle(scene, opts);
        this.vehicle.group.visible = false;     // shown after loading
        // Hide UI bits of vehicle (no steering required)
        this.t = Math.random();                 // position along track
        this.speed = 0.025 + Math.random() * 0.01;   // track-units / second
        this.trackR = 23;
        this.trackX = 1.25;
        this._lastYaw = 0;
        // Async wait for the GLB to load, then show
        this.vehicle._loadPromise.then(() => {
            this.vehicle.group.visible = true;
            // Hide the Cannon.js collider proxies already handled in vehicle
            this._placeOnTrack();
        });
    }

    _samplePoint(t) {
        const a = t * Math.PI * 2;
        return {
            x: Math.cos(a) * this.trackR * this.trackX,
            z: Math.sin(a) * this.trackR,
        };
    }

    _placeOnTrack() {
        const p = this._samplePoint(this.t);
        this.vehicle.group.position.set(p.x, 0, p.z);
        const next = this._samplePoint(this.t + 0.01);
        this._lastYaw = Math.atan2(next.x - p.x, next.z - p.z);
        this.vehicle.group.rotation.y = this._lastYaw;
    }

    update(dt) {
        if (!this.vehicle.loaded) return;
        this.t = (this.t + this.speed * dt) % 1;
        const p = this._samplePoint(this.t);
        const next = this._samplePoint(this.t + 0.005);
        this.vehicle.group.position.x = p.x;
        this.vehicle.group.position.z = p.z;
        // Smooth yaw
        const targetYaw = Math.atan2(next.x - p.x, next.z - p.z);
        let diff = targetYaw - this._lastYaw;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this._lastYaw += diff * Math.min(1, 12 * dt);
        this.vehicle.group.rotation.y = this._lastYaw;
        // Spin wheels — speed * distance per frame
        const dist = this.vehicle.group.position.distanceTo(
            new THREE.Vector3(
                p.x - (next.x - p.x),
                0,
                p.z - (next.z - p.z)
            )
        );
        const rot = this.speed * 20 * dt;
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
            const driver = new NpcDriver(this.scene);
            driver.t = i / count;               // space them evenly
            this.drivers.push(driver);
        }
    }

    update(dt) {
        for (const d of this.drivers) d.update(dt);
    }

    clear() {
        for (const d of this.drivers) {
            if (d.vehicle.group.parent) d.vehicle.group.parent.remove(d.vehicle.group);
        }
        this.drivers = [];
    }

    show() { for (const d of this.drivers) d.vehicle.group.visible = d.vehicle.loaded; }
    hide() { for (const d of this.drivers) d.vehicle.group.visible = false; }
}
