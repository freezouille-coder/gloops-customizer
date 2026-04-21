import * as THREE from 'three';
import * as CANNON from 'cannon-es';

/**
 * Physics world wrapper around cannon-es, following the Sketchbook
 * architecture. Provides:
 *   - fixed-step physics simulation (60 Hz)
 *   - a single THREE.Group container where the debug renderer lives
 *   - helpers to add/remove bodies and sync visuals
 *
 * Usage:
 *   const phys = new PhysicsWorld(scene);
 *   phys.debug(true);
 *   // each frame:
 *   phys.step(dt);
 *
 * Bodies added via addBody() can be paired with a THREE.Object3D via
 * phys.bind(body, mesh) — the wrapper will sync mesh.position/quaternion
 * from the body every step, so you don't have to. Static colliders
 * (kinematic) don't need binding.
 */
export class PhysicsWorld {
    constructor(scene) {
        this.scene = scene;

        // --- cannon world ---
        this.world = new CANNON.World({
            gravity: new CANNON.Vec3(0, -9.82, 0),
        });
        // SAPBroadphase is optimal for mostly-axis-aligned scenes
        this.world.broadphase = new CANNON.SAPBroadphase(this.world);
        this.world.allowSleep = true;
        // Default material: medium friction, low bounce
        this.defaultMaterial = new CANNON.Material('default');
        const defContact = new CANNON.ContactMaterial(
            this.defaultMaterial, this.defaultMaterial,
            { friction: 0.4, restitution: 0.15 }
        );
        this.world.addContactMaterial(defContact);
        this.world.defaultContactMaterial = defContact;

        // Materials catalog — populated lazily by callers
        this.materials = { default: this.defaultMaterial };

        // Body ↔ mesh pairs to sync every step
        this._bindings = [];

        // Fixed-step accumulator
        this._fixedTimeStep = 1 / 60;
        this._maxSubSteps = 4;

        // Debug wireframes
        this._debugEnabled = false;
        this._debugGroup = new THREE.Group();
        this._debugGroup.name = 'physics-debug';
        this._debugGroup.visible = false;
        this.scene.add(this._debugGroup);
        this._debugMeshes = new Map(); // body -> THREE.Mesh[]
    }

    /* --------------------------------------------------------------
     *  World management
     * -------------------------------------------------------------- */

    /** Register a material by name. Reuses if already present. */
    getMaterial(name, opts = {}) {
        if (this.materials[name]) return this.materials[name];
        const m = new CANNON.Material(name);
        this.materials[name] = m;
        // Default contact behavior vs. the default material
        const cm = new CANNON.ContactMaterial(m, this.defaultMaterial, {
            friction: opts.friction ?? 0.4,
            restitution: opts.restitution ?? 0.1,
        });
        this.world.addContactMaterial(cm);
        return m;
    }

    /** Add a body to the world. Optional mesh binding. */
    addBody(body, mesh = null) {
        this.world.addBody(body);
        if (mesh) this._bindings.push({ body, mesh });
        if (this._debugEnabled) this._rebuildDebugFor(body);
        return body;
    }

    removeBody(body) {
        this.world.removeBody(body);
        this._bindings = this._bindings.filter((b) => b.body !== body);
        const meshes = this._debugMeshes.get(body);
        if (meshes) {
            for (const m of meshes) {
                m.removeFromParent();
                m.geometry?.dispose();
                m.material?.dispose();
            }
            this._debugMeshes.delete(body);
        }
    }

    /** Manually bind an existing body to a mesh. */
    bind(body, mesh) {
        this._bindings.push({ body, mesh });
    }

    unbind(body) {
        this._bindings = this._bindings.filter((b) => b.body !== body);
    }

    /* --------------------------------------------------------------
     *  Simulation step
     * -------------------------------------------------------------- */

    step(dt) {
        // cannon-es prefers a fixed timestep with a max-substeps cap
        this.world.step(this._fixedTimeStep, dt, this._maxSubSteps);
        // Sync paired meshes
        for (const { body, mesh } of this._bindings) {
            mesh.position.copy(body.position);
            mesh.quaternion.copy(body.quaternion);
        }
        if (this._debugEnabled) this._updateDebug();
    }

    /* --------------------------------------------------------------
     *  Debug wireframes
     * -------------------------------------------------------------- */

    debug(on) {
        this._debugEnabled = !!on;
        this._debugGroup.visible = this._debugEnabled;
        if (this._debugEnabled) {
            // Build wireframes for every existing body
            for (const b of this.world.bodies) this._rebuildDebugFor(b);
        } else {
            // Clear wireframes
            for (const meshes of this._debugMeshes.values()) {
                for (const m of meshes) {
                    m.removeFromParent();
                    m.geometry?.dispose();
                    m.material?.dispose();
                }
            }
            this._debugMeshes.clear();
        }
    }

    toggleDebug() {
        this.debug(!this._debugEnabled);
        return this._debugEnabled;
    }

