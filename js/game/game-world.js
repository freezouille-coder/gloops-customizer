import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { loadSketchbookAssets } from './game-sketchbook-assets.js';
import { spawnTreeInstancesFromJSON } from './game-tree-instancer.js';

/**
 * Game world: rolling plaza terrain, dense tree clusters, decorative
 * rocks, pickup items (donuts/veggies), kinematic push-balls, and
 * destructible cube towers.
 *
 * Terrain height is a deterministic function `heightAt(x,z)` so the
 * player + items + decor can all sit on the same surface without a
 * heightmap texture.
 */
export class GameWorld {
    constructor(scene) {
        this.scene = scene;
        this.root = new THREE.Group();
        this.root.name = 'GameWorld';
        this.RADIUS = 50;
        this.items = [];
        this.balls = [];
        this.bricks = [];
        this.obstacles = [];
        this.colliders = [];

        // Open-beach sector: no trees, no mountains inside this angular
        // slice — you can walk straight from the play area into the sea.
        this.beachAngle = 0;        // 0 = facing +Z (north)
        this.beachHalf  = 1.05;     // ~60° half-arc — wide visible beach
    }

    /**
     * True if the given (x, z) direction from origin is inside the open
     * beach sector.
     */
    isInBeachSector(x, z) {
        const a = Math.atan2(x, z);   // 0 = +Z
        let d = a - this.beachAngle;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        return Math.abs(d) < this.beachHalf;
    }

    /**
     * Push the player position out of any collider it overlaps.
     * Uses 2D (XZ) circles for cheap but solid collision.
     */
    collidePlayer(pos, playerRadius = 0.5) {
        for (const c of this.colliders) {
            const dx = pos.x - c.x;
            const dz = pos.z - c.z;
            const d2 = dx * dx + dz * dz;
            const min = c.radius + playerRadius;
            if (d2 < min * min) {
                if (d2 < 0.0001) {
                    // Dead-center fallback: eject in an arbitrary direction
                    pos.x = c.x + min;
                    pos.z = c.z;
                } else {
                    const d = Math.sqrt(d2);
                    const push = (min - d) / d;
                    pos.x += dx * push;
                    pos.z += dz * push;
                }
            }
        }
    }

    /**
     * Collide a vehicle (larger radius) and kill its speed on impact.
     * Returns true if a hit happened (so the caller can dampen velocity).
     */
    collideVehicle(pos, radius = 1.3) {
        let hit = false;
        for (const c of this.colliders) {
            const dx = pos.x - c.x;
            const dz = pos.z - c.z;
            const d2 = dx * dx + dz * dz;
            const min = c.radius + radius;
            if (d2 < min * min) {
                if (d2 < 0.0001) {
                    pos.x = c.x + min;
                    pos.z = c.z;
                } else {
                    const d = Math.sqrt(d2);
                    const push = (min - d) / d;
                    pos.x += dx * push;
                    pos.z += dz * push;
                }
                hit = true;
            }
        }
        return hit;
    }

    /**
     * Register external vehicles (cars, planes) as collision targets.
     * Called by Game.enter() once the vehicles are spawned.
     */
    setVehicles(list) { this._vehicles = list || []; }

    /**
     * Collide an entity (player, NPC) against DYNAMIC objects —
     * balls, unsettled bricks, and vehicles. Uses simple circle push-out
     * so they can't walk through a car or a ball.
     */
    collideDynamic(pos, radius = 0.5) {
        // Balls
        for (const b of this.balls) {
            const dx = pos.x - b.mesh.position.x;
            const dz = pos.z - b.mesh.position.z;
            const d2 = dx * dx + dz * dz;
            const min = radius + b.radius;
            if (d2 < min * min && d2 > 0.0001) {
                const d = Math.sqrt(d2);
                const push = (min - d) / d;
                pos.x += dx * push;
                pos.z += dz * push;
                // Kick the ball away a little too
                b.vel.x -= dx * 2;
                b.vel.z -= dz * 2;
            }
        }
        // Bricks
        for (const br of this.bricks) {
            const dx = pos.x - br.mesh.position.x;
            const dz = pos.z - br.mesh.position.z;
            const dy = Math.abs(pos.y - br.mesh.position.y);
            if (dy > 1.5) continue;
            const d2 = dx * dx + dz * dz;
            const min = radius + br.size * 0.6;
            if (d2 < min * min && d2 > 0.0001) {
                const d = Math.sqrt(d2);
                const push = (min - d) / d;
                pos.x += dx * push;
                pos.z += dz * push;
            }
        }
        // Vehicles
        if (this._vehicles) {
            for (const v of this._vehicles) {
                if (!v.group.visible) continue;
                const dx = pos.x - v.group.position.x;
                const dz = pos.z - v.group.position.z;
                const d2 = dx * dx + dz * dz;
                const min = radius + 1.3;
                if (d2 < min * min && d2 > 0.0001) {
                    const d = Math.sqrt(d2);
                    const push = (min - d) / d;
                    pos.x += dx * push;
                    pos.z += dz * push;
                }
            }
        }
    }

    /**
     * Is a given XZ point on the oval driving track? Used to keep trees
     * and other decor off the road.
     */
    isOnTrack(x, z) {
        // Same oval parameters as _buildTrack: radius 20..26 scaled X by 1.25
        const xn = x / 1.25;
        const r = Math.hypot(xn, z);
        return r > 19 && r < 27;
    }

