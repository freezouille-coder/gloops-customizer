import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Character } from './character.js';
import { Controls } from './controls.js';
import { ShadingManager } from './shading.js';
import { ShaderControls } from './shader-controls.js';
import { SceneControls } from './scene-controls.js';
import { PostProcessing } from './postprocessing.js';
import { PropsManager } from './props.js';
import { PropsControls } from './props-controls.js';
import { TextureLibrary } from './texture-library.js';
import { GenerateControls } from './generate-controls.js';
import { AudioManager, buildAudioPlayer } from './audio.js';
import { Game } from './game/game.js';

// --- Config ---
let MODEL_PATH = 'fbx/Gloops_skeleton.fbx';   // overwritten at boot
// Resolve the manifest path at runtime. FBX is preferred for now —
// GLB had intermittent blendshape glitches. When the GLB pipeline is
// fixed we can flip this back by swapping the two fetch attempts.
async function _resolveManifestPath() {
    try {
        const r = await fetch('fbx/manifest.json', { method: 'HEAD' });
        if (r.ok) return 'fbx/manifest.json';
    } catch (_) {}
    try {
        const r = await fetch('glb/manifest.json', { method: 'HEAD' });
        if (r.ok) return 'glb/manifest.json';
    } catch (_) {}
    return 'fbx/manifest.json';
}
let MANIFEST_PATH = 'fbx/manifest.json';   // overwritten at boot
const BG_COLOR = 0xc8beb0; // warm light grey, matches ground
const STORAGE_KEY = 'gloops_preset';

// --- Three.js Setup ---
const canvas = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_COLOR);

const isMobileInit = window.innerWidth <= 768;
const camera = new THREE.PerspectiveCamera(isMobileInit ? 40 : 20, 1, 0.1, 1000);
camera.position.set(0, 1.2, 3);

const orbit = new OrbitControls(camera, canvas);
orbit.target.set(0, 0.8, 0);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.update();

// --- Lights (3-point studio, more contrast) ---
scene.add(new THREE.AmbientLight(0xfff5e6, 0.3)); // low ambient for contrast

const keyLight = new THREE.DirectionalLight(0xfff0dd, 1.8); // warm key, strong
keyLight.position.set(4, 6, 3);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 0.1;
keyLight.shadow.camera.far = 30;
keyLight.shadow.camera.left = -5;
keyLight.shadow.camera.right = 5;
keyLight.shadow.camera.top = 5;
keyLight.shadow.camera.bottom = -5;
keyLight.shadow.bias = -0.001;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x99bbff, 0.5); // cool fill
fillLight.position.set(-4, 3, -1);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xffffff, 0.9); // rim/back light
rimLight.position.set(0, 4, -5);
scene.add(rimLight);

// --- Ground ---
const ground = new THREE.Mesh(
    new THREE.CircleGeometry(3, 32),
    new THREE.MeshStandardMaterial({ color: 0x222244, roughness: 0.8, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// --- Post Processing ---
const postFX = new PostProcessing(renderer, scene, camera);

// --- Resize ---
function resize() {
    const isMobile = window.innerWidth <= 768;
    const panel = document.getElementById('panel');
    const w = isMobile ? window.innerWidth : window.innerWidth - panel.offsetWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    postFX.resize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // If we're parked in the main menu, re-anchor the Gloops to the right
    // (or center on narrow screens). Wrapped in try/catch because resize
    // fires before the UIStates constants are declared.
    try {
        if (_uiState === UIStates.MAIN_MENU) _positionCameraMainMenu();
    } catch (_) { /* pre-init */ }
}
window.addEventListener('resize', resize);
requestAnimationFrame(resize);

// --- Tab switching ---
document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
});

// --- Texture Library + Save / Load ---
const shadingManager = new ShadingManager();
const texLib = new TextureLibrary();
let shaderControlsRef = null;

function _imgToBase64(img) {
    if (!img) return null;
    try {
        const c = document.createElement('canvas');
        c.width = img.width || img.naturalWidth || 512;
        c.height = img.height || img.naturalHeight || 512;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/png');
    } catch (e) {
        return null;
    }
}

function _base64ToImg(data) {
    if (!data) return Promise.resolve(null);
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = data;
    });
}

function savePreset() {
    const data = { _version: 2, materials: {} };
    for (const name of shadingManager.getMaterialNames()) {
        const entry = shadingManager.getEntry(name);
        if (!entry) continue;
        const m = entry.material;
        data.materials[name] = {
            roughness: m.roughness,
            metalness: m.metalness,
            emissive: '#' + m.emissive.getHexString(),
            emissiveIntensity: m.emissiveIntensity,
            sheen: m.sheen,
            sheenRoughness: m.sheenRoughness,
            sheenColor: '#' + m.sheenColor.getHexString(),
            clearcoat: m.clearcoat,
            clearcoatRoughness: m.clearcoatRoughness,
            transmission: m.transmission,
            thickness: m.thickness,
            ior: m.ior,
            specularIntensity: m.specularIntensity,
            specularColor: '#' + m.specularColor.getHexString(),
            opacity: m.opacity,
            rgbColorsA: entry.rgbColorsA.map(c => '#' + c.getHexString()),
            rgbColorsB: entry.rgbColorsB.map(c => '#' + c.getHexString()),
            // Texture IDs (from manifest) for reconnection on load
            rgbTexIdsA: (entry.rgbTexPathsA || []).map(p => texLib.findId(p)),
            rgbTexIdsB: (entry.rgbTexPathsB || []).map(p => texLib.findId(p)),
            rgbMaskId: texLib.findId(entry._rgbMaskPath),
            maskId: texLib.findId(entry._maskPath),
            emissiveWeightId: texLib.findId(entry._emissiveWeightPath),
            emissiveUseBaseColor: entry._emissiveUseBaseColor || false,
            // Fallback: embed as base64 for textures NOT in manifest (custom uploads)
            rgbTexDataA: entry.rgbTexturesA.map((img, i) =>
                (entry.rgbTexPathsA && entry.rgbTexPathsA[i]) ? null : _imgToBase64(img)),
            rgbTexDataB: entry.rgbTexturesB.map((img, i) =>
                (entry.rgbTexPathsB && entry.rgbTexPathsB[i]) ? null : _imgToBase64(img)),
            rgbMaskData: entry._rgbMaskPath ? null : _imgToBase64(entry.rgbMask),
            maskData: entry._maskPath ? null : _imgToBase64(entry.mask),
            emissiveWeightData: entry._emissiveWeightPath ? null : _imgToBase64(entry._emissiveWeightImg),
        };
    }

    // Save scene settings
    data.scene = {
        fov: camera.fov,
        background: '#' + scene.background.getHexString(),
        ground: {
            visible: ground.visible,
            color: '#' + ground.material.color.getHexString(),
            roughness: ground.material.roughness,
            metalness: ground.material.metalness,
            opacity: ground.material.opacity,
        },
        camera: {
            posX: camera.position.x,
            posY: camera.position.y,
            posZ: camera.position.z,
            targetX: orbit.target.x,
            targetY: orbit.target.y,
            targetZ: orbit.target.z,
        },
        toneMapping: renderer.toneMapping,
        toneMappingExposure: renderer.toneMappingExposure,
    };

    // Generate filename with date + time
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `Gloops_material_preset_${ts}.json`;

    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // Save to localStorage (without base64 textures to avoid quota)
    const lightData = { _version: 2, materials: {}, scene: data.scene };
    for (const [name, vals] of Object.entries(data.materials)) {
        const light = { ...vals };
        delete light.rgbTexDataA;
        delete light.rgbTexDataB;
        delete light.rgbMaskData;
        delete light.maskData;
        delete light.emissiveWeightData;
        lightData.materials[name] = light;
    }
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(lightData));
    } catch (e) {
        console.warn('localStorage full, skipping auto-save');
    }
    console.log('Preset saved: ' + filename);
}

