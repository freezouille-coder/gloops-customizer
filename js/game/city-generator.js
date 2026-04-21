import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { makeGLTFLoader } from '../gltf-loader.js';

/**
 * CityGenerator — loads real modeled blocks from the manifest
 * (section `cityBlocks`) and instantiates them on a grid driven by
 * `config/city.json`. Same greedy placement algorithm as the HTML
 * preview in scripts/gloops-city.html, so the in-game output matches
 * what the user tuned there.
 *
 * Grid semantics:
 *   - 1 cell = 25 m
 *   - Block pivot = south-west corner (0,0) → position = (cellX*25, 0, cellZ*25)
 *   - Block of dimensions WxH covers cells [cellX..cellX+W-1, cellZ..cellZ+H-1]
 *
 * The class is async-aware — call `await cg.build()` once; it fetches
 * the configs, loads every needed FBX/GLB ONCE (cached per file) and
 * clones instances for repeated variants to keep memory sane.
 */
export class CityGenerator {
    /**
     * @param {THREE.Object3D} parent    a scene or group to attach the city to
     * @param {string}         assetRoot 'fbx' or 'glb' — resolved by the caller
     */
    constructor(parent, assetRoot = 'fbx') {
        this.parent      = parent;
        this.assetRoot   = assetRoot;
        this.root        = new THREE.Group();
        this.root.name   = 'CityGenerator';
        this.parent.add(this.root);

        // Size of one grid cell, metres. Must match the HTML preview.
        this.CELL = 25;

        this._manifest = null;
        this._config   = null;
        this._cache    = new Map();    // file path -> loaded root Object3D (original)
        this._fbxLoader  = new FBXLoader();
        this._gltfLoader = makeGLTFLoader();
    }

    // ---------- Config / manifest loading ----------

    async load() {
        const manifestPath = `${this.assetRoot}/manifest.json`;
        const cfgPath = 'config/city.json';
        const [mRes, cRes] = await Promise.all([
            fetch(manifestPath).then((r) => r.ok ? r.json() : null).catch(() => null),
            fetch(cfgPath,    { cache: 'no-cache' })
                .then((r) => r.ok ? r.json() : null).catch(() => null),
        ]);
        if (!mRes) throw new Error(`[city] can't fetch ${manifestPath}`);
        this._manifest = mRes;
        this._config   = cRes || CityGenerator._fallbackConfig();
        const blocks = mRes.cityBlocks || [];
        if (!blocks.length) {
            console.warn('[city] manifest has no cityBlocks — re-run build_manifest.py');
        }
        console.log(`[city] loaded ${blocks.length} block(s), config preset=${this._config.preset}`);
        return this;
    }

    static _fallbackConfig() {
        return {
            grid:  { width: 20, height: 20 },
            avenue: false,
            preset: 'random',
            types:  { S: 8, M: 25, L: 10, XL: 5, '1x2': 6, '2x3': 12, '2x4': 8 },
            files:  {},
        };
    }

    /** Group available cityBlocks by type (e.g. "2x2"). Empty types are
     *  silently dropped so the algo never considers sizes with no assets. */
    _blocksByType() {
        const byType = new Map();
        for (const b of (this._manifest?.cityBlocks || [])) {
            const t = `${b.w}x${b.h}`;
            if (!byType.has(t)) byType.set(t, []);
            // Per-file override from city.json wins over the filename's weight
            const override = this._config?.files?.[b.file];
            const weight = (override !== undefined && override !== null)
                ? +override : (b.weight ?? 10);
            byType.get(t).push({ ...b, weight });
        }
        return byType;
    }

    /** Map footprint "WxH" → canonical type code used in city.json.types.
     *  1x1 → S, 2x2 → M, 3x3 → L, 4x4 → XL, asymmetric → literal "WxH". */
    _typeCodeOf(w, h) {
        if (w === h) {
            return { 1: 'S', 2: 'M', 3: 'L', 4: 'XL' }[w] || `${w}x${h}`;
        }
        // Use the smaller-first convention so 1x2 and 2x1 share the same slot.
        const a = Math.min(w, h), b = Math.max(w, h);
        return `${a}x${b}`;
    }