    _rebuildDebugFor(body) {
        // Clear any previous meshes for this body
        const existing = this._debugMeshes.get(body) || [];
        for (const m of existing) {
            m.removeFromParent();
            m.geometry?.dispose();
            m.material?.dispose();
        }
        const meshes = [];
        for (let i = 0; i < body.shapes.length; i++) {
            const shape = body.shapes[i];
            const offset = body.shapeOffsets[i];
            const orientation = body.shapeOrientations[i];
            const geo = this._shapeToGeometry(shape);
            if (!geo) continue;
            const mat = new THREE.MeshBasicMaterial({
                color: body.type === CANNON.Body.STATIC ? 0x80ff80 : 0x00ffff,
                wireframe: true,
                depthTest: false,
                transparent: true,
                opacity: 0.8,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.userData.body = body;
            mesh.userData.localOffset = offset.clone();
            mesh.userData.localOrientation = orientation.clone();
            this._debugGroup.add(mesh);
            meshes.push(mesh);
        }
        this._debugMeshes.set(body, meshes);
    }

    _updateDebug() {
        for (const [body, meshes] of this._debugMeshes) {
            for (const mesh of meshes) {
                const o = mesh.userData.localOffset;
                const q = mesh.userData.localOrientation;
                // World pos = body pos + body.quat * localOffset
                const worldOffset = new CANNON.Vec3();
                body.quaternion.vmult(o, worldOffset);
                mesh.position.set(
                    body.position.x + worldOffset.x,
                    body.position.y + worldOffset.y,
                    body.position.z + worldOffset.z,
                );
                const q1 = body.quaternion.mult(q);
                mesh.quaternion.set(q1.x, q1.y, q1.z, q1.w);
            }
        }
    }

    _shapeToGeometry(shape) {
        const T = CANNON.Shape.types;
        switch (shape.type) {
            case T.SPHERE:
                return new THREE.SphereGeometry(shape.radius, 12, 8);
            case T.BOX: {
                const he = shape.halfExtents;
                return new THREE.BoxGeometry(he.x * 2, he.y * 2, he.z * 2);
            }
            case T.CYLINDER: {
                return new THREE.CylinderGeometry(
                    shape.radiusTop, shape.radiusBottom, shape.height, 16
                );
            }
            case T.PLANE:
                return new THREE.PlaneGeometry(100, 100);
            case T.CONVEXPOLYHEDRON:
            case T.TRIMESH: {
                // Generic triangle mesh from shape vertices/indices
                const verts = [];
                const idx = [];
                if (shape.vertices) {
                    for (const v of shape.vertices) verts.push(v.x, v.y, v.z);
                }
                if (shape.indices) {
                    idx.push(...shape.indices);
                } else if (shape.faces) {
                    // ConvexPolyhedron face format
                    for (const face of shape.faces) {
                        for (let i = 1; i < face.length - 1; i++) {
                            idx.push(face[0], face[i], face[i + 1]);
                        }
                    }
                }
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position',
                    new THREE.Float32BufferAttribute(verts, 3));
                if (idx.length) geo.setIndex(idx);
                geo.computeVertexNormals();
                return geo;
            }
            default:
                return null;
        }
    }

    /* --------------------------------------------------------------
     *  Helpers / factories
     * -------------------------------------------------------------- */

    /** Static ground plane at y=0. Uses a huge flat box instead of
     *  CANNON.Plane because RaycastVehicle wheels sometimes skip
     *  infinite planes (SAP broadphase edge case). Returns the body. */
    addGroundPlane() {
        const body = new CANNON.Body({
            mass: 0,
            material: this.defaultMaterial,
            shape: new CANNON.Box(new CANNON.Vec3(400, 0.5, 400)),
            position: new CANNON.Vec3(0, -0.5, 0),   // top at y=0
        });
        this.addBody(body);
        return body;
    }

    /** Static box collider. Pass `{ raycastOnly: true }` to make the
     *  body invisible to normal collisions but still detectable by
     *  wheel raycasts (useful for ramps & drivable slopes). */
    addStaticBox(halfExtents, position, quaternion, opts = {}) {
        const body = new CANNON.Body({
            mass: 0,
            material: this.defaultMaterial,
            shape: new CANNON.Box(new CANNON.Vec3(
                halfExtents.x, halfExtents.y, halfExtents.z
            )),
            position: new CANNON.Vec3(position.x, position.y, position.z),
        });
        if (quaternion) {
            body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
        }
        if (opts.raycastOnly) {
            // Body is still in the world (so wheel raycasts hit it)
            // but no contacts are generated — chassis can't push it.
            body.collisionResponse = false;
        }
        this.addBody(body);
        return body;
    }

    /** Static vertical cylinder (tree trunk, pole). */
    addStaticCylinder(radius, height, position) {
        const body = new CANNON.Body({
            mass: 0,
            material: this.defaultMaterial,
            shape: new CANNON.Cylinder(radius, radius, height, 12),
            position: new CANNON.Vec3(position.x, position.y, position.z),
        });
        this.addBody(body);
        return body;
    }

    /** Dynamic sphere (test falling object). */
    addDynamicSphere(radius, mass, position) {
        const body = new CANNON.Body({
            mass,
            material: this.defaultMaterial,
            shape: new CANNON.Sphere(radius),
            position: new CANNON.Vec3(position.x, position.y, position.z),
        });
        this.addBody(body);
        return body;
    }
}