function loadPreset() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', () => {
        if (!input.files[0]) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const raw = JSON.parse(e.target.result);
                const data = raw._version ? raw.materials : raw;
                _applyPreset(data);
                // Apply scene settings if present
                if (raw.scene) _applyScenePreset(raw.scene);
                // Save light version to localStorage (no base64 textures)
                const light = {};
                for (const [name, vals] of Object.entries(data)) {
                    const l = { ...vals };
                    delete l.rgbTexDataA; delete l.rgbTexDataB;
                    delete l.rgbMaskData; delete l.maskData; delete l.emissiveWeightData;
                    light[name] = l;
                }
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ _version: 2, materials: light })); } catch(e) {}
                console.log('Preset loaded: ' + input.files[0].name);
            } catch (err) {
                console.error('Failed to load preset:', err);
                alert('Could not load preset: ' + err.message);
            }
        };
        reader.readAsText(input.files[0]);
    });
    input.click();
}

function _applyPreset(data) {
    for (const [name, vals] of Object.entries(data)) {
        if (!shadingManager.getEntry(name)) continue;
        if (vals.roughness !== undefined) shadingManager.setRoughness(name, vals.roughness);
        if (vals.metalness !== undefined) shadingManager.setMetalness(name, vals.metalness);
        if (vals.emissive) shadingManager.setEmissive(name, vals.emissive, vals.emissiveIntensity || 0);
        if (vals.sheen !== undefined) shadingManager.setSheen(name, vals.sheen);
        if (vals.sheenRoughness !== undefined) shadingManager.setSheenRoughness(name, vals.sheenRoughness);
        if (vals.sheenColor) shadingManager.setSheenColor(name, vals.sheenColor);
        if (vals.clearcoat !== undefined) shadingManager.setClearcoat(name, vals.clearcoat);
        if (vals.clearcoatRoughness !== undefined) shadingManager.setClearcoatRoughness(name, vals.clearcoatRoughness);
        if (vals.transmission !== undefined) shadingManager.setTransmission(name, vals.transmission);
        if (vals.thickness !== undefined) shadingManager.setThickness(name, vals.thickness);
        if (vals.ior !== undefined) shadingManager.setIOR(name, vals.ior);
        if (vals.specularIntensity !== undefined) shadingManager.setSpecularIntensity(name, vals.specularIntensity);
        if (vals.specularColor) shadingManager.setSpecularColor(name, vals.specularColor);
        if (vals.opacity !== undefined) shadingManager.setOpacity(name, vals.opacity);
        if (vals.rgbColorsA) {
            vals.rgbColorsA.forEach((c, i) => shadingManager.setRGBColorA(name, i, c));
        }
        if (vals.rgbColorsB) {
            vals.rgbColorsB.forEach((c, i) => shadingManager.setRGBColorB(name, i, c));
        }
        // Reload textures: prefer manifest ID, then base64, then path
        const loadChannelTex = async (ids, data, setter) => {
            if (!ids && !data) return;
            for (let i = 0; i < 3; i++) {
                let img = null;
                const id = ids && ids[i];
                const b64 = data && data[i];
                if (id) {
                    img = await texLib.loadById(id);
                    if (img) { setter(name, i, img, texLib.getPath(id)); continue; }
                }
                if (b64) {
                    img = await _base64ToImg(b64);
                    if (img) setter(name, i, img, null);
                }
            }
        };
        loadChannelTex(vals.rgbTexIdsA, vals.rgbTexDataA,
            (n, i, img, p) => shadingManager.setRGBTextureA(n, i, img, p));
        loadChannelTex(vals.rgbTexIdsB, vals.rgbTexDataB,
            (n, i, img, p) => shadingManager.setRGBTextureB(n, i, img, p));

        // Reload masks: prefer ID, then base64
        const loadSingleTex = async (id, b64, setter) => {
            let img = null;
            if (id) img = await texLib.loadById(id);
            if (!img && b64) img = await _base64ToImg(b64);
            if (img) setter(img);
        };
        loadSingleTex(vals.rgbMaskId, vals.rgbMaskData, (img) => {
            const e = shadingManager.getEntry(name);
            if (e) { e._rgbMaskPath = vals.rgbMaskId ? texLib.getPath(vals.rgbMaskId) : null; }
            shadingManager.setRGBMask(name, img);
        });
        loadSingleTex(vals.maskId, vals.maskData, (img) => {
            const e = shadingManager.getEntry(name);
            if (e) { e._maskPath = vals.maskId ? texLib.getPath(vals.maskId) : null; }
            shadingManager.setMask(name, img);
        });
        loadSingleTex(vals.emissiveWeightId, vals.emissiveWeightData, (img) => {
            shadingManager.setEmissiveMap(name, img);
        });
        if (vals.emissiveUseBaseColor) shadingManager.setEmissiveUseBaseColor(name, true);
    }
    if (shaderControlsRef) {
        const matContainer = document.getElementById('material-controls-container');
        if (matContainer) shaderControlsRef.build(matContainer);
    }
}