    // ---------- Greedy placement ----------

    /** Mulberry32 seeded RNG — deterministic layouts for a given seed. */
    static _rng(seed) {
        let t = seed | 0;
        return () => {
            t = (t + 0x6D2B79F5) | 0;
            let r = Math.imul(t ^ (t >>> 15), 1 | t);
            r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
            return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
        };
    }

    /** Pick a random 90°-step Y rotation that is COMPATIBLE with the
     *  variant's raw footprint and the cell's placed footprint.
     *
     *   - square raw (w == h)                → {0, 90, 180, 270}
     *   - rect, placed same as raw (no swap) → {0, 180}
     *   - rect, placed swapped               → {90, 270}
     *
     *  Returned angle is in radians (THREE convention, +Y up, right-hand).
     */
    static _pickRotation(variant, picked, rand) {
        const rw = variant?.w;
        const rh = variant?.h;
        if (!rw || !rh) return 0;
        const PI_2 = Math.PI / 2;
        let set;
        if (rw === rh) {
            set = [0, PI_2, Math.PI, -PI_2];
        } else if (picked.w === rw && picked.h === rh) {
            set = [0, Math.PI];
        } else {
            set = [PI_2, -PI_2];
        }
        return set[Math.floor(rand() * set.length) % set.length];
    }

    /** Compute a local-space axis-aligned bbox of `root`, counting only
     *  `isMesh` descendants (so empties/helpers/bones never extend it).
     *  Returned box is in `root`-local coordinates, matching what the
     *  legacy `setFromObject(src)` returned when the caller used
     *  `src.position -= bbox.min` for pivot normalisation. */
    static _meshBBox(root, out = null) {
        const box = out || new THREE.Box3();
        box.makeEmpty();
        root.updateMatrixWorld(true);
        const tmp = new THREE.Box3();
        root.traverse((c) => {
            if (!c.isMesh || !c.geometry) return;
            if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
            if (!c.geometry.boundingBox) return;
            tmp.copy(c.geometry.boundingBox).applyMatrix4(c.matrixWorld);
            box.union(tmp);
        });
        const rootMatInv = root.matrixWorld.clone().invert();
        box.applyMatrix4(rootMatInv);
        return box;
    }

    /** Same as `_meshBBox` but keeps the box in world space — useful to
     *  verify "all blocks rest on Y=0" after the pivot normalisation. */
    static _meshBBoxWorld(root) {
        const box = new THREE.Box3();
        box.makeEmpty();
        root.updateMatrixWorld(true);
        const tmp = new THREE.Box3();
        root.traverse((c) => {
            if (!c.isMesh || !c.geometry) return;
            if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
            if (!c.geometry.boundingBox) return;
            tmp.copy(c.geometry.boundingBox).applyMatrix4(c.matrixWorld);
            box.union(tmp);
        });
        return box;
    }

    static _weightedPick(options, rand) {
        const total = options.reduce((s, o) => s + o.weight, 0);
        if (total <= 0) return null;
        let r = rand() * total;
        for (const o of options) {
            r -= o.weight;
            if (r <= 0) return o;
        }
        return options[options.length - 1];
    }

