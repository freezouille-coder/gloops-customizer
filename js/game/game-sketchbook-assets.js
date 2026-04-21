import * as THREE from 'three';
import { makeGLTFLoader } from '../gltf-loader.js';

/**
 * One-shot loader for Sketchbook's world.glb. Parses the scene, finds
 * the materials / textures we care about (ground / road / water), and
 * exposes them so our GameWorld can reuse them on top of its own mesh
 * layout.
 *
 * We do NOT place world.glb in the scene — we only harvest its textures.
 * The GLB is ~26 MB so this runs once and caches the result.
 */

const WORLD_URL = 'assets/sketchbook/world.glb';
const loader = makeGLTFLoader();

let _cache = null;

/**
 * Returns a promise resolving to:
 *   {
 *     ground: { map, normalMap, roughnessMap, color, repeat } | null,
 *     road:   { map, normalMap, roughnessMap, color, repeat } | null,
 *     water:  { map, normalMap, color } | null,
 *     all:    Map<string, THREE.Material>   // name → material (debug)
 *   }
 */
export function loadSketchbookAssets() {
    if (_cache) return _cache;
    _cache = new Promise((resolve, reject) => {
        loader.load(WORLD_URL, (gltf) => {
            const result = {
                ground: null,
                road: null,
                water: null,
                sand: null,
                all: new Map(),
                lights: [],
                waterMaterial: null,
            };

            // Collect any lights defined in the GLB via KHR_lights_punctual
            gltf.scene.traverse((obj) => {
                if (obj.isLight) {
                    result.lights.push(obj);
                }
            });

            // Collect every unique material found in the scene, indexed by name.
            gltf.scene.traverse((obj) => {
                if (!obj.isMesh) return;
                const m = obj.material;
                if (!m) return;
                const mats = Array.isArray(m) ? m : [m];
                for (const mat of mats) {
                    if (mat.name) result.all.set(mat.name, mat);
                }
            });

            // Pick candidates by name (case-insensitive)
            const names = [...result.all.keys()];
            const lower = names.map(n => n.toLowerCase());

            function firstMatch(keywords) {
                for (let i = 0; i < lower.length; i++) {
                    for (const k of keywords) {
                        if (lower[i].includes(k)) return result.all.get(names[i]);
                    }
                }
                return null;
            }

            // Be specific: "dirt_road" contains BOTH "dirt" and "road",
            // so we pick ground=dirt first, then road=race_track/runway.
            const groundMat = firstMatch(['grass', 'dirt_road', 'terrain']);
            const roadMat   = firstMatch(['race_track', 'tarmac', 'asphalt', 'runway', 'helipad']);
            const waterMat  = firstMatch(['ocean', 'water', 'sea', 'lake']);
            const sandMat   = firstMatch(['sand', 'beach', 'shore']);

            const extract = (mat) => {
                if (!mat) return null;
                return {
                    map: mat.map || null,
                    normalMap: mat.normalMap || null,
                    roughnessMap: mat.roughnessMap || null,
                    color: mat.color ? mat.color.clone() : null,
                };
            };
            result.ground = extract(groundMat);
            result.road = extract(roadMat);
            result.water = extract(waterMat);
            result.sand = extract(sandMat);
            // Keep a ref to the raw water material too (so we can apply
            // its map + normalMap directly to our mesh)
            result.waterMaterial = waterMat || null;

            console.log('[Sketchbook] loaded world materials:', names);
            console.log('[Sketchbook] ground:', groundMat?.name, 'road:', roadMat?.name,
                        'water:', waterMat?.name, 'sand:', sandMat?.name);

            resolve(result);
        }, undefined, (err) => {
            console.warn('[Sketchbook] world.glb load failed — using fallback', err);
            resolve({ ground: null, road: null, water: null, sand: null, all: new Map() });
        });
    });
    return _cache;
}