function _applyScenePreset(sceneData) {
    if (!sceneData) return;

    if (sceneData.fov) {
        camera.fov = sceneData.fov;
        camera.updateProjectionMatrix();
    }
    if (sceneData.background) {
        scene.background = new THREE.Color(sceneData.background);
    }
    if (sceneData.ground) {
        const g = sceneData.ground;
        ground.visible = g.visible !== undefined ? g.visible : true;
        if (g.color) ground.material.color.set(g.color);
        if (g.roughness !== undefined) ground.material.roughness = g.roughness;
        if (g.metalness !== undefined) ground.material.metalness = g.metalness;
        if (g.opacity !== undefined) {
            ground.material.opacity = g.opacity;
            ground.material.transparent = g.opacity < 1;
        }
    }
    if (sceneData.camera) {
        const c = sceneData.camera;
        camera.position.set(c.posX || 0, c.posY || 1.2, c.posZ || 3);
        orbit.target.set(c.targetX || 0, c.targetY || 0.8, c.targetZ || 0);
        orbit.update();
    }
    if (sceneData.toneMapping !== undefined) {
        renderer.toneMapping = sceneData.toneMapping;
    }
    if (sceneData.toneMappingExposure !== undefined) {
        renderer.toneMappingExposure = sceneData.toneMappingExposure;
    }
}

async function _autoConnectTextures(autoConnect) {
    const matNames = shadingManager.getMaterialNames();

    for (const matName of matNames) {
        // Try to find a matching folder (case-insensitive)
        const matLower = matName.toLowerCase();
        let folderData = null;
        for (const [folder, types] of Object.entries(autoConnect)) {
            if (matLower.includes(folder.toLowerCase()) || folder.toLowerCase().includes(matLower)) {
                folderData = types;
                break;
            }
        }
        if (!folderData) continue;

        console.log(`Auto-connect: ${matName}`);
        const loadImg = (path) => new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = path;
        });

        // Check if there's a diffuse texture — if so, use simple mode
        const hasDiffuse = folderData['diffuse'];

        for (const [type, entries] of Object.entries(folderData)) {
            const primary = entries.find(e => e.variant === null) || entries[0];
            if (!primary) continue;

            const img = await loadImg(primary.path);
            if (!img) continue;

            switch (type) {
                case 'rgbMask':
                    // Only auto-connect RGBA mask if no diffuse texture
                    if (!hasDiffuse) {
                        shadingManager.setRGBMask(matName, img, primary.path);
                    }
                    break;
                case 'blendMask':
                    if (!hasDiffuse) {
                        shadingManager.setMask(matName, img, primary.path);
                    }
                    break;
                case 'diffuse':
                    // Simple diffuse: set as R Channel Color A texture
                    shadingManager.setRGBTextureA(matName, 0, img, primary.path);
                    // Store all variants for the UI
                    const entry2 = shadingManager.getEntry(matName);
                    if (entry2) {
                        entry2._diffuseVariants = entries
                            .sort((a, b) => (a.variant ?? -1) - (b.variant ?? -1))
                            .map(e => ({ path: e.path, id: e.id, variant: e.variant }));
                    }
                    break;
                case 'normalMap':
                    shadingManager.setNormalMap(matName, img);
                    break;
                case 'bumpMap':
                    shadingManager.setBumpMap(matName, img);
                    break;
                case 'diffuseWeightMap':
                    shadingManager.setDiffuseWeightMap(matName, img);
                    break;
                case 'pattern':
                    // Store variants, load first as default (pattern.0 = black = no pattern)
                    const eP = shadingManager.getEntry(matName);
                    if (eP) {
                        eP._patternVariants = entries
                            .sort((a, b) => (a.variant ?? -1) - (b.variant ?? -1))
                            .map(e2 => ({ path: e2.path, id: e2.id, variant: e2.variant }));
                    }
                    // Load primary pattern (pattern.0 = noir = no effect)
                    shadingManager.setPatternMap(matName, img);
                    break;
                case 'roughnessMap':
                    shadingManager.setRoughnessMap(matName, img);
                    break;
                case 'metalnessMap':
                    shadingManager.setMetalnessMap(matName, img);
                    break;
                case 'aoMap':
                    shadingManager.setAOMap(matName, img);
                    break;
                case 'displacementMap':
                    // Don't auto-connect displacement (OFF by default)
                    // Just store the path for manual activation
                    const e = shadingManager.getEntry(matName);
                    if (e) e._displacementAvailable = primary.path;
                    break;
                case 'alphaMap':
                    shadingManager.setAlphaMap(matName, img);
                    break;
                case 'emissiveMap':
                    shadingManager.setEmissiveMap(matName, img);
                    break;
            }
            if (type !== 'displacementMap') {
                console.log(`  ${type} -> ${primary.path}`);
            }
        }

        // Per-material defaults
        // matLower already defined above

        // Eyes: emissive use base color ON + load variant 8 as default diffuse
        if (matLower.includes('eye') && !matLower.includes('glass') && !matLower.includes('brow') && !matLower.includes('lid')) {
            shadingManager.setEmissiveUseBaseColor(matName, true);
            const entry = shadingManager.getEntry(matName);
            if (entry) entry.material.emissiveIntensity = 1;

            // Load variant 8 as default if available
            if (folderData['diffuse']) {
                const v8 = folderData['diffuse'].find(e => e.variant === 8);
                if (v8) {
                    const v8Img = await loadImg(v8.path);
                    if (v8Img) {
                        shadingManager.setRGBTextureA(matName, 0, v8Img, v8.path);
                        console.log(`  Default eye diffuse: variant 8`);
                    }
                }
            }
        }

        // EyeGlass: emissive use base color ON if emissive map exists
        if (matLower.includes('glass') && folderData['emissiveMap']) {
            shadingManager.setEmissiveUseBaseColor(matName, true);
            const entry = shadingManager.getEntry(matName);
            if (entry) entry.material.emissiveIntensity = 1;
        }
    }
}