    /**
     * Run the greedy algorithm and return the placement list. No scene
     * interaction — purely data, so this is cheap to call and fast to
     * preview / re-seed.
     */
    plan(seed = Date.now()) {
        const cfg = this._config;
        const GW  = cfg.grid.width;
        const GH  = cfg.grid.height;
        const avenueOn = !!cfg.avenue;
        const typeWeights = cfg.types || {};
        const byType = this._blocksByType();

        // Candidate types = those that are (a) enabled in config (non-null,
        // > 0) AND (b) have at least one block file available.
        const candidateTypes = [];
        for (const [typeCode, weight] of Object.entries(typeWeights)) {
            if (weight === null || weight === undefined || weight <= 0) continue;
            // Map type code back to w,h (S=1x1, M=2x2, L=3x3, XL=4x4, "2x3"=2x3 etc.)
            const dims = this._dimsForType(typeCode);
            if (!dims) continue;
            // Check that at least one file exists for this dimension (OR its transpose)
            const key1 = `${dims.w}x${dims.h}`;
            const key2 = `${dims.h}x${dims.w}`;
            if (!byType.has(key1) && !byType.has(key2)) continue;
            candidateTypes.push({
                type: typeCode,
                w: dims.w, h: dims.h,
                weight,
            });
        }
        // Sort largest footprint first — packing efficiency for same type weight.
        candidateTypes.sort((a, b) => (b.w * b.h) - (a.w * a.h));

        // S-fallback allowed only if user actually has a 1x1 block AND
        // the type is enabled. Otherwise orphan cells stay as empty road.
        const allowSFallback = candidateTypes.some((c) => c.w === 1 && c.h === 1)
                            && byType.has('1x1');

        // Initialize grid
        const grid = Array.from({ length: GH }, () => Array(GW).fill(false));
        if (avenueOn) {
            const midX = Math.floor(GW / 2);
            const midY = Math.floor(GH / 2);
            for (let y = 0; y < GH; y++) grid[y][midX] = true;
            for (let x = 0; x < GW; x++) grid[midY][x] = true;
        }

        // Row-major iteration for tight packing — same logic as HTML preview.
        const cells = [];
        for (let y = 0; y < GH; y++)
            for (let x = 0; x < GW; x++)
                if (!grid[y][x]) cells.push({ x, y });

        const placements = [];
        const rand = CityGenerator._rng(seed);

        for (const { x, y } of cells) {
            if (grid[y][x]) continue;
            const opts = [];
            for (const c of candidateTypes) {
                const orientations = (c.w === c.h)
                    ? [[c.w, c.h]]
                    : [[c.w, c.h], [c.h, c.w]];
                for (const [w, h] of orientations) {
                    if (this._fits(grid, x, y, w, h, GW, GH)) {
                        opts.push({ type: c.type, w, h, weight: c.weight });
                    }
                }
            }
            const picked = CityGenerator._weightedPick(opts, rand);
            if (picked) {
                this._markOccupied(grid, x, y, picked.w, picked.h);
                // Choose a specific file (variant) for this pick.
                const pool = (byType.get(`${picked.w}x${picked.h}`) || [])
                    .concat(picked.w !== picked.h ? (byType.get(`${picked.h}x${picked.w}`) || []) : []);
                const variant = CityGenerator._weightedPick(pool, rand);
                placements.push({
                    cellX: x, cellZ: y,
                    w: picked.w, h: picked.h,
                    type: picked.type,
                    file: variant?.file || null,
                    variant: variant?.variant || null,
                    rotY: CityGenerator._pickRotation(variant, picked, rand),
                });
            } else if (allowSFallback && this._fits(grid, x, y, 1, 1, GW, GH)) {
                this._markOccupied(grid, x, y, 1, 1);
                const pool = byType.get('1x1') || [];
                const variant = CityGenerator._weightedPick(pool, rand);
                placements.push({
                    cellX: x, cellZ: y, w: 1, h: 1,
                    type: 'S',
                    file: variant?.file || null,
                    variant: variant?.variant || null,
                    rotY: CityGenerator._pickRotation(
                        variant, { w: 1, h: 1 }, rand),
                });
            } else {
                // No fit + no S fallback → leave empty (road visible).
                grid[y][x] = true;
            }
        }
        return placements;
    }