    // Flat ground — no vertical bobbing while walking.
    heightAt(x, z) { return 0; }

    build() {
        // Kick off the Sketchbook world texture + lights harvest —
        // resolves async. Textures swap on the island / track / water,
        // and any lights are added to the scene.
        loadSketchbookAssets().then((assets) => {
            this._applySketchbookTextures(assets);
            this._applySketchbookLights(assets);
        });

        // Note: no separate ground plane. The island cylinder top IS the
        // ground — prevents z-fighting with any other y=0 decor.

        // ----- Oval asphalt driving track (purely visual) -----
        this._buildTrack();

        // ----- Runway (plane take-off strip) -----
        this._buildRunway();

        // ----- Helipad (helicopter landing circle) -----
        this._buildHelipad();

        // ----- Fountain at the center of the map -----
        this._buildFountain();

        // ----- Sea surrounding the island -----
        this._buildSea();

        // ----- Ring of border mountains to delimit the map -----
        this._buildMountains();

        // ----- Decorative hills at the edges (not walkable, just depth) -----
        this._buildHills();

        // ----- Tree clusters (avoid the track) -----
        this._buildTreeClusters();

        // ----- Dense border forest (between mountains and the plaza) -----
        this._buildBorderForest();

        // ----- Custom JSON-driven tree instances (from Maya MASH export) -----
        this._loadJSONTrees();

        // ----- Decorative rocks scattered (with some clusters) -----
        for (let i = 0; i < 18; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 4 + Math.random() * 18;
            const x = Math.cos(angle) * dist;
            const z = Math.sin(angle) * dist;
            this._addRock(x, z, 0.3 + Math.random() * 0.6);
        }

        // ----- Pickup items -----
        this._spawnInitialItems();

        // ----- Push balls -----
        this._spawnBalls();

        // ----- Destructible cube towers -----
        this._buildTowers();

        this.scene.add(this.root);
    }

    /**
     * Harvest textures from Sketchbook's world.glb (ground / road / sand /
     * water) and apply them to our island, track, and shore materials.
     * Called once asynchronously after world.glb parses. Falls back
     * silently if any texture is missing.
     */
    _applySketchbookLights(assets) {
        if (!assets.lights || assets.lights.length === 0) return;
        console.log('[Sketchbook] applying', assets.lights.length, 'lights');
        for (const light of assets.lights) {
            // Clone the light so we don't pull it out of the GLB tree
            const cloned = light.clone();
            // If it has a target, clone that too
            if (light.target) {
                cloned.target = light.target.clone();
                this.root.add(cloned.target);
            }
            cloned.castShadow = true;
            this.root.add(cloned);
        }
    }

    _applySketchbookTextures(assets) {
        // --- Ground (island top) ---
        if (assets.ground) {
            if (assets.ground.map) {
                const m = assets.ground.map.clone();
                m.wrapS = m.wrapT = THREE.RepeatWrapping;
                m.repeat.set(14, 14);
                m.needsUpdate = true;
                this.islandMat.map = m;
                this.islandMat.color.set(0xffffff);
            }
            if (assets.ground.normalMap) {
                const nm = assets.ground.normalMap.clone();
                nm.wrapS = nm.wrapT = THREE.RepeatWrapping;
                nm.repeat.set(14, 14);
                nm.needsUpdate = true;
                this.islandMat.normalMap = nm;
            }
            this.islandMat.needsUpdate = true;
        }
        // Road stays grey (no Sketchbook texture) — UVs were fighting.
        // --- Sand shore ---
        if (assets.sand && this.shoreMat && assets.sand.map) {
            const m = assets.sand.map.clone();
            m.wrapS = m.wrapT = THREE.RepeatWrapping;
            m.repeat.set(10, 10);
            m.needsUpdate = true;
            this.shoreMat.map = m;
            this.shoreMat.color.set(0xffffff);
            this.shoreMat.needsUpdate = true;
        }
        // Sea shader = THREE.Water (real reflective ocean). We keep it.
    }

    _buildTrack() {
        // Oval asphalt ring — flat grey, no texture (UVs fighting wasn't worth it)
        const outerR = 26;
        const innerR = 20;
        const ringGeo = new THREE.RingGeometry(innerR, outerR, 96, 1);
        ringGeo.rotateX(-Math.PI / 2);
        const pos = ringGeo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            pos.setX(i, pos.getX(i) * 1.25);
        }
        ringGeo.computeVertexNormals();
        const asphaltMat = new THREE.MeshStandardMaterial({
            color: 0x4a4a50, roughness: 0.9, metalness: 0.02
        });
        const track = new THREE.Mesh(ringGeo, asphaltMat);
        track.position.y = 0.12;
        track.receiveShadow = true;
        this.root.add(track);
        this.trackMat = asphaltMat;
        this.trackMesh = track;