async function _applyCharacterDefaults() {
    let config;
    try {
        config = await fetch('config/character.json', { cache: 'no-cache' }).then(r => r.json());
    } catch (e) { return; }

    const defaults = config.defaults || {};
    const linked = config.linkedColors || {};
    const findMat = (kw) => shadingManager.getMaterialNames().find(n => n.toLowerCase().includes(kw));

    // Sheen on all materials
    if (defaults.sheen) {
        for (const name of shadingManager.getMaterialNames()) {
            shadingManager.setSheen(name, defaults.sheen.intensity || 0);
            shadingManager.setSheenRoughness(name, defaults.sheen.roughness || 0.5);
            // Sheen use base color: take diffuse hue, reduce saturation, max value
            const entry = shadingManager.getEntry(name);
            if (entry && defaults.sheen.useBaseColor) {
                entry._sheenUseBaseColor = true;
                entry._sheenSatMult = defaults.sheen.saturationMult || 0.5;
            }
        }
    }

    // Horns B = always black
    if (defaults.horns) {
        const hornsMat = findMat('horns');
        if (hornsMat) {
            if (defaults.horns.B_A) shadingManager.setRGBColorA(hornsMat, 2, defaults.horns.B_A);
            if (defaults.horns.B_B) shadingManager.setRGBColorB(hornsMat, 2, defaults.horns.B_B);
        }
    }

    // Pattern default hue/sat per mode
    if (defaults.pattern) {
        for (const name of shadingManager.getMaterialNames()) {
            const entry = shadingManager.getEntry(name);
            if (entry) {
                entry._patternDefaults = defaults.pattern;
            }
        }
    }

    // Pattern channel restrictions (body=R, horns=G)
    const patternChannels = config.patternChannels || {};
    const chMap = {'R':0,'G':1,'B':2};
    for (const [meshKw, ch] of Object.entries(patternChannels)) {
        const mat = findMat(meshKw);
        if (mat) {
            const entry = shadingManager.getEntry(mat);
            if (entry) entry._patternChannel = chMap[ch];
        }
    }

    // Ground: shadow catcher — nearly invisible, shadow shows through
    if (ground) {
        const size = 512;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
        gradient.addColorStop(0, 'rgba(255,255,255,0.6)');
        gradient.addColorStop(0.3, 'rgba(255,255,255,0.4)');
        gradient.addColorStop(0.6, 'rgba(255,255,255,0.15)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
        ground.material.alphaMap = new THREE.CanvasTexture(canvas);
        ground.material.transparent = true;
        ground.material.color.set(0xb8aea0); // slightly darker than bg for subtle shadow
        ground.material.needsUpdate = true;
    }

    // Rendering defaults
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    // SSAO
    if (typeof postFX !== 'undefined' && postFX.ssaoPass) {
        postFX.setSSAO(true);
        postFX.setSSAORadius(16);
        postFX.setSSAOIntensity(0.12);
    }

    // Environment IBL
    const pmremGen = new THREE.PMREMGenerator(renderer);
    pmremGen.compileEquirectangularShader();
    const envSize = 256;
    const envCanvas = document.createElement('canvas');
    envCanvas.width = envSize; envCanvas.height = envSize;
    const envCtx = envCanvas.getContext('2d');
    const envGrad = envCtx.createLinearGradient(0, 0, 0, envSize);
    envGrad.addColorStop(0, '#d8c0a0');
    envGrad.addColorStop(0.4, '#f0e0d0');
    envGrad.addColorStop(0.6, '#e0d0c0');
    envGrad.addColorStop(1, '#665544');
    envCtx.fillStyle = envGrad;
    envCtx.fillRect(0, 0, envSize, envSize);
    const envTex = new THREE.CanvasTexture(envCanvas);
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    envTex.colorSpace = THREE.SRGBColorSpace;
    const envMap = pmremGen.fromEquirectangular(envTex).texture;
    scene.environment = envMap;
    scene.traverse(child => {
        if (child.isMesh && child.material) child.material.envMapIntensity = 0.5;
    });
    envTex.dispose();
    pmremGen.dispose();
}

// Mobile generate button
document.getElementById('mobile-generate-btn')?.addEventListener('click', async () => {
    try {
        const cfg = await fetch('config/character.json', { cache: 'no-cache' }).then(r => r.json());
        const randomizable = cfg.randomizable || {};
        for (const [key, attr] of Object.entries(randomizable)) {
            if (attr.enabled === false) continue;
            // Quick randomize using same logic as GenerateControls
            if (attr.category) {
                const items = character.getCategoryItems(attr.category);
                if (items.length > 0) {
                    const pick = items[Math.floor(Math.random() * items.length)];
                    character.selectItem(attr.category, pick.filename);
                }
            } else if (attr.type === 'palette') {
                const { COLOR_PALETTE } = await import('./palette.js');
                const pick = COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
                const mat = shadingManager.getMaterialNames().find(n => n.toLowerCase().includes(attr.material));
                if (mat) {
                    if (attr.side === 'B') shadingManager.setRGBColorB(mat, attr.channel || 0, pick.hex);
                    else shadingManager.setRGBColorA(mat, attr.channel || 0, pick.hex);
                }
            }
        }
    } catch (e) { console.error(e); }
});

document.getElementById('btn-save-preset')?.addEventListener('click', savePreset);
document.getElementById('btn-load-preset')?.addEventListener('click', loadPreset);

// Scene save/load
document.getElementById('btn-save-scene')?.addEventListener('click', () => {
    const sceneData = {
        fov: camera.fov,
        background: '#' + scene.background.getHexString(),
        ground: {
            visible: ground.visible,
            color: '#' + ground.material.color.getHexString(),
            roughness: ground.material.roughness,
            metalness: ground.material.metalness,
            opacity: ground.material.opacity,
        },
        camera: {
            posX: camera.position.x, posY: camera.position.y, posZ: camera.position.z,
            targetX: orbit.target.x, targetY: orbit.target.y, targetZ: orbit.target.z,
        },
        toneMapping: renderer.toneMapping,
        toneMappingExposure: renderer.toneMappingExposure,
    };
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    const blob = new Blob([JSON.stringify(sceneData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Gloops_scene_${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
});

document.getElementById('btn-load-scene')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', () => {
        if (!input.files[0]) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const sceneData = JSON.parse(e.target.result);
                _applyScenePreset(sceneData);
            } catch (err) {
                alert('Invalid scene file.');
            }
        };
        reader.readAsText(input.files[0]);
    });
    input.click();
});