    /** Map type code → { w, h }. Supports S/M/L/XL and literal "WxH". */
    _dimsForType(code) {
        if (code === 'S')  return { w: 1, h: 1 };
        if (code === 'M')  return { w: 2, h: 2 };
        if (code === 'L')  return { w: 3, h: 3 };
        if (code === 'XL') return { w: 4, h: 4 };
        const m = /^(\d+)x(\d+)$/.exec(code);
        return m ? { w: +m[1], h: +m[2] } : null;
    }

    _fits(grid, x, y, w, h, GW, GH) {
        if (x + w > GW || y + h > GH) return false;
        for (let j = 0; j < h; j++)
            for (let i = 0; i < w; i++)
                if (grid[y + j][x + i]) return false;
        return true;
    }
    _markOccupied(grid, x, y, w, h) {
        for (let j = 0; j < h; j++)
            for (let i = 0; i < w; i++) grid[y + j][x + i] = true;
    }

    // ---------- Scene instantiation ----------

    /** Load the source file for a block (cached) and return a clone
     *  ready to position. FBX / GLB is picked based on extension.
     *
     *  Pivot normalisation: wraps the loaded model in a Group and
     *  shifts it so the bounding box's south-west-bottom corner lands
     *  at the wrapper's origin. Means the user can model with ANY
     *  pivot location (centered, corner, random) — we auto-correct. */
    async _cloneBlock(file) {
        let wrapper = this._cache.get(file);
        if (!wrapper) {
            const url = `${this.assetRoot}/${file}`;
            const ext = file.toLowerCase().split('.').pop();
            let src;
            try {
                if (ext === 'glb' || ext === 'gltf') {
                    const gltf = await new Promise((resolve, reject) =>
                        this._gltfLoader.load(url, resolve, null, reject));
                    src = gltf.scene;
                } else {
                    src = await new Promise((resolve, reject) =>
                        this._fbxLoader.load(url, resolve, null, reject));
                }
            } catch (err) {
                console.error(`[city] load failed ${url}:`, err);
                throw err;
            }

            // Force cast + receive shadow on every mesh
            src.traverse((c) => {
                if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; }
            });

            // FBX often comes in at cm scale (100× too big). Detect
            // and scale down if the bbox is wildly larger than expected.
            //
            // Use a VISIBLE-MESH-ONLY bbox for both scale detection and
            // pivot normalisation — a helper node (locator, empty, IK
            // target) floating above/below the model would otherwise
            // push the bbox and misalign Y across blocks.
            const raw = this._rawDims(file);
            const expected = raw ? Math.max(raw.w, raw.h) * this.CELL : this.CELL;
            const meshBBox = CityGenerator._meshBBox(src);
            const size = new THREE.Vector3(); meshBBox.getSize(size);
            const maxDim = Math.max(size.x, size.z);
            if (maxDim > expected * 10) {
                const factor = expected / maxDim;
                src.scale.setScalar(factor);
                src.updateMatrixWorld(true);
                CityGenerator._meshBBox(src, meshBBox);
                console.log(`[city] ${file} auto-scaled ×${factor.toFixed(4)} (was ${maxDim.toFixed(1)}m, target ~${expected}m)`);
            }

            // Pivot normalisation: shift so SW-bottom corner of the
            // visible mesh lands at (0, 0, 0).
            src.position.x -= meshBBox.min.x;
            src.position.y -= meshBBox.min.y;
            src.position.z -= meshBBox.min.z;

            // Wrap once so the cached "origin" is always the SW corner
            wrapper = new THREE.Group();
            wrapper.name = `cityBlock:${file}`;
            wrapper.add(src);

            // Log final WORLD-space bbox — we want bottom = 0 on every block.
            wrapper.updateMatrixWorld(true);
            const worldBBox = CityGenerator._meshBBoxWorld(wrapper);
            const w = worldBBox.max.x - worldBBox.min.x;
            const h = worldBBox.max.z - worldBBox.min.z;
            const verticalH = worldBBox.max.y - worldBBox.min.y;
            console.log(`[city] ${file} loaded — bbox ${w.toFixed(1)}×${h.toFixed(1)}×${verticalH.toFixed(1)}m, worldMinY=${worldBBox.min.y.toFixed(3)}`);

            this._cache.set(file, wrapper);
        }
        return wrapper.clone(true);
    }

    /** Instantiate each placement in the scene. Clones are positioned
     *  so that the block's south-west corner (its pivot by convention)
     *  lands on (cellX*CELL, 0, cellZ*CELL) in world space. */
    async instantiate(placements) {
        // Center the city around the origin so gameplay logic (spawn,
        // camera, etc.) stays symmetric. World offset = -(grid_w/2)*CELL.
        const GW = this._config.grid.width;
        const GH = this._config.grid.height;
        const offX = -(GW / 2) * this.CELL;
        const offZ = -(GH / 2) * this.CELL;

        let placed = 0, skipped = 0;
        for (const p of placements) {
            if (!p.file) { skipped++; continue; }
            let mesh;
            try { mesh = await this._cloneBlock(p.file); }
            catch (err) {
                console.warn(`[city] failed to load ${p.file}:`, err);
                skipped++;
                continue;
            }
            mesh.position.set(
                offX + p.cellX * this.CELL,
                0,
                offZ + p.cellZ * this.CELL,
            );
            // Apply the 90°-step Y rotation decided in plan(). The block
            // is modelled with its SW corner at (0,0,0) and extends into
            // (+X, +Z). After rotating around that corner it leaks into
            // negative X/Z; compensate by shifting so the final footprint
            // stays aligned on the SW corner.
            const raw = this._rawDims(p.file);
            const rw = raw?.w ?? p.w;
            const rh = raw?.h ?? p.h;
            const CELL = this.CELL;
            const rotY = p.rotY || 0;
            mesh.rotation.y = rotY;
            const PI_2 = Math.PI / 2;
            const EPS = 1e-4;
            if (Math.abs(rotY - PI_2) < EPS) {
                mesh.position.z += rw * CELL;
            } else if (Math.abs(rotY - Math.PI) < EPS) {
                mesh.position.x += rw * CELL;
                mesh.position.z += rh * CELL;
            } else if (Math.abs(rotY + PI_2) < EPS) {
                mesh.position.x += rh * CELL;
            }
            mesh.userData.cityBlock = { ...p };
            this.root.add(mesh);
            placed++;
        }
        console.log(`[city] instantiated ${placed} block(s), ${skipped} skipped`);
    }

    /** Read the raw dimensions embedded in the filename. Used to detect
     *  when we need to rotate an asymmetric block 90° to fit a slot. */
    _rawDims(file) {
        const m = /block_(\d+)x(\d+)_/i.exec(file);
        return m ? { w: +m[1], h: +m[2] } : null;
    }

    // ---------- Public entry point ----------

    /**
     * One-shot: load configs, plan placements, load + instance every
     * block. Resolves once the city is fully visible in the scene.
     * @param {number} [seed] — pass the same seed for the same layout.
     */
    async build(seed) {
        await this.load();
        const placements = this.plan(seed);
        // Summarise what the algo decided to place BEFORE we try to
        // load/instantiate — helpful when debugging an empty map.
        const counts = placements.reduce((a, p) => (a[p.type] = (a[p.type]||0)+1, a), {});
        console.log(`[city] planned ${placements.length} block(s):`, counts);
        if (placements.length === 0) {
            console.warn('[city] 0 placements. Check config/city.json `types` and manifest `cityBlocks`.');
        }
        await this.instantiate(placements);
        return placements;
    }

    /** Remove everything from the scene (for hot-reloads / seed changes) */
    clear() {
        while (this.root.children.length) {
            this.root.remove(this.root.children[0]);
        }
    }
}
