import * as THREE from 'three';

/**
 * Loads a JSON file describing tree (or any prop) positions and spawns
 * them as a single InstancedMesh — one draw call for N instances.
 *
 * Expected JSON format (produced by scripts/export_trees.py):
 *   {
 *     "prefab": "pine",
 *     "count":  32,
 *     "items": [ { "x", "y", "z", "ry", "s" }, ... ]
 *   }
 *
 * A "prefab" is a small factory function that returns { geometries: [], materials: [] }.
 * For multi-part props (trunk + foliage), we create ONE InstancedMesh
 * per (geometry, material) pair, all sharing the same per-instance matrix.
 */

/**
 * Built-in prefab factories. Add more by calling `registerPrefab(name, factory)`.
 * Each factory returns an array of { geometry, material } parts.
 */
const _prefabs = new Map();

export function registerPrefab(name, factory) {
    _prefabs.set(name, factory);
}

export function getPrefab(name) {
    return _prefabs.get(name);
}

// --- Default built-in prefabs ---

registerPrefab('pine', () => {
    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 1.6, 8);
    trunkGeo.translate(0, 0.8, 0);   // origin at the base
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 });

    const leafGeoA = new THREE.ConeGeometry(1.3, 1.4, 8);
    leafGeoA.translate(0, 2.0, 0);
    const leafGeoB = new THREE.ConeGeometry(1.05, 1.4, 8);
    leafGeoB.translate(0, 2.75, 0);
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x4a8a3a, roughness: 0.9 });

    return [
        { geometry: trunkGeo, material: trunkMat },
        { geometry: leafGeoA, material: leafMat },
        { geometry: leafGeoB, material: leafMat },
    ];
});

registerPrefab('oak', () => {
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.35, 1.4, 8);
    trunkGeo.translate(0, 0.7, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1a, roughness: 1 });

    const leafGeo = new THREE.IcosahedronGeometry(1.2, 1);
    leafGeo.translate(0, 2.2, 0);
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x5ea848, roughness: 0.88 });

    return [
        { geometry: trunkGeo, material: trunkMat },
        { geometry: leafGeo, material: leafMat },
    ];
});

registerPrefab('rock', () => {
    const geo = new THREE.DodecahedronGeometry(0.6, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a7a60, roughness: 0.95 });
    return [{ geometry: geo, material: mat }];
});

/**
 * Load a JSON file and spawn instanced meshes.
 * Returns the THREE.Group holding all the instanced meshes + an
 * `obstacles` array (one per instance item) suitable for the existing
 * world.colliders system.
 */
export async function spawnTreeInstancesFromJSON(url, scene, opts = {}) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to load ' + url);
    const data = await response.json();
    return spawnTreeInstances(data, scene, opts);
}

/**
 * Spawn from an already-parsed data object. Returns a group + collider
 * descriptors.
 */
export function spawnTreeInstances(data, scene, opts = {}) {
    const prefabName = data.prefab || 'pine';
    const factory = _prefabs.get(prefabName);
    if (!factory) {
        console.warn('[TreeInstancer] unknown prefab:', prefabName);
        return { group: new THREE.Group(), colliders: [] };
    }
    const parts = factory();
    const items = data.items || [];
    const count = items.length;
    if (count === 0) {
        return { group: new THREE.Group(), colliders: [] };
    }

    const group = new THREE.Group();
    group.name = 'TreeInstances_' + prefabName;

    // Create one InstancedMesh per (geometry, material) part.
    const instancedMeshes = parts.map(({ geometry, material }) => {
        const im = new THREE.InstancedMesh(geometry, material, count);
        im.castShadow = true;
        im.receiveShadow = true;
        group.add(im);
        return im;
    });

    // Fill each instance's matrix (shared across all parts — same transform).
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const colliders = [];
    const colliderRadius = opts.colliderRadius ?? 0.25;

    // Optional reject(x, z) → bool  — callers can skip items that land
    // on roads / arenas. We collapse rejected instances to scale 0 so
    // they're invisible (InstancedMesh count is fixed at allocation).
    const reject = typeof opts.reject === 'function' ? opts.reject : null;

    for (let i = 0; i < count; i++) {
        const it = items[i];
        const ix = it.x || 0;
        const iz = it.z || 0;
        if (reject && reject(ix, iz)) {
            // Hide this instance by setting scale 0
            scl.set(0, 0, 0);
            matrix.compose(new THREE.Vector3(0, -1000, 0), new THREE.Quaternion(), scl);
            for (const im of instancedMeshes) im.setMatrixAt(i, matrix);
            continue;
        }
        pos.set(ix, it.y || 0, iz);
        quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.ry || 0);
        const s = (it.s || 1) * (opts.scaleMultiplier || 1);
        scl.set(s, s, s);
        matrix.compose(pos, quat, scl);
        for (const im of instancedMeshes) {
            im.setMatrixAt(i, matrix);
        }
        colliders.push({
            x: pos.x, z: pos.z,
            radius: colliderRadius * s,
        });
    }
    for (const im of instancedMeshes) {
        im.instanceMatrix.needsUpdate = true;
    }

    if (scene) scene.add(group);

    console.log('[TreeInstancer] ' + prefabName + ': ' + count + ' instances, '
                + parts.length + ' draw call(s)');

    return { group, colliders };
}