// --- Audio ---
const audioManager = new AudioManager();

// --- Init ---
const character = new Character();
// The visible loading message lives inside the LOADING overlay. We point
// loadingEl at the text-only span so `.textContent = ...` doesn't wipe
// the spinner that sits next to it.
const loadingEl = document.getElementById('loading-text');
// Panel + Play button start hidden — the menu flow reveals them as needed.
document.getElementById('panel')?.classList.add('hidden');
document.getElementById('loading')?.classList.add('hidden');

// ====================================================================
// UI STATE MACHINE
// Drives which overlay is visible and where the Gloops sits on screen.
// Transitions are triggered by buttons in loading / main-menu / panel /
// music-picker overlays (wired in _wireMenu below, after Game is built).
// ====================================================================
const UIStates = {
    LOADING:    'loading',
    MAIN_MENU:  'main-menu',
    CUSTOMIZER: 'customizer',
    MUSIC:      'music',
    GAME:       'game',
};
let _uiState = UIStates.LOADING;

function setUIState(state) {
    const prev = _uiState;
    _uiState = state;
    const loading = document.getElementById('loading-screen');
    const menu    = document.getElementById('main-menu');
    const music   = document.getElementById('music-picker');
    const panel   = document.getElementById('panel');
    const menuBg  = document.getElementById('menu-bg');

    // Hide everything, then reveal only what this state needs.
    loading.classList.add('hidden');
    menu.classList.add('hidden');
    music.classList.add('hidden');
    panel.classList.add('hidden');
    // Shared menu bg is shown only for MAIN_MENU and MUSIC — same
    // element is reused so the video keeps looping across transitions.
    const wantMenuBg = (state === UIStates.MAIN_MENU || state === UIStates.MUSIC);
    menuBg?.classList.toggle('hidden', !wantMenuBg);

    switch (state) {
        case UIStates.LOADING:
        case UIStates.MUSIC:
            // Let orbit stay interactive — user can still spin the Gloops
            // while browsing menus (the overlay passes clicks through on
            // empty areas thanks to pointer-events: none).
            (state === UIStates.LOADING ? loading : music).classList.remove('hidden');
            break;
        case UIStates.MAIN_MENU:
            menu.classList.remove('hidden');
            _positionCameraMainMenu();
            break;
        case UIStates.CUSTOMIZER:
            panel.classList.remove('hidden');
            _positionCameraCustomizer();
            break;
        case UIStates.GAME:
            // Game rig takes full control — no overlay, panel hidden.
            break;
    }

    // Dispatch a resize so the canvas re-measures now that the panel
    // visibility has changed. Without this the camera aspect is stale
    // (computed for the previous layout) and the Gloops looks stretched
    // vertically or horizontally after state transitions.
    if (prev !== state) {
        window.dispatchEvent(new Event('resize'));
    }
}

/** Character pinned on the RIGHT half of the screen (menu sits on the left). */
function _positionCameraMainMenu() {
    if (!character.model) return;
    const box = new THREE.Box3().setFromObject(character.model);
    const center = box.getCenter(new THREE.Vector3());
    const h = box.getSize(new THREE.Vector3()).y;
    // On narrow screens the menu takes the full width and the character
    // sits BEHIND it (just visible through the dark vignette) — no shift.
    // On desktop we shift target left so the Gloops ends up on the right.
    const narrow = window.innerWidth < 820;
    const shiftX = narrow ? 0 : -h * 0.8;
    orbit.target.set(center.x + shiftX, center.y, center.z);
    camera.position.set(
        center.x + shiftX + h * 0.3,   // slight 3/4 angle
        center.y + h * 0.1,
        center.z + h * (narrow ? 3.0 : 2.4)  // pull back a bit on mobile
    );
    orbit.update();
    orbit.enabled = false;  // locked — menu is the focus
}

