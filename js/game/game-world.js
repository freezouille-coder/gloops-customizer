import * as THREE from 'three';
import { Ocean } from './ocean.js';
import { loadSketchbookAssets } from './game-sketchbook-assets.js';
import { spawnTreeInstancesFromJSON } from './game-tree-instancer.js';
import { CityGenerator } from './city-generator.js';

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
        this.RADIUS = 80;
        this.isCity = true;   // GameWorld = city layout with blocks & roads
        this.items = [];
        this.balls = [];
        this.bricks = [];
        this.obstacles = [];
        this.colliders = [];

        // Open-beach sector: no trees, no mountains inside this angular
        // slice — you can walk straight from the play area into the sea.
        this.beachAngle = 0;        // 0 = facing +Z (north)
        this.beachHalf  = 1.05;     // ~60° half-arc — wide visible beach

        // Promise that resolves once the async city build is done. Game
        // awaits world.ready() so the loading screen stays up until the
        // real blocks are visible — no popcorn on scene reveal.
        this._cityReady = null;
    }

    /** Awaited by Game.build() — returns once async world pieces
     *  (currently just the CityGenerator) have finished loading. */
    ready() {
        return this._cityReady || Promise.resolve();
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

    /** Wire the cannon-es physics world BEFORE build() so _buildTestArena
     *  and future builders can register their colliders directly. */
    setPhysicsWorld(pw) { this._physicsWorld = pw; }

    /**
     * Mirror every 2D (XZ) collider in `this.colliders` into the cannon
     * physics world as a tall STATIC cylinder. This lets dynamic bodies
     * (cannon spheres, later the RaycastVehicle) bump against trees,
     * rocks and building walls.
     *
     * Called from Game.build() after world.build() has populated colliders.
     * Safe to call multiple times — tracks what it has already mirrored.
     */
    mirrorCollidersToPhysics(physicsWorld) {
        // Remember the world so we can re-mirror after async tree loading
        this._physicsWorld = physicsWorld || this._physicsWorld;
        const pw = this._physicsWorld;
        if (!pw) return;
        this._physicsBodies = this._physicsBodies || [];
        const alreadyMirrored = this._physicsBodies.length;
        let added = 0;
        for (let i = alreadyMirrored; i < this.colliders.length; i++) {
            const c = this.colliders[i];
            const height = 8;
            const body = pw.addStaticCylinder(
                c.radius, height,
                { x: c.x, y: height / 2, z: c.z }
            );
            this._physicsBodies.push(body);
            added++;
        }
        if (added > 0) {
            console.log(`[world] mirrored ${added} colliders to cannon (total ${this._physicsBodies.length})`);
        }
    }

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
        // Oval track removed in favor of the city grid. Keep the API
        // for back-compat (other systems call it); always return false.
        return false;
    }

    // Flat ground — no vertical bobbing while walking.
    heightAt(x, z) { return 0; }

    /**
     * Raycast downward at (x, z) to find the highest walkable surface
     * under that point. Returns the Y value. Falls back to 0 if nothing
     * is hit. Used by the player controller so they can walk UP ramps,
     * stairs, or hills authored in the world.
     */
    raycastGroundAt(x, z) {
        if (!this._groundRay) {
            this._groundRay = new THREE.Raycaster(
                new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 0, 12
            );
        }
        this._groundRay.set(
            new THREE.Vector3(x, 10, z),
            new THREE.Vector3(0, -1, 0),
        );
        const hits = this._groundRay.intersectObject(this.root, true);
        for (const h of hits) {
            // Ignore water, leaves (branches too thin), sprites
            const n = h.object.name || '';
            if (n.startsWith('Sea') || n.startsWith('Tree')) continue;
            return h.point.y;
        }
        return 0;
    }

    build() {
        // --- MINIMAL MODE ---
        // While we're iterating on the city block pipeline, the world
        // is stripped down to: flat ground plane + ocean + real blocks
        // from the manifest. No trees, no ramps, no runway/helipad,
        // no pickups, no test arena, no Sketchbook dressing.
        // Everything else is preserved as helper methods for later.

        // Ground plane at y=0 — where the blocks sit
        this._buildMinimalGround();

        // Sea plane just below (y = -1.6) — same Sketchbook shader
        this._buildMinimalSea();

        // Real city blocks from manifest + config/city.json
        this._cityReady = this._buildCityAsync();

        this.scene.add(this.root);
    }

    /**
     * Flat ground plane centered on (0,0,0). Size generous enough to
     * cover the whole 500×500 m city plus a buffer for scenery.
     */
    _buildMinimalGround() {
        const size = 700;
        const geo = new THREE.PlaneGeometry(size, size);
        geo.rotateX(-Math.PI / 2);
        const mat = new THREE.MeshStandardMaterial({
            color: 0xd6cebf,                 // warm sand/stone tint
            roughness: 1.0,
            metalness: 0,
        });
        const ground = new THREE.Mesh(geo, mat);
        ground.name = 'Ground';
        ground.receiveShadow = true;
        ground.position.y = 0;
        this.root.add(ground);
        this.ground = ground;
    }

    /**
     * Ocean around the flat plane, sits at y = -1.6 so the ground edge
     * clearly shows above water. Uses the same Ocean shader as before.
     */
    _buildMinimalSea() {
        const seaGeo = new THREE.PlaneGeometry(3000, 3000, 64, 64);
        const sea = new THREE.Mesh(seaGeo);
        sea.rotation.x = -Math.PI / 2;
        sea.position.y = -1.6;
        sea.name = 'Sea';
        this.root.add(sea);
        this.sea = sea;
        this.ocean = new Ocean(sea, {
            sunDirection: new THREE.Vector3(-0.6, 0.7, -0.4).normalize(),
        });
    }

    /**
     * Test arena for the RaycastVehicle physics — rows of ramps at
     * different angles, a launch kicker, a pillar slalom and a gentle
     * hill. Everything has a matching static cannon-es body so the car
     * behaves realistically when driving over / into props.
     *
     * Laid out around (35, 0, -55) — the newly-opened zone behind the
     * fountain, still well inside the mountain rim (r=84-96).
     */
    _buildTestArena() {
        const root = new THREE.Group();
        root.name = 'TestArena';
        // Moved inside the clear zone so all ramps are well inside the map
        const CENTER_X = 30;
        const CENTER_Z = -35;

        // Colored material helpers
        const rampMat = new THREE.MeshStandardMaterial({ color: 0xd28f3f, roughness: 0.85 });
        const hillMat = new THREE.MeshStandardMaterial({ color: 0x6e8f3f, roughness: 1 });
        const pillarMat = new THREE.MeshStandardMaterial({ color: 0xb0a890, roughness: 0.9 });
        const kickerMat = new THREE.MeshStandardMaterial({ color: 0xd04040, roughness: 0.6 });

        /**
         * Build a single rectangular ramp of the given angle (in degrees)
         * at a local position. Returns the visual mesh so the caller can
         * position it — the cannon body is added and rotated to match.
         */
        const addRamp = (localX, localZ, angleDeg, w = 6, len = 10) => {
            const angle = angleDeg * Math.PI / 180;
            const thickness = 0.6;
            const geo = new THREE.BoxGeometry(w, thickness, len);
            const mesh = new THREE.Mesh(geo, rampMat);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            // Lift the mesh so that the TOP EDGE of the low (+Z) end
            // sits exactly at ground (y=0) — otherwise the ramp has a
            // small step the car would bonk into.
            const halfLen = len / 2;
            const halfT   = thickness / 2;
            const posY = halfLen * Math.sin(angle) - halfT * Math.cos(angle);
            mesh.position.set(CENTER_X + localX, posY, CENTER_Z + localZ);
            mesh.rotation.x = angle;
            root.add(mesh);
            if (this._physicsWorld) {
                const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(angle, 0, 0));
                this._physicsWorld.addStaticBox(
                    { x: w / 2, y: halfT, z: halfLen },
                    { x: CENTER_X + localX, y: posY, z: CENTER_Z + localZ },
                    q,
                    { raycastOnly: true },   // wheel ray hits it, chassis passes through
                );
            }
        };

        // Row of 5 ramps: 8°, 14°, 20°, 26°, 35°
        const RAMP_ANGLES = [8, 14, 20, 26, 35];
        RAMP_ANGLES.forEach((deg, i) => {
            addRamp((i - 2) * 8, 0, deg);
        });

        // Launch kicker — short & steep for big air (approach from +Z)
        const kickerLen = 5;
        const kickerAngle = 28 * Math.PI / 180;
        const kickerThickness = 0.6;
        const kickerGeo = new THREE.BoxGeometry(5, kickerThickness, kickerLen);
        const kicker = new THREE.Mesh(kickerGeo, kickerMat);
        const kickerPosY =
            (kickerLen / 2) * Math.sin(kickerAngle)
          - (kickerThickness / 2) * Math.cos(kickerAngle);
        kicker.position.set(CENTER_X - 20, kickerPosY, CENTER_Z);
        kicker.rotation.x = kickerAngle;
        kicker.castShadow = true;
        kicker.receiveShadow = true;
        root.add(kicker);
        if (this._physicsWorld) {
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(kickerAngle, 0, 0));
            this._physicsWorld.addStaticBox(
                { x: 2.5, y: kickerThickness / 2, z: kickerLen / 2 },
                { x: CENTER_X - 20, y: kickerPosY, z: CENTER_Z },
                q,
                { raycastOnly: true },
            );
        }
        // Landing pad shadow decal (visual hint)
        const landing = new THREE.Mesh(
            new THREE.PlaneGeometry(8, 20),
            new THREE.MeshStandardMaterial({
                color: 0xffffff, roughness: 1, transparent: true, opacity: 0.25,
            })
        );
        landing.rotation.x = -Math.PI / 2;
        landing.position.set(CENTER_X - 20, 0.02, CENTER_Z + 26);
        root.add(landing);

        // (slalom pillars removed — they were blocking car access to the ramps)
        // eslint-disable-next-line no-unused-vars
        void pillarMat;

        // Gentle hill mound — driveable in both directions
        // Built from a shallow icosahedron squashed into a dome
        const hillR = 8;
        const hillH = 2.4;
        const hillGeo = new THREE.SphereGeometry(hillR, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
        const hill = new THREE.Mesh(hillGeo, hillMat);
        hill.scale.set(1, hillH / hillR, 1);
        hill.position.set(CENTER_X + 20, 0, CENTER_Z - 8);
        hill.castShadow = true;
        hill.receiveShadow = true;
        root.add(hill);
        // A true smooth hill needs a heightfield or trimesh. For now we
        // approximate by stacking flat cylinders of shrinking radius —
        // the car rolls up them like a staircase of gentle plateaus.
        if (this._physicsWorld) {
            const steps = 5;
            for (let i = 0; i < steps; i++) {
                const t = i / steps;                 // 0..~1
                const r = hillR * Math.sqrt(1 - t * t) * 0.95;   // circular slice radius
                const y = hillH * t;
                // Use 8 thin boxes in a ring to approximate a disk
                const thickness = hillH / steps + 0.1;
                this._physicsWorld.addStaticCylinder(r, thickness, {
                    x: CENTER_X + 20, y: y - thickness / 2 + 0.01, z: CENTER_Z - 8,
                });
            }
        }

        // Mark the arena floor as a concrete pad (purely cosmetic)
        const padGeo = new THREE.PlaneGeometry(70, 50);
        padGeo.rotateX(-Math.PI / 2);
        const pad = new THREE.Mesh(padGeo, new THREE.MeshStandardMaterial({
            color: 0x8c8478, roughness: 0.95, metalness: 0,
        }));
        pad.position.set(CENTER_X + 5, 0.01, CENTER_Z);
        pad.receiveShadow = true;
        root.add(pad);

        // Decorative sign posts at the entry
        const postMat = new THREE.MeshStandardMaterial({ color: 0xffc75a });
        const boardMat = new THREE.MeshStandardMaterial({ color: 0x1b1e27 });
        for (const side of [-1, 1]) {
            const post = new THREE.Mesh(
                new THREE.CylinderGeometry(0.15, 0.15, 3.5, 8),
                postMat
            );
            post.position.set(CENTER_X + side * 15, 1.75, CENTER_Z + 22);
            root.add(post);
            const board = new THREE.Mesh(
                new THREE.BoxGeometry(3, 1.2, 0.1),
                boardMat
            );
            board.position.set(CENTER_X + side * 15, 3.2, CENTER_Z + 22);
            root.add(board);
        }

        this.root.add(root);
        this.testArena = root;
    }

    /**
     * City grid: 4 radial avenues + 2 ring streets + inner blocks +
     * Try the data-driven city first (manifest cityBlocks + city.json).
     * On success, skip the procedural grid — the real blocks have their
     * own roads / sidewalks baked in. On failure (no config, no blocks,
     * loader error) fall back to the procedural grid so the map is never
     * empty.
     */
    async _buildCityAsync() {
        // Asset root = which folder the manifest references
        // ('fbx' or 'glb'). Peek at our scene's global if set, else default.
        const assetRoot = (window._assetRoot) || 'fbx';
        // Attach the city under GameWorld.root so world.hide() / .show()
        // propagates to it automatically.
        const gen = new CityGenerator(this.root, assetRoot);
        try {
            await gen.load();
            const cityBlocks = gen._manifest?.cityBlocks || [];
            const hasConfig  = !!gen._config && Object.keys(gen._config.types || {}).length;
            if (cityBlocks.length > 0 && hasConfig) {
                await gen.build();
                this._cityGenerator = gen;
                console.log('[city] built from manifest — skipping procedural grid');
                return;
            }
            console.log('[city] manifest empty or no config → procedural grid');
        } catch (err) {
            console.warn('[city] generator failed:', err, '→ procedural grid');
        }
        this._buildCityGrid();
    }

    /**
     * Procedural fallback: 4 radial avenues + 2 ring streets + inner
     * blocks + aligned trees + sidewalks.
     */
    _buildCityGrid() {
        const root = new THREE.Group();
        root.name = 'City';

        const asphaltMat = new THREE.MeshStandardMaterial({
            color: 0x3c3d42, roughness: 0.95, metalness: 0.02,
        });
        const sidewalkMat = new THREE.MeshStandardMaterial({
            color: 0x9a948a, roughness: 1,
        });
        const dashMat = new THREE.MeshStandardMaterial({
            color: 0xf0ebd0, emissive: 0x332200, emissiveIntensity: 0.15,
        });

        const ROAD_WIDTH = 6;
        const SIDEWALK_WIDTH = 1.8;
        const MAP_HALF = 58;        // 2 m inside the perimeter wall

        /** Build a straight road segment. Horizontal = true → along X,
         *  false → along Z. Center at (0,0) unless `center` override. */
        const addRoad = (horizontal, center = 0, length = MAP_HALF * 2) => {
            const w = ROAD_WIDTH;
            const swW = SIDEWALK_WIDTH;
            // Asphalt
            const asphaltGeo = new THREE.PlaneGeometry(
                horizontal ? length : w,
                horizontal ? w : length
            );
            asphaltGeo.rotateX(-Math.PI / 2);
            const asphalt = new THREE.Mesh(asphaltGeo, asphaltMat);
            asphalt.position.set(
                horizontal ? 0 : center,
                0.02,
                horizontal ? center : 0,
            );
            asphalt.receiveShadow = true;
            root.add(asphalt);

            // Sidewalks — split into segments around intersections so
            // they don't create that brown crossed pattern in the middle.
            // Each intersection is at the cross-axes 0, ±28.
            const crosses = [0, -28, 28]
                .filter(c => Math.abs(c - center) > 0.01)  // skip self
                .sort((a, b) => a - b);
            // Build break points along the road's length axis
            const halfGap = w / 2 + 0.3;
            const breaks = [-length / 2];
            for (const c of crosses) {
                breaks.push(c - halfGap);
                breaks.push(c + halfGap);
            }
            breaks.push(length / 2);
            // Merge into consecutive [start, end] sidewalk segments
            const segments = [];
            for (let i = 0; i < breaks.length; i += 2) {
                const a = breaks[i];
                const b = breaks[i + 1];
                if (b - a > 0.5) segments.push([a, b]);
            }
            for (const [a, b] of segments) {
                const segLen = b - a;
                const segMid = (a + b) / 2;
                for (const side of [-1, 1]) {
                    const swGeo = new THREE.PlaneGeometry(
                        horizontal ? segLen : swW,
                        horizontal ? swW : segLen,
                    );
                    swGeo.rotateX(-Math.PI / 2);
                    const sw = new THREE.Mesh(swGeo, sidewalkMat);
                    const perp = side * (w / 2 + swW / 2);
                    sw.position.set(
                        horizontal ? segMid : center + perp,
                        0.08,
                        horizontal ? center + perp : segMid,
                    );
                    sw.receiveShadow = true;
                    root.add(sw);
                }
            }

            // Dashed centerline
            const dashCount = Math.floor(length / 4);
            for (let i = 0; i < dashCount; i++) {
                const t = (i / dashCount - 0.5) * length + 1.5;
                const dashGeo = new THREE.BoxGeometry(
                    horizontal ? 1.4 : 0.3,
                    0.04,
                    horizontal ? 0.3 : 1.4
                );
                const dash = new THREE.Mesh(dashGeo, dashMat);
                dash.position.set(
                    horizontal ? t : center,
                    0.12,
                    horizontal ? center : t
                );
                root.add(dash);
            }

            // (trees removed from street alignments — now lives in the park)
        };

        // Main cross: two wide avenues intersecting at origin
        addRoad(true,  0);   // east-west avenue at z=0
        addRoad(false, 0);   // north-south avenue at x=0

        // Two secondary streets parallel to each main axis
        addRoad(true, -28);  // horizontal street at z=-28
        addRoad(true,  28);  // horizontal street at z=+28
        addRoad(false, -28); // vertical street at x=-28
        addRoad(false,  28); // vertical street at x=+28

        // Intersection pads — clean asphalt squares at every crossing,
        // slightly bigger than the road width, to hide UV/z-fighting
        // seams between crossing road planes.
        const INTER_SIZE = ROAD_WIDTH + 0.4;
        const interGeo = new THREE.PlaneGeometry(INTER_SIZE, INTER_SIZE);
        interGeo.rotateX(-Math.PI / 2);
        for (const ix of [0, -28, 28]) {
            for (const iz of [0, -28, 28]) {
                const inter = new THREE.Mesh(interGeo, asphaltMat);
                inter.position.set(ix, 0.03, iz);   // 1cm above asphalt
                inter.receiveShadow = true;
                root.add(inter);
            }
        }

        // City blocks — colored low boxes between streets
        // Each block is approximately 22x22, with a building 12-18m wide
        // centered inside. We place 4 blocks per quadrant — 16 total,
        // minus those that would overlap the arena / runway / helipad.
        const blockCoords = [
            [ 14,  14], [ 14, -14], [-14,  14], [-14, -14],
            [ 42,  14], [ 42, -14], [-42,  14], [-42, -14],
            [ 14,  42], [ 14, -42], [-14,  42], [-14, -42],
            [ 42,  42], [ 42, -42], [-42,  42], [-42, -42],
        ];
        const palette = [0xb79a70, 0x8f756a, 0x8ea7a8, 0xb48d6b, 0x746b88, 0x9a826a];
        for (const [bx, bz] of blockCoords) {
            // Skip if overlaps special zones
            if (Math.hypot(bx - 30, bz + 35) < 20) continue;        // arena
            if (Math.abs(bx + 40) < 12 && Math.abs(bz + 10) < 40) continue; // runway
            if (Math.hypot(bx + 30, bz + 35) < 10) continue;        // helipad
            if (Math.hypot(bx + 42, bz - 42) < 16) continue;        // park at NW
            if (Math.hypot(bx, bz) > 55) continue;                  // outside map
            const w = 10 + Math.random() * 6;
            const d = 10 + Math.random() * 6;
            const h = 4 + Math.random() * 8;
            const color = palette[Math.floor(Math.random() * palette.length)];
            const mat = new THREE.MeshStandardMaterial({
                color, roughness: 0.85, metalness: 0.05,
            });
            const geo = new THREE.BoxGeometry(w, h, d);
            const building = new THREE.Mesh(geo, mat);
            building.position.set(bx, h / 2, bz);
            building.castShadow = true;
            building.receiveShadow = true;
            root.add(building);

            // Physics collider (static box)
            if (this._physicsWorld) {
                this._physicsWorld.addStaticBox(
                    { x: w / 2, y: h / 2, z: d / 2 },
                    { x: bx, y: h / 2, z: bz },
                );
            }
            // Legacy 2D collider — approximate circle around the building
            this.colliders.push({ x: bx, z: bz, radius: Math.max(w, d) * 0.55 });

            // Windows — rows of emissive small squares on two faces
            const winMat = new THREE.MeshStandardMaterial({
                color: 0xffe6a0, emissive: 0xffe6a0, emissiveIntensity: 0.4,
            });
            const rows = Math.floor(h / 1.8);
            const colsX = Math.floor(w / 1.6);
            const colsZ = Math.floor(d / 1.6);
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < colsX; c++) {
                    for (const faceZ of [-d / 2 - 0.01, d / 2 + 0.01]) {
                        const win = new THREE.Mesh(
                            new THREE.PlaneGeometry(0.7, 0.9), winMat
                        );
                        win.position.set(
                            bx + (c - (colsX - 1) / 2) * 1.6,
                            1.2 + r * 1.8,
                            bz + faceZ,
                        );
                        if (faceZ > 0) win.rotation.y = Math.PI;
                        root.add(win);
                    }
                }
                for (let c = 0; c < colsZ; c++) {
                    for (const faceX of [-w / 2 - 0.01, w / 2 + 0.01]) {
                        const win = new THREE.Mesh(
                            new THREE.PlaneGeometry(0.7, 0.9), winMat
                        );
                        win.position.set(
                            bx + faceX,
                            1.2 + r * 1.8,
                            bz + (c - (colsZ - 1) / 2) * 1.6,
                        );
                        win.rotation.y = faceX > 0 ? -Math.PI / 2 : Math.PI / 2;
                        root.add(win);
                    }
                }
            }
        }

        this.root.add(root);
        this.city = root;
    }

    /**
     * Returns true if (x, z) falls on any asphalt road in the city grid.
     * Used so NPCs stay on sidewalks and missions don't drop on streets.
     */
    isOnRoad(x, z) {
        const W = 3;   // road half-width
        // Main cross avenues
        if (Math.abs(z) < W) return true;
        if (Math.abs(x) < W) return true;
        // Secondary streets at x=±28, z=±28
        if (Math.abs(x - 28) < W) return true;
        if (Math.abs(x + 28) < W) return true;
        if (Math.abs(z - 28) < W) return true;
        if (Math.abs(z + 28) < W) return true;
        return false;
    }

    /**
     * Dedicated park zone: grass plane + clustered trees + a pond + benches.
     * Positioned in a free city block so it doesn't overlap streets.
     */
    _buildPark() {
        const root = new THREE.Group();
        root.name = 'Park';
        const CX = -42, CZ = 42;       // NW corner of the map, empty block
        const SIZE = 24;                // park is 24x24 m

        // Grass plane
        const grassMat = new THREE.MeshStandardMaterial({
            color: 0x4d7a35, roughness: 1,
        });
        const grass = new THREE.Mesh(
            new THREE.PlaneGeometry(SIZE, SIZE),
            grassMat,
        );
        grass.rotation.x = -Math.PI / 2;
        grass.position.set(CX, 0.03, CZ);
        grass.receiveShadow = true;
        root.add(grass);

        // Clustered trees — poisson-ish distribution with minimum spacing
        const spots = [];
        const TRY = 80;
        for (let i = 0; i < TRY; i++) {
            const lx = (Math.random() - 0.5) * (SIZE - 3);
            const lz = (Math.random() - 0.5) * (SIZE - 3);
            // Keep a clear central glade around the pond
            if (Math.hypot(lx, lz - 2) < 3.2) continue;
            // Min spacing 2.4 m between trees
            let ok = true;
            for (const s of spots) {
                if (Math.hypot(lx - s[0], lz - s[1]) < 2.4) { ok = false; break; }
            }
            if (!ok) continue;
            spots.push([lx, lz]);
            if (spots.length >= 26) break;
        }
        for (const [lx, lz] of spots) {
            this._addTree(CX + lx, CZ + lz, 0.9 + Math.random() * 0.6);
        }

        // Small pond
        const pondMat = new THREE.MeshStandardMaterial({
            color: 0x3f6a9c, roughness: 0.2, metalness: 0.1,
            transparent: true, opacity: 0.85,
        });
        const pond = new THREE.Mesh(
            new THREE.CircleGeometry(2.4, 24),
            pondMat,
        );
        pond.rotation.x = -Math.PI / 2;
        pond.position.set(CX, 0.07, CZ + 2);
        root.add(pond);

        // A couple of stone benches at the pond's edge
        const benchMat = new THREE.MeshStandardMaterial({ color: 0x8a847a });
        for (const [bx, bz, ry] of [[CX - 3.5, CZ + 2, 0], [CX + 3.5, CZ + 2, 0]]) {
            const bench = new THREE.Mesh(
                new THREE.BoxGeometry(1.6, 0.35, 0.5),
                benchMat,
            );
            bench.position.set(bx, 0.25, bz);
            bench.rotation.y = ry;
            bench.castShadow = true;
            root.add(bench);
            this.colliders.push({ x: bx, z: bz, radius: 0.8 });
            if (this._physicsWorld) {
                this._physicsWorld.addStaticBox(
                    { x: 0.8, y: 0.25, z: 0.3 },
                    { x: bx, y: 0.25, z: bz },
                );
            }
        }

        // A welcome sign at the park entrance
        const signPost = new THREE.Mesh(
            new THREE.CylinderGeometry(0.12, 0.12, 2.2, 8),
            new THREE.MeshStandardMaterial({ color: 0x5a4a3a }),
        );
        signPost.position.set(CX + SIZE / 2 - 0.5, 1.1, CZ - SIZE / 2 + 0.5);
        root.add(signPost);
        const board = new THREE.Mesh(
            new THREE.BoxGeometry(2.4, 0.9, 0.08),
            new THREE.MeshStandardMaterial({ color: 0x4d7a35, emissive: 0x224a15, emissiveIntensity: 0.2 }),
        );
        board.position.set(CX + SIZE / 2 - 1.5, 2, CZ - SIZE / 2 + 0.5);
        root.add(board);

        this.root.add(root);
        this.park = root;
    }

    /**
     * Vertical neon beams + labels above the plane & helicopter spawn
     * points so the player can spot them from anywhere on the map.
     */
    _buildWaypointBeacons() {
        const spots = [
            { x: -40, z: 21,  color: 0x4aaaff, label: 'AIRPLANE' },
            { x: -30, z: -35, color: 0xff7a4a, label: 'HELIPAD' },
            { x: 30,  z: -35, color: 0xffc75a, label: 'ARENA' },
            { x: -42, z: 42,  color: 0x6aff8e, label: 'PARK' },
        ];
        for (const s of spots) {
            // Tall translucent beam
            const beam = new THREE.Mesh(
                new THREE.CylinderGeometry(0.45, 0.45, 30, 12, 1, true),
                new THREE.MeshBasicMaterial({
                    color: s.color,
                    transparent: true,
                    opacity: 0.42,
                    side: THREE.DoubleSide,
                    depthWrite: false,
                }),
            );
            beam.position.set(s.x, 15, s.z);
            beam.renderOrder = 5;
            this.root.add(beam);

            // Glowing cap
            const cap = new THREE.Mesh(
                new THREE.SphereGeometry(0.8, 12, 8),
                new THREE.MeshBasicMaterial({ color: s.color }),
            );
            cap.position.set(s.x, 30, s.z);
            cap.renderOrder = 5;
            this.root.add(cap);
        }
    }

    /** Low stone wall around the perimeter to delimit the map cleanly. */
    _buildPerimeterWall() {
        const wallMat = new THREE.MeshStandardMaterial({
            color: 0x7a7266, roughness: 0.95,
        });
        const R = 60;
        const segments = 64;
        const HALF_W = 0.4;
        const H = 1.6;
        const arcLen = (Math.PI * 2 * R) / segments + 0.6;
        for (let i = 0; i < segments; i++) {
            const a0 = (i / segments) * Math.PI * 2;
            // Skip the beach sector (keep it open to the sea)
            if (this.isInBeachSector(Math.cos(a0) * R, Math.sin(a0) * R)) continue;
            const x = Math.cos(a0) * R;
            const z = Math.sin(a0) * R;
            const seg = new THREE.Mesh(
                new THREE.BoxGeometry(arcLen, H, HALF_W * 2),
                wallMat,
            );
            seg.position.set(x, H / 2, z);
            // Tangent direction (for wall orientation)
            seg.rotation.y = -a0 + Math.PI / 2;
            seg.castShadow = true;
            seg.receiveShadow = true;
            this.root.add(seg);
            // Legacy 2D collider
            this.colliders.push({ x, z, radius: HALF_W + 0.2 });
            // Physics static box
            if (this._physicsWorld) {
                const q = new THREE.Quaternion()
                    .setFromEuler(new THREE.Euler(0, -a0 + Math.PI / 2, 0));
                this._physicsWorld.addStaticBox(
                    { x: arcLen / 2, y: H / 2, z: HALF_W },
                    { x, y: H / 2, z },
                    q,
                );
            }
        }
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
        // Trees live in the outer ring only (between driveable area and
        // the mountain rim). Inner 60m radius stays completely clear.
        const count = 120;
        const R_MIN = 60;
        const R_MAX = 78;
        for (let i = 0; i < count; i++) {
            const ang = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.08;
            const r = R_MIN + Math.random() * (R_MAX - R_MIN);
            const x = Math.cos(ang) * r;
            const z = Math.sin(ang) * r;
            if (this.isOnTrack(x, z)) continue;
            if (this.isInBeachSector(x, z)) continue;     // leave beach clear
            // Skip trees that would land inside the test arena (30, -35)
            if (Math.hypot(x - 30, z + 35) < 28) continue;
            // Skip trees on the runway strip at (-40, -10), length 70, width 8
            if (Math.abs(x + 40) < 12 && Math.abs(z + 10) < 45) continue;
            // Skip trees on the helipad zone (-30, -35) radius 10
            if (Math.hypot(x + 30, z + 35) < 10) continue;
            const scale = 1 + Math.random() * 0.9;
            this._addTree(x, z, scale);
        }
    }

    /**
     * Big circular sea plane + simple wave shader. The island (= the
     * flat sand plane at y=0) sits on top of it as an elevated terrace.
     */
    _buildSea() {
        // Sketchbook's Ocean shader — direct port from codepen/knoland.
        // Uses a ShaderMaterial on a large plane with animated waves,
        // sun highlights and fake reflections computed in the fragment
        // stage. No normal map dependency.
        const seaGeo = new THREE.PlaneGeometry(2000, 2000, 64, 64);
        const sea = new THREE.Mesh(seaGeo);
        sea.rotation.x = -Math.PI / 2;
        sea.position.y = -1.6;
        sea.name = 'Sea';
        this.root.add(sea);
        this.sea = sea;
        this.ocean = new Ocean(sea, {
            sunDirection: new THREE.Vector3(-0.6, 0.7, -0.4).normalize(),
        });

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
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i);
            const z = pos.getZ(i);
            const r = Math.hypot(x, z);
            // Cut the plane off past the visual radius
            if (r > visualR + 0.5) { pos.setY(i, -1.8); continue; }
            // City is FLAT (y=0) — the only deformation is the smooth
            // beach slope from SLOPE_START down to sea level at visualR.
            const SLOPE_START = islandR - 4;
            const SHORE_Y = -1.6;
            if (r > SLOPE_START) {
                const t = Math.min(1, (r - SLOPE_START) / (visualR - SLOPE_START));
                const s = t * t * (3 - 2 * t);   // smoothstep
                pos.setY(i, SHORE_Y * s);
            } else {
                pos.setY(i, 0);                  // city flat
            }
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
        const COUNT = 48;
        for (let i = 0; i < COUNT; i++) {
            const ang = (i / COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
            const r = 84 + Math.random() * 12;
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
        // Skip any JSON-placed tree that lands on a road, runway,
        // helipad, fountain, or inside the test arena.
        const reject = (x, z) => {
            if (this.isOnTrack(x, z)) return true;
            if (Math.hypot(x, z) < 6) return true;                 // fountain / center
            if (Math.abs(x + 40) < 12 && Math.abs(z + 10) < 45) return true;  // runway
            if (Math.hypot(x + 30, z + 35) < 10) return true;      // helipad
            if (Math.hypot(x - 30, z + 35) < 28) return true;      // test arena
            if (this.isInBeachSector(x, z)) return true;
            return false;
        };
        Promise.allSettled(
            files.map(url => spawnTreeInstancesFromJSON(url, this.root, {
                colliderRadius: 0.25,
                reject,
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
            // Re-mirror any new colliders that came from the JSON trees
            if (this._physicsWorld) this.mirrorCollidersToPhysics();
        });
    }

    _buildRunway() {
        // Long rectangle running N→S on the west side of the island.
        // Kept fully inside the mountain rim (r < 80) for easy access.
        const length = 70;
        const width  = 8;
        const cx = -40, cz = -10;
        const rot = 0;              // axis-aligned along Z

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
        const dashes = 22;
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
        // Moved NW (per user request) — far from the arena so the two
        // aerial spawn points are on opposite sides of the city.
        const cx = -30, cz = -35;

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
        // Spawn on a sidewalk (5 m off the nearest street axis) — never
        // on asphalt so cars don't pick them up accidentally.
        let x, z;
        for (let tries = 0; tries < 20; tries++) {
            const axes = [0, 28, -28];
            const axisIsX = Math.random() < 0.5;
            const axisV = axes[Math.floor(Math.random() * axes.length)];
            const side = Math.random() < 0.5 ? -1 : 1;
            const offset = axisV + side * 5;
            const along = (Math.random() - 0.5) * 50;
            x = axisIsX ? offset : along;
            z = axisIsX ? along  : offset;
            if (Math.hypot(x, z) < 50 && !this.isOnRoad?.(x, z)) break;
        }
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

    update(dt, playerPos, camera) {
        const t = performance.now();

        // Sketchbook ocean — drives the shader time + camera pos
        if (this.ocean && camera) this.ocean.update(dt, camera);

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
