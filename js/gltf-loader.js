import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/**
 * Shared DRACO decoder. All Draco-compressed GLB files produced by our
 * fbx_to_glb.py script (with --compress flag) need this to decode mesh
 * geometry. We create one DRACOLoader instance, point it at Three.js's
 * official decoder CDN, and hand it to every GLTFLoader we build.
 */
const _dracoLoader = new DRACOLoader();
_dracoLoader.setDecoderPath(
    'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/'
);
_dracoLoader.setDecoderConfig({ type: 'js' });   // JS decoder (WASM also works)

/** Factory — every GLTFLoader built here has Draco support wired in. */
export function makeGLTFLoader() {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(_dracoLoader);
    return loader;
}

/** The shared loader for code that doesn't need its own instance. */
export const sharedGLTFLoader = makeGLTFLoader();