/** Character centered, camera orbitable (default customizer framing). */
function _positionCameraCustomizer() {
    if (!character.model) return;
    const box = new THREE.Box3().setFromObject(character.model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    orbit.target.copy(center);
    // Pulled back ~2× from before — gives the character some breathing
    // room in the frame. FOV is unchanged (camera stays at its native
    // 20° narrow lens) so this is a pure distance / framing change.
    camera.position.set(
        center.x + size.y * 1.4,
        center.y + size.y * 0.35,
        center.z + size.y * 4.4
    );
    orbit.update();
    orbit.enabled = true;
}

// ====================================================================
// Music picker (standalone audio, separate from emotion sounds)
// ====================================================================
// Music tracks are loaded from sound/music.json (built by
// scripts/build_music_manifest.py — scans sound/mp3/ excluding the
// NN_xxx.mp3 emotion SFX files). Re-run the script when you add or
// remove tracks. Until the fetch lands we keep the bundled default.
let MUSIC_TRACKS = [
    { id: 'mami', name: "Mami's Potion Dance",
      path: "sound/mp3/Mami's Potion Dance.mp3", default: true },
];
let DEFAULT_TRACK = MUSIC_TRACKS[0];

(async () => {
    try {
        const r = await fetch('sound/music.json', { cache: 'no-cache' });
        if (!r.ok) throw new Error(r.statusText);
        const list = await r.json();
        if (Array.isArray(list) && list.length) {
            MUSIC_TRACKS = list;
            DEFAULT_TRACK = MUSIC_TRACKS.find((t) => t.default) || MUSIC_TRACKS[0];
            console.log(`[music] loaded ${list.length} track(s) from music.json`);
        }
    } catch (e) {
        console.warn('[music] falling back to bundled list — music.json not available:', e);
    }
})();
let _currentMusicId = null;
let _musicAudio = null;

const MUSIC_VOLUME_KEY = 'gloops_music_volume';
function _getVolume() {
    const v = parseFloat(localStorage.getItem(MUSIC_VOLUME_KEY));
    return isNaN(v) ? 0.55 : Math.max(0, Math.min(1, v));
}
function _setVolume(v) {
    v = Math.max(0, Math.min(1, v));
    localStorage.setItem(MUSIC_VOLUME_KEY, String(v));
    if (_musicAudio) _musicAudio.volume = v;
}

/**
 * Refresh the Music Options screen — update the currently-playing
 * track label and the volume slider. The track navigation itself is
 * handled by _wireMenu (prev/next buttons call window._musicAPI.switch).
 */
function _buildMusicPicker() {
    const label = document.getElementById('music-picker-name');
    if (label) {
        const cur = window._musicAPI?.current();
        label.textContent = cur ? cur.name : '— no tracks —';
    }
    // Sync the volume slider with the stored value.
    const slider = document.getElementById('music-volume');
    const value  = document.getElementById('music-volume-value');
    if (slider && value) {
        const pct = Math.round(_getVolume() * 100);
        slider.value = pct;
        value.textContent = pct;
    }
}
function _playMenuMusic(track) {
    if (!_musicAudio) _musicAudio = new Audio();
    _musicAudio.src = track.path;
    _musicAudio.loop = true;
    _musicAudio.volume = _getVolume();
    _musicAudio.play().catch((e) => console.warn('[music] play failed', e));
    _currentMusicId = track.id;
    // Expose so the in-game pause menu can toggle .muted without needing
    // to route through the full music picker UI.
    window._musicAudio = _musicAudio;
}

// ====================================================================
// Music API shared with the in-game pause menu. Lets the pause overlay
// cycle tracks ◀ / ▶ without reaching back into app.js internals.
// ====================================================================
window._musicAPI = {
    /** Return the currently playing track, or the default if none yet. */
    current() {
        if (_currentMusicId) {
            const t = MUSIC_TRACKS.find((t) => t.id === _currentMusicId);
            if (t) return t;
        }
        return DEFAULT_TRACK || MUSIC_TRACKS[0];
    },
    /** Jump to the previous / next track (dir: -1 or +1). Returns the
     *  new track object (or null if no tracks available). */
    switch(dir) {
        if (!MUSIC_TRACKS.length) return null;
        const cur = _currentMusicId
            ? MUSIC_TRACKS.findIndex((t) => t.id === _currentMusicId)
            : 0;
        let next = (cur + dir) % MUSIC_TRACKS.length;
        if (next < 0) next += MUSIC_TRACKS.length;
        const track = MUSIC_TRACKS[next];
        _playMenuMusic(track);
        return track;
    },
    /** How many tracks are available (for UI hints) */
    count() { return MUSIC_TRACKS.length; },
};
function _stopMenuMusic() {
    if (_musicAudio) _musicAudio.pause();
    _currentMusicId = null;
}

/**
 * Try to start the default track as early as possible.
 * 1. Attempt a direct play() — this succeeds on sites the user has
 *    already interacted with before (browser autoplay cache).
 * 2. If the play() promise rejects (no user gesture this session),
 *    arm one-shot listeners on the first pointerdown/keydown anywhere
 *    so the track starts on the very first click (typically START).
 */
// Also exposed for the in-game pause menu when it needs to kick off
// the track on demand (e.g. user hit ESC before any interaction fired
// the gesture listener).
window._armMusicAutoStart = _armMusicAutoStart;
function _armMusicAutoStart() {
    if (!DEFAULT_TRACK || _currentMusicId) return;
    if (!_musicAudio) _musicAudio = new Audio();
    window._musicAudio = _musicAudio;
    _musicAudio.src = DEFAULT_TRACK.path;
    _musicAudio.loop = true;
    _musicAudio.volume = _getVolume();

    const armGestureFallback = () => {
        const start = () => {
            _musicAudio.play().then(() => {
                _currentMusicId = DEFAULT_TRACK.id;
            }).catch((e) => console.warn('[music] play still blocked:', e));
            window.removeEventListener('pointerdown', start);
            window.removeEventListener('keydown', start);
            window.removeEventListener('touchstart', start);
        };
        window.addEventListener('pointerdown', start, { once: true });
        window.addEventListener('keydown',     start, { once: true });
        window.addEventListener('touchstart',  start, { once: true });
    };

    const playPromise = _musicAudio.play();
    if (playPromise && typeof playPromise.then === 'function') {
        playPromise
            .then(() => { _currentMusicId = DEFAULT_TRACK.id; })
            .catch(() => armGestureFallback());
    } else {
        armGestureFallback();
    }
}

// ====================================================================
// "Continue" save marker — flipped on the first successful game.enter()
// so the Continue button shows up on subsequent sessions.
// ====================================================================
const SAVE_MARKER_KEY = 'gloops_has_save';
function _hasContinueSave() { return localStorage.getItem(SAVE_MARKER_KEY) === '1'; }
function _markSessionSaved() { localStorage.setItem(SAVE_MARKER_KEY, '1'); }

// ====================================================================
// Wire up every menu button. Called once after Game instance is built
// so we have a ref to start/exit game mode.
// ====================================================================
function _wireMenu(game) {
    // Loading screen: "Continue" proceeds to the main menu.
    document.getElementById('btn-loading-start')
        ?.addEventListener('click', () => setUIState(UIStates.MAIN_MENU));

    // Main menu: Continue / New Game / Music
    document.getElementById('btn-menu-continue')
        ?.addEventListener('click', () => {
            if (_hasContinueSave()) _enterGame(game);
        });
    document.getElementById('btn-menu-new')
        ?.addEventListener('click', () => setUIState(UIStates.CUSTOMIZER));
    document.getElementById('btn-menu-music')
        ?.addEventListener('click', () => {
            _buildMusicPicker();
            setUIState(UIStates.MUSIC);
        });

    // Music picker — back + volume slider + prev/next switcher
    document.getElementById('btn-music-back')
        ?.addEventListener('click', () => setUIState(UIStates.MAIN_MENU));
    const slider = document.getElementById('music-volume');
    const value  = document.getElementById('music-volume-value');
    if (slider && value) {
        slider.addEventListener('input', () => {
            const pct = +slider.value;
            value.textContent = pct;
            _setVolume(pct / 100);
        });
    }
    const pickerLabel = document.getElementById('music-picker-name');
    const refreshPickerLabel = () => {
        const cur = window._musicAPI?.current();
        if (pickerLabel) pickerLabel.textContent = cur ? cur.name : '— no tracks —';
    };
    document.getElementById('btn-music-picker-prev')
        ?.addEventListener('click', () => {
            window._musicAPI?.switch(-1);
            refreshPickerLabel();
        });
    document.getElementById('btn-music-picker-next')
        ?.addEventListener('click', () => {
            window._musicAPI?.switch(+1);
            refreshPickerLabel();
        });

    // Customizer panel: Back to menu + Start Game.
    // Music keeps playing across states so a track picked in the menu
    // carries into the game / customizer seamlessly.
    document.getElementById('btn-back-menu')
        ?.addEventListener('click', () => setUIState(UIStates.MAIN_MENU));
    document.getElementById('btn-start-game')
        ?.addEventListener('click', () => _enterGame(game));

    // Intercept game.enter() / game.exit():
    //   - on enter, mark the save so Continue lights up next time
    //   - on exit, return to main menu instead of customizer
    const originalEnter = game.enter.bind(game);
    game.enter = async () => {
        await originalEnter();
        _markSessionSaved();
        _refreshContinueButton();
    };
    const originalExit = game.exit.bind(game);
    game.exit = () => {
        originalExit();
        setUIState(UIStates.MAIN_MENU);
    };

    _refreshContinueButton();
}

/** Show or hide the Continue button based on whether we have a save.
 *  No ghost "disabled" state — it just doesn't appear until there's
 *  something meaningful to resume. */
function _refreshContinueButton() {
    const btn = document.getElementById('btn-menu-continue');
    if (!btn) return;
    const has = _hasContinueSave();
    btn.hidden = !has;
    btn.textContent = 'Continue';
}

/**
 * Enter the game with a polished loading screen that covers the world
 * assembly (tree instancing, physics bodies, NPC spawn). Hides the
 * visual "popcorn" of objects snapping into place.
 */
async function _enterGame(game) {
    const overlay = document.getElementById('game-loading');
    const label   = document.getElementById('game-loading-text');
    overlay?.classList.remove('hidden');
    if (label) label.textContent = 'Loading city...';

    setUIState(UIStates.GAME);

    // Give the browser 2 paints so the overlay is guaranteed on-screen
    // BEFORE we start the synchronous-heavy world build (tree instancer,
    // physics trimesh, etc). rAF x 2 is the reliable pattern for that.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    try {
        // Swap the label mid-flight so the user sees progress
        if (label) label.textContent = 'Building world...';
        await game.enter();
        if (label) label.textContent = 'Ready!';
        // Short reveal delay so the "Ready!" is readable + first frames
        // of the game tick have run and visuals have settled.
        await new Promise((r) => setTimeout(r, 280));
        overlay?.classList.add('hidden');
    } catch (err) {
        console.error('[game.enter] failed:', err);
        overlay?.classList.add('hidden');
        alert(`Failed to start the game:\n${err.message}\n\nSee console for details.`);
        setUIState(UIStates.MAIN_MENU);
    }
}

