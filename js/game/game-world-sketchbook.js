import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { makeGLTFLoader } from '../gltf-loader.js';
import { Ocean } from './ocean.js';

/**
 * Alternate world that loads Sketchbook's world.glb as the actual
 * playable terrain (not just texture harvest). Creates trimesh
 * colliders for each mesh so vehicles can drive on it.
 *
 * Exposes the same interface as GameWorld (so Game can use either
 * one interchangeably):
 *   - build()
 *   - update(dt, playerPos, camera)
 *   - isInBeachSector(x, z)
 *   - heightAt(x, z)
 *   - raycastGroundAt(x, z)
 *   - collidePlayer(pos, r), collideVehicle(pos, r), collideDynamic(pos, r)
 *   - setPhysicsWorld(pw), setVehicles(list)
 *   - RADIUS, root, colliders (empty)
 *   - runwayStart, helipad (approximate from GLB if tagged, else null)
 */
const WORLD_URL = 'assets/sketchbook/world.glb';

export class SketchbookWorld {
    constructor(scene) {
        this.scene = scene;
        this.root = new THREE.Group();
        this.root.name = 'SketchbookWorld';
        this.isCity = false;    // tells NPC spawner to use terrain ring
        this.RADIUS = 150;               // big map
        this.colliders = [];             // kept for arcade fallback (unused here)
        this.items = [];
        this.balls = [];
        this.bricks = [];
        this.obstacles = [];
        this.beachAngle = 0;
        this.beachHalf = 3.14;           // beach everywhere (whole rim)
        this.runwayStart = null;
        this.helipad = null;
        this._physicsWorld = null;
        this._vehicles = [];
        this._groundRay = null;
        this._readyPromise = null;
    }

    setPhysicsWorld(pw) { this._physicsWorld = pw; }
    setVehicles(list)  { this._vehicles = list || []; }

    isInBeachSector() { return false; }
    heightAt(x, z) { return this.raycastGroundAt(x, z); }
    isOnRoad()  { return false; }
    isOnTrack() { return false; }

    mirrorCollidersToPhysics() { /* no-op — trimesh covers everything */ }

    collidePlayer(pos, r)  { /* handled via raycast ground */ void pos; void r; }
    collideVehicle(pos, r) { /* cannon physics handles vehicles */ void pos; void r; return false; }
    collideDynamic(pos, r) { void pos; void r; }

    raycastGroundAt(x, z) {
        if (!this._groundRay) {
            this._groundRay = new THREE.Raycaster(
                new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 0, 200
            );
        }
        this._groundRay.set(
            new THREE.Vector3(x, 100, z),
            new THREE.Vector3(0, -1, 0),
        );
        const hits = this._groundRay.intersectObject(this.root, true);
        for (const h of hits) {
            const n = (h.object.name || '').toLowerCase();
            if (n.includes('water') || n.includes('sea') || n.includes('ocean')) continue;
            return h.point.y;
        }
        return 0;
    }

    /** Returns a Promise resolved when the Sketchbook world is fully loaded. */
    ready() { return this._readyPromise || Promise.resolve(); }

    build() {
        this._readyPromise = new Promise((resolve) => {
            const loader = makeGLTFLoader();
            loader.load(WORLD_URL, (gltf) => {
                const worldRoot = gltf.scene;
                this._processSketchbookScene(worldRoot);
                this.root.add(worldRoot);
                this.scene.add(this.root);
                if (this._physicsWorld) this._physicsWorld.addGroundPlane();
                this._buildOcean(worldRoot);
                // Sample the terrain to auto-find valid spawn points
                this._autoSpawnPoints();
                resolve();
            }, undefined, (err) => {
                console.error('[SketchbookWorld] load failed', err);
                resolve();
            });
        });
    }

    /**
     * Scan the terrain by raycasting every 10 m across a 100 m x 100 m
     * grid around origin. Cache the results and auto-pick spawn points
     * for player / car / plane / heli if the GLB didn't tag any.
     */
    _autoSpawnPoints() {
        const flat = [];   // flat spots above water
        for (let tx = -80; tx <= 80; tx += 8) {
            for (let tz = -80; tz <= 80; tz += 8) {
                const y = this.raycastGroundAt(tx, tz);
                if (y > 1) flat.push({ x: tx, y, z: tz });
            }
        }
        if (flat.length === 0) {
            console.warn('[SketchbookWorld] no valid terrain found — using (0,0,0)');
            return;
        }
        // Sort by height ascending and pick points at different altitudes
        flat.sort((a, b) => a.y - b.y);
        console.log(`[SketchbookWorld] ${flat.length} terrain samples, y from ${flat[0].y.toFixed(1)} to ${flat[flat.length-1].y.toFixed(1)}`);
        const median = flat[Math.floor(flat.length * 0.5)];
        const lower  = flat[Math.floor(flat.length * 0.2)];
        const higher = flat[Math.floor(flat.length * 0.7)];

        this.spawns = this.spawns || {};
        if (!this.spawns.player) this.spawns.player = new THREE.Vector3(median.x, median.y, median.z);
        if (!this.spawns.car)    this.spawns.car    = new THREE.Vector3(lower.x, lower.y, lower.z);
        if (!this.runwayStart) {
            const p = higher;
            this.runwayStart = { x: p.x, z: p.z, yaw: 0 };
        }
        if (!this.helipad) {
            const p = flat[Math.floor(flat.length * 0.9)];
            this.helipad = { x: p.x, z: p.z, radius: 5 };
        }
    }