        // Lane dash markers (thin white boxes along the mid-line of the ring)
        const midR = (innerR + outerR) / 2;
        const dashMat = new THREE.MeshStandardMaterial({
            color: 0xf0e9c0, emissive: 0x332200, emissiveIntensity: 0.1
        });
        const dashGeo = new THREE.BoxGeometry(0.6, 0.05, 0.15);
        const dashes = 48;
        for (let i = 0; i < dashes; i++) {
            const a = (i / dashes) * Math.PI * 2;
            const x = Math.cos(a) * midR * 1.25;
            const z = Math.sin(a) * midR;
            const dash = new THREE.Mesh(dashGeo, dashMat);
            dash.position.set(x, 0.14, z);
            dash.rotation.y = -a + Math.PI / 2;
            this.root.add(dash);
        }

        // A few cones near the start line (visual only, pushable if we want)
        const coneGeo = new THREE.ConeGeometry(0.28, 0.7, 8);
        const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6633, roughness: 0.6 });
        for (let i = 0; i < 6; i++) {
            const c = new THREE.Mesh(coneGeo, coneMat);
            c.position.set(18 + (i % 2) * 1.2, 0.35, 0.5 + i * 0.6);
            c.castShadow = true;
            this.root.add(c);
        }
    }

    _buildHills() {
        // Big decorative hemispheres at the far edges of the plaza.
        // They're pushed FAR from origin (outside the play zone) so they
        // don't disrupt movement, but they give depth to the horizon.
        const hillMat = new THREE.MeshStandardMaterial({
            color: 0x86734a, roughness: 1, metalness: 0
        });
        const grassMat = new THREE.MeshStandardMaterial({
            color: 0x5a8a35, roughness: 0.95, metalness: 0
        });
        const spots = [
            { x:  30, z:  25, rx: 14, ry: 5, rz: 12, grass: true },
            { x: -28, z:  35, rx: 12, ry: 6, rz: 12, grass: true },
            { x:  38, z: -18, rx: 16, ry: 7, rz: 14, grass: false },
            { x: -35, z: -30, rx: 14, ry: 6, rz: 14, grass: true },
            { x:   0, z: -42, rx: 20, ry: 5, rz: 12, grass: true },
            { x:  20, z:  42, rx: 12, ry: 4, rz: 10, grass: false },
        ];
        for (const s of spots) {
            const geo = new THREE.SphereGeometry(1, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2);
            const mesh = new THREE.Mesh(geo, s.grass ? grassMat : hillMat);
            mesh.scale.set(s.rx, s.ry, s.rz);
            mesh.position.set(s.x, 0, s.z);
            mesh.receiveShadow = true;
            this.root.add(mesh);
        }
    }

    _buildTreeClusters() {
        // Inner tree clusters — inside or at the edge of the track.
        const zones = [
            { x:  0,  z:   0,  count: 4, spread: 3 },
            { x:  26, z:   0,  count: 8, spread: 5 },
            { x: -26, z:   0,  count: 8, spread: 5 },
            { x:   0, z:  26,  count: 7, spread: 5 },
            { x:   0, z: -26,  count: 7, spread: 5 },
            { x:  18, z:  18,  count: 6, spread: 4 },
            { x: -18, z:  18,  count: 6, spread: 4 },
            { x:  18, z: -18,  count: 6, spread: 4 },
            { x: -18, z: -18,  count: 6, spread: 4 },
        ];
        for (const zone of zones) {
            for (let i = 0; i < zone.count; i++) {
                const ang = Math.random() * Math.PI * 2;
                const r = Math.random() * zone.spread;
                const x = zone.x + Math.cos(ang) * r;
                const z = zone.z + Math.sin(ang) * r;
                if (this.isOnTrack(x, z)) continue;
                if (Math.hypot(x, z) < 2.8) continue;
                this._addTree(x, z, 1 + Math.random() * 0.6);
            }
        }
    }

    _buildBorderForest() {
        const count = 140;
        for (let i = 0; i < count; i++) {
            const ang = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.08;
            const r = 38 + Math.random() * 10;
            const x = Math.cos(ang) * r;
            const z = Math.sin(ang) * r;
            if (this.isOnTrack(x, z)) continue;
            if (this.isInBeachSector(x, z)) continue;     // leave beach clear
            const scale = 1 + Math.random() * 0.9;
            this._addTree(x, z, scale);
        }
    }

    /**
     * Big circular sea plane + simple wave shader. The island (= the
     * flat sand plane at y=0) sits on top of it as an elevated terrace.
     */
    _buildSea() {
        // HUGE sea plane — "à perte de vue" (1200×1200 units)
        const seaGeo = new THREE.PlaneGeometry(1200, 1200);
        // THREE.Water uses a reflective shader with animated normal map
        // and sun reflection — this is the classic three.js ocean.
        const waterNormals = new THREE.TextureLoader().load(
            'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/textures/waternormals.jpg',
            (tex) => { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; }
        );
        const sea = new Water(seaGeo, {
            textureWidth: 512,
            textureHeight: 512,
            waterNormals,
            sunDirection: new THREE.Vector3(0.4, 0.6, 0.3).normalize(),
            sunColor: 0xffffff,
            waterColor: 0x0b4a7a,
            distortionScale: 3.7,
            fog: this.scene?.fog !== undefined,
        });
        sea.rotation.x = -Math.PI / 2;
        sea.position.y = -1.6;
        this.root.add(sea);
        this.sea = sea;

        // No separate cylinder side — the top plane's slope handles the edge
        const islandR = this.RADIUS;

        // Island TOP — subdivided plane with subtle vertex bumps for terrain
        // variety. Bumps are small (±0.15) so the player walking on a flat
        // collision plane doesn't look too weird. Center near origin is
        // completely flat (under the play zone).
        // Make the island radius slightly larger than the play area
        // so the beach has room to slope down into the sea smoothly.
        const visualR = islandR + 8;
        const topGeo = new THREE.PlaneGeometry(visualR * 2, visualR * 2, 128, 128);
        topGeo.rotateX(-Math.PI / 2);
        const pos = topGeo.attributes.position;
        const FLAT_R = 22;
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i);
            const z = pos.getZ(i);
            const r = Math.hypot(x, z);
            // Cut the plane off past the visual radius
            if (r > visualR + 0.5) { pos.setY(i, -1.8); continue; }
            // Flatten the track completely
            if (this.isOnTrack(x, z)) { pos.setY(i, 0); continue; }
            // Smooth slope down near the edge using smoothstep
            // flat until SLOPE_START, then dips to SHORE_Y by visualR
            const SLOPE_START = islandR - 4;
            const SHORE_Y = -1.6;    // matches sea level
            let base = 0;
            if (r > SLOPE_START) {
                const t = Math.min(1, (r - SLOPE_START) / (visualR - SLOPE_START));
                // smoothstep
                const s = t * t * (3 - 2 * t);
                base = SHORE_Y * s;
            }
            // Subtle interior noise, fading to 0 at the edge
            const noiseFade = Math.max(0, Math.min(1, (r - FLAT_R) / (SLOPE_START - FLAT_R)))
                              * (r < SLOPE_START ? 1 : 0);
            const noise =
                Math.sin(x * 0.23 + z * 0.17) * 0.09 +
                Math.cos(z * 0.31 - x * 0.15) * 0.07;
            pos.setY(i, base + noise * noiseFade);
        }
        topGeo.computeVertexNormals();
        const topMat = new THREE.MeshStandardMaterial({
            color: 0xb2965e, roughness: 1, metalness: 0
        });
        const islandTop = new THREE.Mesh(topGeo, topMat);
        islandTop.position.y = 0;
        islandTop.receiveShadow = true;
        this.root.add(islandTop);
        this.islandTop = islandTop;
        this.islandMat = topMat;

        // Smoother beach sand color at the sloped rim
        this.shoreMat = null;
    }

    _buildMountains() {
        // Big cone mountains far out (radius 40-55) to delimit the world.
        const mountainMat = new THREE.MeshStandardMaterial({
            color: 0x5e5040, roughness: 1, metalness: 0
        });
        // Snow cap uses polygonOffset so it always wins the depth buffer
        // vs the underlying mountain — no more flicker at the peak.
        const snowMat = new THREE.MeshStandardMaterial({
            color: 0xf8f8f8, roughness: 0.7, metalness: 0,
            polygonOffset: true,
            polygonOffsetFactor: -4,
            polygonOffsetUnits: -4,
        });
        const COUNT = 34;
        for (let i = 0; i < COUNT; i++) {
            const ang = (i / COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
            const r = 54 + Math.random() * 12;
            const x = Math.cos(ang) * r;
            const z = Math.sin(ang) * r;
            // Skip mountains that fall in the open beach sector
            if (this.isInBeachSector(x, z)) continue;
            const h = 18 + Math.random() * 12;
            const baseR = 8 + Math.random() * 5;
            const mountain = new THREE.Mesh(
                new THREE.ConeGeometry(baseR, h, 12),
                mountainMat
            );
            mountain.position.set(x, h / 2 - 0.5, z);
            mountain.castShadow = true;
            mountain.receiveShadow = true;
            this.root.add(mountain);
            // Mountain base acts as a hard wall — player, car and NPCs
            // cannot cross it. Radius matches the base of the cone.
            this.obstacles.push(mountain);
            this.colliders.push({ x, z, radius: baseR * 0.85 });
            // Snow cap: slightly wider base (covers the mountain surface)
            // and taller so its peak extends a bit above the mountain peak.
            // Result: no shared vertex at the top → no flicker.
            const capH = h * 0.50;
            const capBaseR = baseR * 0.48;
            const cap = new THREE.Mesh(
                new THREE.ConeGeometry(capBaseR, capH, 12),
                snowMat
            );
            cap.position.set(x, h * 0.75 - 0.5 + capH * 0.05, z);
            this.root.add(cap);
        }
    }

    /**
     * Async-load any JSON tree files from `assets/trees/` and spawn
     * them as InstancedMesh groups. Each file is created via
     * scripts/export_trees.py from Maya.
     *
     * Files are loaded with Promise.allSettled so a missing file doesn't
     * break the build.
     */
    _loadJSONTrees() {
        const files = [
            'assets/trees/pine.json',
            'assets/trees/oak.json',
            'assets/trees/rock.json',
        ];
        Promise.allSettled(
            files.map(url => spawnTreeInstancesFromJSON(url, this.root, {
                colliderRadius: 0.25,
            }))
        ).then(results => {
            let totalCount = 0;
            for (const r of results) {
                if (r.status === 'fulfilled' && r.value.colliders.length) {
                    // Add the collider circles to the world's collision list
                    // so the player / vehicles / NPCs collide with them.
                    this.colliders.push(...r.value.colliders);
                    totalCount += r.value.colliders.length;
                }
            }
            if (totalCount > 0) {
                console.log('[World] Loaded ' + totalCount + ' JSON-driven trees');
            }
        });
    }

    _buildRunway() {
        // Long rectangle running W→E outside the track, on the west side.
        const length = 34;
        const width  = 6;
        const cx = -34, cz = -10;   // center position
        const rot = Math.PI * 0.15; // slight angle so it's not axis-aligned

        const baseMat = new THREE.MeshStandardMaterial({
            color: 0x3a3a40, roughness: 0.92, metalness: 0.02
        });
        const base = new THREE.Mesh(
            new THREE.PlaneGeometry(width, length),
            baseMat
        );
        base.rotation.x = -Math.PI / 2;
        base.rotation.z = rot;
        base.position.set(cx, 0.13, cz);
        base.receiveShadow = true;
        this.root.add(base);

        // Sand apron (wider, slightly lighter)
        const apronMat = new THREE.MeshStandardMaterial({
            color: 0x8a7454, roughness: 1
        });
        const apron = new THREE.Mesh(
            new THREE.PlaneGeometry(width + 4, length + 4),
            apronMat
        );
        apron.rotation.x = -Math.PI / 2;
        apron.rotation.z = rot;
        apron.position.set(cx, 0.11, cz);
        apron.receiveShadow = true;
        this.root.add(apron);

        // Centerline dashes
        const dashGeo = new THREE.BoxGeometry(0.5, 0.04, 1.4);
        const dashMat = new THREE.MeshStandardMaterial({
            color: 0xf0ebd0, emissive: 0x332200, emissiveIntensity: 0.1
        });
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const dashes = 10;
        for (let i = 0; i < dashes; i++) {
            const t = (i / (dashes - 1) - 0.5) * (length - 4);
            // local (0, t) → rotated by `rot` around Y
            const lx = 0 * cos - t * sin;
            const lz = 0 * sin + t * cos;
            const dash = new THREE.Mesh(dashGeo, dashMat);
            dash.position.set(cx + lx, 0.17, cz + lz);
            dash.rotation.y = -rot;
            this.root.add(dash);
        }

        // Threshold bars at each end (white zebras)
        const zebraMat = new THREE.MeshStandardMaterial({ color: 0xf8f8f0 });
        for (const end of [-1, 1]) {
            for (let i = 0; i < 5; i++) {
                const stripe = new THREE.Mesh(
                    new THREE.BoxGeometry(0.6, 0.04, 0.35),
                    zebraMat
                );
                const offsetAcross = (i - 2) * 0.9;
                const offsetAlong  = end * (length / 2 - 1);
                const lx = offsetAcross * cos - offsetAlong * sin;
                const lz = offsetAcross * sin + offsetAlong * cos;
                stripe.position.set(cx + lx, 0.18, cz + lz);
                stripe.rotation.y = -rot;
                this.root.add(stripe);
            }
        }

        // Save spawn position for the airplane (at one end of the runway)
        const spawnT = length / 2 - 4;
        const spx = cx + (0 * cos - spawnT * sin);
        const spz = cz + (0 * sin + spawnT * cos);
        this.runwayStart = { x: spx, z: spz, yaw: rot };
    }

    _buildHelipad() {
        // Circular pad with an "H" in the center, placed on the NE corner.
        const cx = 30, cz = -22;

        // Concrete disc
        const padMat = new THREE.MeshStandardMaterial({
            color: 0x5a5a62, roughness: 0.88, metalness: 0.05
        });
        const pad = new THREE.Mesh(
            new THREE.CylinderGeometry(5, 5, 0.25, 40),
            padMat
        );
        pad.position.set(cx, 0.13, cz);
        pad.receiveShadow = true;
        this.root.add(pad);

        // Yellow outline ring
        const ringMat = new THREE.MeshStandardMaterial({
            color: 0xffdd00, emissive: 0x332200, emissiveIntensity: 0.2
        });
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(4.2, 4.6, 48),
            ringMat
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(cx, 0.27, cz);
        this.root.add(ring);

        // "H" letter — 2 vertical bars + 1 horizontal bar
        const letterMat = new THREE.MeshStandardMaterial({
            color: 0xffdd00, emissive: 0x332200, emissiveIntensity: 0.2
        });
        const barV = new THREE.BoxGeometry(0.55, 0.05, 3.0);
        const barH = new THREE.BoxGeometry(2.0, 0.05, 0.55);
        const left  = new THREE.Mesh(barV, letterMat);
        const right = new THREE.Mesh(barV, letterMat);
        const mid   = new THREE.Mesh(barH, letterMat);
        left.position.set(cx - 1.0, 0.28, cz);
        right.position.set(cx + 1.0, 0.28, cz);
        mid.position.set(cx, 0.28, cz);
        this.root.add(left);
        this.root.add(right);
        this.root.add(mid);

        // Save spawn position for the helicopter
        this.helipad = { x: cx, z: cz, radius: 5 };
    }

    _buildFountain() {
        const group = new THREE.Group();
        group.name = 'Fountain';
        const stoneMat = new THREE.MeshStandardMaterial({
            color: 0xa0a0a8, roughness: 0.85, metalness: 0.05
        });
        const waterMat = new THREE.MeshStandardMaterial({
            color: 0x5aa8ff, roughness: 0.1, metalness: 0.4,
            transparent: true, opacity: 0.75, emissive: 0x184488, emissiveIntensity: 0.3
        });

        // Outer basin
        const basin = new THREE.Mesh(
            new THREE.CylinderGeometry(2.0, 2.2, 0.4, 24),
            stoneMat
        );
        basin.position.y = 0.2;
        basin.castShadow = true;
        basin.receiveShadow = true;
        group.add(basin);
        // Inner basin lip
        const lip = new THREE.Mesh(
            new THREE.TorusGeometry(1.9, 0.12, 8, 24),
            stoneMat
        );
        lip.position.y = 0.42;
        lip.rotation.x = Math.PI / 2;
        group.add(lip);
        // Water surface
        const water = new THREE.Mesh(
            new THREE.CylinderGeometry(1.85, 1.85, 0.05, 24),
            waterMat
        );
        water.position.y = 0.36;
        group.add(water);
        // Central pillar
        const pillar = new THREE.Mesh(
            new THREE.CylinderGeometry(0.28, 0.35, 1.4, 12),
            stoneMat
        );
        pillar.position.y = 1.1;
        pillar.castShadow = true;
        group.add(pillar);
        // Top basin (small)
        const topBowl = new THREE.Mesh(
            new THREE.CylinderGeometry(0.55, 0.35, 0.2, 16),
            stoneMat
        );
        topBowl.position.y = 1.9;
        topBowl.castShadow = true;
        group.add(topBowl);
        // Water jet (thin cone)
        const jet = new THREE.Mesh(
            new THREE.ConeGeometry(0.12, 0.8, 10),
            waterMat
        );
        jet.position.y = 2.35;
        group.add(jet);
        // 4 side water arcs (falling DOWN into the basin)
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2;
            const arc = new THREE.Mesh(
                new THREE.TorusGeometry(0.45, 0.04, 6, 10, Math.PI),
                waterMat
            );
            // Top of the pillar where water spills outward and down
            arc.position.set(Math.cos(a) * 0.7, 1.75, Math.sin(a) * 0.7);
            // Orient so the arc's open end faces down & outward (water falls from jet → basin)
            arc.rotation.y = -a + Math.PI / 2;
            arc.rotation.z = -Math.PI / 2;
            group.add(arc);
        }

        group.position.set(0, 0, 0);
        this.root.add(group);

        // Collision: block player/vehicle from going through
        this.obstacles.push(basin);
        this.obstacles.push(pillar);
        this.colliders.push({ x: 0, z: 0, radius: 2.2 });

        this.fountain = group;
    }

    _addTree(x, z, scale) {
        const y = this.heightAt(x, z);
        const trunkH = 1.6 * scale;
        const trunkGeo = new THREE.CylinderGeometry(0.18 * scale, 0.28 * scale, trunkH, 8);
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 });
        const trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.position.set(x, y + trunkH / 2, z);
        trunk.castShadow = true;
        trunk.receiveShadow = true;
        this.root.add(trunk);
        this.obstacles.push(trunk);
        // Tight collider — just the trunk itself, not the foliage
        this.colliders.push({ x, z, radius: 0.22 * scale });

        // Big foliage: 2-3 stacked cones
        const leafColor = new THREE.Color().setHSL(0.28 + Math.random() * 0.05, 0.5, 0.35);
        const leafMat = new THREE.MeshStandardMaterial({ color: leafColor, roughness: 0.9 });
        const layers = 2 + Math.floor(Math.random() * 2);
        for (let i = 0; i < layers; i++) {
            const r = (1.3 - i * 0.25) * scale;
            const h = 1.4 * scale;
            const leaf = new THREE.Mesh(new THREE.ConeGeometry(r, h, 8), leafMat);
            leaf.position.set(x, y + trunkH + i * h * 0.55, z);
            leaf.castShadow = true;
            this.root.add(leaf);
            this.obstacles.push(leaf);
        }
    }

    _addRock(x, z, size) {
        const y = this.heightAt(x, z);
        const geo = new THREE.DodecahedronGeometry(size, 0);
        const col = new THREE.Color().setHSL(0.08 + Math.random() * 0.05, 0.25, 0.4);
        const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.95 });
        const rock = new THREE.Mesh(geo, mat);
        rock.position.set(x, y + size * 0.5, z);
        rock.rotation.set(Math.random(), Math.random(), Math.random());
        rock.castShadow = true;
        rock.receiveShadow = true;
        this.root.add(rock);
        this.obstacles.push(rock);
        // Only register big rocks as colliders — small decor rocks should
        // NOT create invisible walls for the car. Also the collider is
        // tighter than the visual mesh so the car doesn't stop early.
        if (size > 0.55) {
            this.colliders.push({ x, z, radius: size * 0.55 });
        }
    }

    _spawnInitialItems() {
        for (let i = 0; i < 8; i++) this._spawnItem('donut');
        for (let i = 0; i < 8; i++) this._spawnItem('veggie');
    }

    _spawnItem(type) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 2 + Math.random() * 18;
        const x = Math.cos(angle) * dist;
        const z = Math.sin(angle) * dist;
        const y = this.heightAt(x, z);
        const mesh = type === 'donut' ? this._makeDonut() : this._makeVeggie();
        mesh.position.set(x, y + 0.4, z);
        mesh.userData.spinPhase = Math.random() * Math.PI * 2;
        mesh.userData.baseY = y + 0.4;
        this.root.add(mesh);
        this.items.push({ mesh, type, pickedUp: false, respawnAt: 0 });
    }

    _makeDonut() {
        const geo = new THREE.TorusGeometry(0.18, 0.07, 10, 16);
        const mat = new THREE.MeshStandardMaterial({ color: 0xe8a060, roughness: 0.6 });
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = true;
        const frostGeo = new THREE.TorusGeometry(0.18, 0.072, 10, 16, Math.PI * 1.6);
        const frostMat = new THREE.MeshStandardMaterial({ color: 0xff6b9a, roughness: 0.4 });
        const frost = new THREE.Mesh(frostGeo, frostMat);
        frost.position.y = 0.04;
        m.add(frost);
        return m;
    }

    _makeVeggie() {
        const group = new THREE.Group();
        const bodyGeo = new THREE.ConeGeometry(0.1, 0.4, 8);
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf08040, roughness: 0.7 });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.rotation.z = Math.PI;
        body.castShadow = true;
        group.add(body);
        const leafGeo = new THREE.ConeGeometry(0.06, 0.18, 6);
        const leafMat = new THREE.MeshStandardMaterial({ color: 0x4aaa3a, roughness: 0.9 });
        for (let i = 0; i < 3; i++) {
            const leaf = new THREE.Mesh(leafGeo, leafMat);
            leaf.position.set((i - 1) * 0.04, 0.25, 0);
            leaf.rotation.z = (i - 1) * 0.3;
            group.add(leaf);
        }
        return group;
    }

    // ----- Push balls -----
    _spawnBalls() {
        const colors = [0xff5a5a, 0x5aa8ff, 0xffd24a, 0x8eff6a];
        for (let i = 0; i < 4; i++) {
            const angle = (i / 4) * Math.PI * 2 + 0.7;
            const dist = 6 + i;
            const x = Math.cos(angle) * dist;
            const z = Math.sin(angle) * dist;
            const radius = 0.5;
            const geo = new THREE.SphereGeometry(radius, 20, 16);
            const mat = new THREE.MeshStandardMaterial({
                color: colors[i % colors.length], roughness: 0.5, metalness: 0.05
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.position.set(x, this.heightAt(x, z) + radius, z);
            this.root.add(mesh);
            this.balls.push({
                mesh,
                radius,
                vel: new THREE.Vector3(),
            });
        }
    }

    // ----- Destructible cube towers -----
    _buildTowers() {
        const towers = [
            { x: 6, z: 6, count: 6 },
            { x: -7, z: 4, count: 5 },
            { x: 0, z: -8, count: 7 },
        ];
        for (const t of towers) {
            const baseY = this.heightAt(t.x, t.z);
            const size = 0.55;
            for (let i = 0; i < t.count; i++) {
                const geo = new THREE.BoxGeometry(size, size, size);
                const hue = 0.05 + (i / t.count) * 0.3;
                const mat = new THREE.MeshStandardMaterial({
                    color: new THREE.Color().setHSL(hue, 0.7, 0.55),
                    roughness: 0.6
                });
                const cube = new THREE.Mesh(geo, mat);
                const jitter = (Math.random() - 0.5) * 0.05;
                cube.position.set(t.x + jitter, baseY + size * (i + 0.5), t.z + jitter);
                cube.castShadow = true;
                cube.receiveShadow = true;
                this.root.add(cube);
                this.bricks.push({
                    mesh: cube,
                    size,
                    vel: new THREE.Vector3(),
                    angVel: new THREE.Vector3(),
                    settled: true,
                    baseGround: baseY,
                });
            }
        }
    }

    /**
     * Push balls and bricks around when the player walks into them.
     * Called from GamePlayer.update.
     */
    pushObjects(playerPos, playerDir, playerSpeed) {
        const PUSH = Math.max(2.0, playerSpeed * 1.4);
        // Balls
        for (const b of this.balls) {
            const dx = b.mesh.position.x - playerPos.x;
            const dz = b.mesh.position.z - playerPos.z;
            const d = Math.hypot(dx, dz);
            const minDist = b.radius + 0.6;
            if (d < minDist && d > 0.01) {
                const nx = dx / d, nz = dz / d;
                // Mix push direction toward away-from-player + player movement dir
                b.vel.x = nx * PUSH * 0.6 + playerDir.x * PUSH * 0.7;
                b.vel.z = nz * PUSH * 0.6 + playerDir.z * PUSH * 0.7;
            }
        }
        // Bricks: knock them when player touches an unsettled-or-low cube
        for (const br of this.bricks) {
            const dx = br.mesh.position.x - playerPos.x;
            const dy = br.mesh.position.y - playerPos.y;
            const dz = br.mesh.position.z - playerPos.z;
            const d = Math.hypot(dx, dz);
            const minDist = br.size * 0.8 + 0.4;
            if (d < minDist && Math.abs(dy) < 1.2 && d > 0.01) {
                const nx = dx / d, nz = dz / d;
                br.vel.x = nx * PUSH * 0.8 + playerDir.x * PUSH * 0.5;
                br.vel.z = nz * PUSH * 0.8 + playerDir.z * PUSH * 0.5;
                br.vel.y = 2.5 + Math.random() * 1.5;
                br.angVel.set(
                    (Math.random() - 0.5) * 6,
                    (Math.random() - 0.5) * 6,
                    (Math.random() - 0.5) * 6
                );
                br.settled = false;
            }
        }
    }

    pickupNear(pos, radius = 0.9) {
        let best = null;
        let bestD = radius * radius;
        for (const it of this.items) {
            if (it.pickedUp) continue;
            const dx = it.mesh.position.x - pos.x;
            const dz = it.mesh.position.z - pos.z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD) { best = it; bestD = d2; }
        }
        if (best) {
            best.pickedUp = true;
            best.mesh.visible = false;
            best.respawnAt = performance.now() + 18000;
            return best.type;
        }
        return null;
    }

    update(dt, playerPos) {
        const t = performance.now();

        // THREE.Water animated shader — advance its time uniform
        if (this.sea && this.sea.material?.uniforms?.['time']) {
            this.sea.material.uniforms['time'].value += dt;
        }

        // Items: spin + bob; respawn after timer
        for (const it of this.items) {
            if (it.pickedUp) {
                if (t >= it.respawnAt) {
                    const angle = Math.random() * Math.PI * 2;
                    const dist = 2 + Math.random() * 18;
                    const x = Math.cos(angle) * dist;
                    const z = Math.sin(angle) * dist;
                    it.mesh.position.set(x, this.heightAt(x, z) + 0.4, z);
                    it.mesh.userData.baseY = it.mesh.position.y;
                    it.mesh.visible = true;
                    it.pickedUp = false;
                }
                continue;
            }
            it.mesh.userData.spinPhase += dt;
            it.mesh.rotation.y = it.mesh.userData.spinPhase * 1.2;
            it.mesh.position.y = it.mesh.userData.baseY + Math.sin(it.mesh.userData.spinPhase * 2) * 0.05;
        }

        // Balls: friction, gravity, ground bounce, world bounds
        for (const b of this.balls) {
            // Apply friction
            b.vel.multiplyScalar(0.93);
            // Gravity
            b.vel.y -= 14 * dt;
            // Integrate
            b.mesh.position.addScaledVector(b.vel, dt);
            // Ground
            const gh = this.heightAt(b.mesh.position.x, b.mesh.position.z) + b.radius;
            if (b.mesh.position.y < gh) {
                b.mesh.position.y = gh;
                if (b.vel.y < 0) b.vel.y = -b.vel.y * 0.35;
            }
            // Roll: rotate around horizontal axis based on velocity
            b.mesh.rotation.x += b.vel.z * dt / b.radius;
            b.mesh.rotation.z -= b.vel.x * dt / b.radius;
            // Plaza bounds
            const r = Math.hypot(b.mesh.position.x, b.mesh.position.z);
            if (r > this.RADIUS) {
                const k = this.RADIUS / r;
                b.mesh.position.x *= k; b.mesh.position.z *= k;
                b.vel.x = -b.vel.x * 0.5; b.vel.z = -b.vel.z * 0.5;
            }
        }

        // --- Tower cascade: any settled brick that lost its support falls ---
        for (const br of this.bricks) {
            if (!br.settled) continue;
            const groundY = this.heightAt(br.mesh.position.x, br.mesh.position.z) + br.size * 0.5;
            if (br.mesh.position.y <= groundY + 0.05) continue; // sitting on ground
            // Look for a neighbouring brick directly below
            let supported = false;
            for (const other of this.bricks) {
                if (other === br) continue;
                const dx = other.mesh.position.x - br.mesh.position.x;
                const dz = other.mesh.position.z - br.mesh.position.z;
                const horiz = Math.hypot(dx, dz);
                const dy = br.mesh.position.y - other.mesh.position.y;
                if (horiz < br.size * 0.9 && dy > 0 && dy < br.size * 1.15) {
                    supported = true;
                    break;
                }
            }
            if (!supported) {
                br.settled = false;
                br.vel.set((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3);
            }
        }

        // Bricks: gravity, ground bounce, mutual collision
        for (const br of this.bricks) {
            if (br.settled) continue;
            br.vel.y -= 18 * dt;
            br.vel.x *= 0.96; br.vel.z *= 0.96;
            br.mesh.position.addScaledVector(br.vel, dt);
            br.mesh.rotation.x += br.angVel.x * dt;
            br.mesh.rotation.y += br.angVel.y * dt;
            br.mesh.rotation.z += br.angVel.z * dt;
            const gh = this.heightAt(br.mesh.position.x, br.mesh.position.z) + br.size * 0.5;
            if (br.mesh.position.y < gh) {
                br.mesh.position.y = gh;
                if (br.vel.y < 0) br.vel.y = -br.vel.y * 0.2;
                br.vel.x *= 0.7; br.vel.z *= 0.7;
                br.angVel.multiplyScalar(0.6);
                if (Math.abs(br.vel.y) < 0.3 && br.vel.lengthSq() < 0.4) {
                    br.vel.set(0, 0, 0);
                    br.angVel.set(0, 0, 0);
                    br.settled = true;
                }
            }
        }

    }

    show() { this.root.visible = true; }
    hide() { this.root.visible = false; }
}