async function init() {
    try {
        MANIFEST_PATH = await _resolveManifestPath();
        const ASSET_ROOT = MANIFEST_PATH.split('/')[0];
        const MODEL_EXT  = ASSET_ROOT === 'glb' ? '.glb' : '.fbx';
        MODEL_PATH = `${ASSET_ROOT}/Gloops_skeleton${MODEL_EXT}`;
        // Shared with game-world.js CityGenerator so it loads from the
        // same folder (fbx / glb) without re-resolving.
        window._assetRoot = ASSET_ROOT;
        console.log('[app] manifest resolved to', MANIFEST_PATH, '— model at', MODEL_PATH);
        // 1. Load base model
        // Load texture library from manifest
        await texLib.loadFromManifest(MANIFEST_PATH);

        loadingEl.textContent = 'Loading model...';
        await character.load(MODEL_PATH);
        const model = character.model;

        // Auto-scale
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 5) {
            model.scale.setScalar(2 / maxDim);
        }

        // Center
        const box2 = new THREE.Box3().setFromObject(model);
        const center = box2.getCenter(new THREE.Vector3());
        model.position.sub(center);
        model.position.y -= box2.min.y - center.y;

        // Fix skinning: support more than 4 bone influences
        model.traverse((child) => {
            if (child.isSkinnedMesh) {
                const geometry = child.geometry;
                // Normalize skin weights
                if (geometry.attributes.skinWeight) {
                    const skinWeight = geometry.attributes.skinWeight;
                    for (let i = 0; i < skinWeight.count; i++) {
                        const w = new THREE.Vector4().fromBufferAttribute(skinWeight, i);
                        const sum = w.x + w.y + w.z + w.w;
                        if (sum > 0) {
                            w.divideScalar(sum);
                            skinWeight.setXYZW(i, w.x, w.y, w.z, w.w);
                        }
                    }
                    skinWeight.needsUpdate = true;
                }
            }
        });

        // Materials
        shadingManager.scanModel(model);

        // Auto-connect textures from manifest
        const manifestData = await fetch(MANIFEST_PATH).then(r => r.json());
        const autoConnect = manifestData.autoConnect || {};
        await _autoConnectTextures(autoConnect);

        // Apply character defaults from config
        await _applyCharacterDefaults();

        scene.add(model);

        // Camera
        const finalBox = new THREE.Box3().setFromObject(model);
        const finalCenter = finalBox.getCenter(new THREE.Vector3());
        orbit.target.copy(finalCenter);
        // 3/4 view from right, more distant
        camera.position.set(
            finalCenter.x + size.y * 0.8,   // offset right
            finalCenter.y + size.y * 0.2,   // slightly above
            finalCenter.z + size.y * 2.2    // further away
        );
        orbit.update();

        // Set outline targets
        const meshes = [];
        model.traverse(child => { if (child.isMesh) meshes.push(child); });
        postFX.setOutlineObjects(meshes);

        // 2. Load animations from manifest
        loadingEl.textContent = 'Loading animations...';

        const loadPromises = [];
        for (const [catName, catData] of Object.entries(manifestData.categories)) {
            // Asset root derived from the resolved manifest path (fbx/ or glb/)
            const ASSET_ROOT = MANIFEST_PATH.split('/')[0];
            character.registerCategory(catName, catData.type, catData.folder);
            for (const file of catData.files) {
                const url = `${ASSET_ROOT}/${catData.folder}/${file}`;
                loadPromises.push(
                    character.loadItem(catName, file, url).catch(err => {
                        console.warn(`Failed to load ${url}:`, err);
                        return null;
                    })
                );
            }
        }
        await Promise.all(loadPromises);

        // 3. Build UIs
        const controls = new Controls(character, scene);
        controls.build();

        const matContainer = document.getElementById('material-controls-container');
        if (matContainer) {
            shaderControlsRef = new ShaderControls(shadingManager);
            shaderControlsRef.build(matContainer);
            // Rebuild the MAT panel when paired-prop materials are
            // added/removed so they appear/disappear in the dropdown.
            shadingManager.onMaterialsChanged(() => {
                shaderControlsRef.build(matContainer);
            });
        }

        const sceneContainer = document.getElementById('scene-controls-container');
        if (sceneContainer) {
            const sceneCtrl = new SceneControls(scene, camera, renderer, ground, postFX);
            sceneCtrl.build(sceneContainer);
        }

        // Generate
        const genContainer = document.getElementById('generate-controls-container');
        if (genContainer) {
            const genControls = new GenerateControls(character, shadingManager, manifestData);
            await genControls.build(genContainer);
        }

        // Audio player — add in panel, after logo (desktop) or after mobile btn (mobile)
        const audioPlayerEl = buildAudioPlayer(audioManager);
        const mobileBtn = document.getElementById('mobile-generate-btn');
        if (window.innerWidth <= 768 && mobileBtn) {
            mobileBtn.parentNode.insertBefore(audioPlayerEl, mobileBtn);
        } else {
            const logoDiv = document.getElementById('panel-logo');
            if (logoDiv) logoDiv.appendChild(audioPlayerEl);
        }

        // Hook audio to emotion selection.
        // A flag `character._silentEmotion` lets Generate Random skip the
        // SFX burst (17 overlapping voice clips sounds awful). Normal
        // user-initiated emotion picks still play their sound.
        const origSelectItem = character.selectItem.bind(character);
        character.selectItem = (catName, filename) => {
            origSelectItem(catName, filename);
            if (catName === 'Emotion' && !character._silentEmotion) {
                if (filename) audioManager.play(filename);
                else audioManager.stop();
            }
        };

        // Props
        const propsContainer = document.getElementById('props-controls-container');
        if (propsContainer) {
            const propsManager = new PropsManager(scene, character);
            propsManager.loadCatalog(manifestData.props || {});
            propsManager.loadPairedManifest(manifestData.pairedProps || {});
            propsManager.setAssetRoot(ASSET_ROOT);
            // Let paired-prop materials show up in the MAT panel
            propsManager.setShadingManager(shadingManager);
            // Per-prop transform offsets (rotation/position/scale fixes)
            try {
                const off = await fetch('config/paired-offsets.json').then((r) => r.ok ? r.json() : {});
                propsManager.loadPairedOffsets(off);
                console.log(`[paired-offsets] loaded ${Object.keys(off).filter((k) => !k.startsWith('_')).length} entries`);
            } catch (e) {
                console.warn('[paired-offsets] none loaded:', e?.message);
                propsManager.loadPairedOffsets({});
            }
            // Hook back into character so selectItem() can auto-attach
            // the FBX sitting in <category>/PROPS/<same name>.fbx
            character.props = propsManager;
            const propsControls = new PropsControls(propsManager);
            propsControls.build(propsContainer);
        }

        // 4. Auto-load saved preset (materials + scene)
        const savedPreset = localStorage.getItem(STORAGE_KEY);
        if (savedPreset) {
            try {
                const raw = JSON.parse(savedPreset);
                const data = raw._version ? raw.materials : raw;
                if (data && typeof data === 'object') {
                    _applyPreset(data);
                    if (raw.scene) _applyScenePreset(raw.scene);
                    console.log('Auto-loaded saved preset');
                }
            } catch (e) {
                console.warn('Clearing corrupted preset:', e);
                localStorage.removeItem(STORAGE_KEY);
            }
        }

        // Game mode — force "city" for now. Sketchbook stays in the codebase
        // but is not exposed in the UI.
        localStorage.setItem('gloops_level', 'city');
        const characterConfig = await fetch('config/character.json', { cache: 'no-cache' }).then(r => r.json()).catch(() => ({}));
        const game = new Game({ scene, camera, renderer, character, orbit, ground, manifestData, characterConfig });
        window._game = game;

        // Wire every menu button (loading Start → main menu → customizer / game / music).
        _wireMenu(game);

        // Done — hide the "Loading..." row entirely and reveal the
        // LET'S GO button. Arm the music auto-start listener so the
        // first user gesture kicks off the default track.
        document.getElementById('loading-msg')?.classList.add('hidden');
        document.getElementById('btn-loading-start')?.classList.remove('hidden');
        _armMusicAutoStart();
        console.log('Gloops ready!');

        // Debug: expose character for console inspection
        window._character = character;
        window._mixer = character.mixer;

    } catch (err) {
        loadingEl.textContent = `Erreur: ${err.message}`;
        loadingEl.style.color = '#e94560';
        console.error(err);
    }
}

init();

// --- Loop ---
const clock = new THREE.Clock();
let _animateErrorReported = false;
function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    try {
        character.update(dt);
        // Orbit first, THEN game — so gameCamera has the final word on
        // camera position/orientation. OrbitControls.update() ignores the
        // `enabled` flag and re-applies its own position+lookAt every frame,
        // so if it runs after gameCamera it clobbers the third-person rig.
        if (window._game && window._game.active) {
            window._game.update(dt);
        } else {
            orbit.update();
        }
        postFX.render();
    } catch (err) {
        // Only log the first time so the console isn't flooded.
        if (!_animateErrorReported) {
            console.error('[animate] exception in frame loop — scene may be frozen:', err);
            _animateErrorReported = true;
        }
    }
}
animate();