    /**
     * Sketchbook convention: meshes tagged `userData.data === 'physics'`
     * are INVISIBLE colliders (box or trimesh). Meshes tagged
     * `userData.data === 'scenario'` mark spawn points. Everything else
     * is just visual terrain — rendered, no physics.
     */
    _processSketchbookScene(worldRoot) {
        const physicsBodies = [];
        const scenarios = {};
        const paths = [];

        worldRoot.updateMatrixWorld(true);
        worldRoot.traverse((child) => {
            if (!child.userData) return;
            const data = child.userData.data;

            if (data === 'physics' && child.isMesh) {
                // Sketchbook hides these and uses them for collision
                child.visible = false;
                if (!this._physicsWorld) return;
                const type = child.userData.type;
                if (type === 'box') {
                    // Sketchbook uses child.scale as the box half-extents? No —
                    // it uses scale directly as box size (full extents)
                    const he = new THREE.Vector3(
                        child.scale.x, child.scale.y, child.scale.z
                    );
                    const pos = new THREE.Vector3();
                    child.getWorldPosition(pos);
                    const q = new THREE.Quaternion();
                    child.getWorldQuaternion(q);
                    const body = this._physicsWorld.addStaticBox(
                        { x: he.x, y: he.y, z: he.z },
                        { x: pos.x, y: pos.y, z: pos.z },
                        q,
                    );
                    physicsBodies.push(body);
                } else if (type === 'trimesh') {
                    this._addTrimeshBody(child);
                }
            } else if (data === 'scenario' || data === 'spawn') {
                // Keep spawn points: player, car, airplane, heli
                const name = (child.userData.type || child.name || '').toLowerCase();
                scenarios[name] = child.position.clone();
            } else if (data === 'path') {
                paths.push(child);
            } else if (child.isMesh) {
                // Regular visible mesh — enable shadows
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        console.log(`[SketchbookWorld] ${physicsBodies.length} colliders, ${Object.keys(scenarios).length} scenarios, ${paths.length} paths`);

        // Expose spawn points
        this.spawns = scenarios;
        if (scenarios.airplane || scenarios.plane) {
            const p = scenarios.airplane || scenarios.plane;
            this.runwayStart = { x: p.x, z: p.z, yaw: 0 };
        }
        if (scenarios.heli || scenarios.helicopter) {
            const p = scenarios.heli || scenarios.helicopter;
            this.helipad = { x: p.x, z: p.z, radius: 5 };
        }
    }

    _addTrimeshBody(mesh) {
        const geo = mesh.geometry;
        if (!geo || !geo.attributes.position) return;
        const posAttr = geo.attributes.position;
        const verts = new Float32Array(posAttr.count * 3);
        const tmp = new THREE.Vector3();
        for (let i = 0; i < posAttr.count; i++) {
            tmp.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
            tmp.applyMatrix4(mesh.matrixWorld);
            verts[i * 3    ] = tmp.x;
            verts[i * 3 + 1] = tmp.y;
            verts[i * 3 + 2] = tmp.z;
        }
        let indices;
        if (geo.index) {
            indices = new Int32Array(geo.index.count);
            for (let i = 0; i < geo.index.count; i++) indices[i] = geo.index.getX(i);
        } else {
            indices = new Int32Array(posAttr.count);
            for (let i = 0; i < posAttr.count; i++) indices[i] = i;
        }
        const shape = new CANNON.Trimesh(verts, indices);
        const body = new CANNON.Body({
            mass: 0,
            material: this._physicsWorld.defaultMaterial,
        });
        body.addShape(shape);
        this._physicsWorld.addBody(body);
    }


    _buildOcean(worldRoot) {
        // Find any water mesh in the scene and swap its material for
        // our Ocean shader. Otherwise add a big plane like GameWorld.
        let waterMesh = null;
        worldRoot.traverse((c) => {
            if (waterMesh) return;
            const n = (c.name || '').toLowerCase();
            if (c.isMesh && (n.includes('water') || n.includes('sea') || n.includes('ocean'))) {
                waterMesh = c;
            }
        });
        if (!waterMesh) {
            const geo = new THREE.PlaneGeometry(2000, 2000, 32, 32);
            waterMesh = new THREE.Mesh(geo);
            waterMesh.rotation.x = -Math.PI / 2;
            waterMesh.position.y = -5;
            this.root.add(waterMesh);
        }
        waterMesh.name = 'Sea';
        this.sea = waterMesh;
        this.ocean = new Ocean(waterMesh, {
            sunDirection: new THREE.Vector3(-0.6, 0.7, -0.4).normalize(),
        });
    }

    show() { this.root.visible = true; }
    hide() { this.root.visible = false; }

    update(dt, playerPos, camera) {
        if (this.ocean && camera) this.ocean.update(dt, camera);
    }

    get plane() { return null; }
    get fountain() { return null; }

    // no-ops for things GameWorld exposes
    pickupNear() { return null; }
    pushObjects() {}
}
