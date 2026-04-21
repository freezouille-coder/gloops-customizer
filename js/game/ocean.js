import * as THREE from 'three';
import { WaterShader } from './water-shader.js';

/**
 * Direct port of Sketchbook's `src/ts/world/Ocean.ts`.
 *
 * Uses the original fragment shader by Jonathan Blaire (codepen)
 * adapted for three.js by Jan Bláha. Does real wave displacement +
 * tinting in the fragment stage.
 *
 * Usage:
 *   const ocean = new Ocean(seaMesh, { camera, sunDirection });
 *   ocean.update(dt, cameraPos, sunDirection);
 */
export class Ocean {
    constructor(mesh, opts = {}) {
        this.mesh = mesh;

        const uniforms = THREE.UniformsUtils.clone(WaterShader.uniforms);
        uniforms.iResolution.value.x = window.innerWidth;
        uniforms.iResolution.value.y = window.innerHeight;

        this.material = new THREE.ShaderMaterial({
            uniforms,
            fragmentShader: WaterShader.fragmentShader,
            vertexShader: WaterShader.vertexShader,
        });
        this.material.transparent = true;
        mesh.material = this.material;

        // Defaults
        const sun = opts.sunDirection ?? new THREE.Vector3(-0.6, 0.7, -0.4).normalize();
        this.material.uniforms.lightDir.value.copy(sun);

        window.addEventListener('resize', () => {
            this.material.uniforms.iResolution.value.x = window.innerWidth;
            this.material.uniforms.iResolution.value.y = window.innerHeight;
        });
    }

    /** Call every frame with `dt` (seconds) and the current camera. */
    update(dt, camera) {
        this.material.uniforms.iGlobalTime.value += dt;
        if (camera) {
            this.material.uniforms.cameraPos.value.copy(camera.position);
        }
    }
}
