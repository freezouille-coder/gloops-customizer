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

// --- Config ---
const MODEL_PATH = 'fbx/Gloops_skeleton.fbx';
const MANIFEST_PATH = 'fbx/manifest.json';
const BG_COLOR = 0x1a1828;
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

// --- Lights (initial — will be replaced by SceneControls presets) ---
scene.add(new THREE.AmbientLight(0xffffff, 0.6));

const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(3, 5, 4);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(1024, 1024);
scene.add(dirLight);

const fillLight = new THREE.DirectionalLight(0x8888ff, 0.4);
fillLight.position.set(-3, 2, -2);
scene.add(fillLight);

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
        config = await fetch('config/character.json').then(r => r.json());
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
        ground.material.color.set(0x111122); // dark to blend with background
        ground.material.needsUpdate = true;
    }

    // Rendering defaults: better quality out of the box
    // Tone mapping ACES for richer contrast
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    // SSAO for depth
    if (typeof postFX !== 'undefined' && postFX.ssaoPass) {
        postFX.setSSAO(true);
        postFX.setSSAORadius(16);
        postFX.setSSAOIntensity(0.15);
    }

    // Environment IBL for subtle reflections
    const pmremGen = new THREE.PMREMGenerator(renderer);
    pmremGen.compileEquirectangularShader();
    const envSize = 256;
    const envCanvas = document.createElement('canvas');
    envCanvas.width = envSize; envCanvas.height = envSize;
    const envCtx = envCanvas.getContext('2d');
    const envGrad = envCtx.createLinearGradient(0, 0, 0, envSize);
    envGrad.addColorStop(0, '#e8d0b0');   // warm top
    envGrad.addColorStop(0.5, '#f5e8d8'); // bright middle
    envGrad.addColorStop(1, '#887766');    // ground
    envCtx.fillStyle = envGrad;
    envCtx.fillRect(0, 0, envSize, envSize);
    const envTex = new THREE.CanvasTexture(envCanvas);
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    envTex.colorSpace = THREE.SRGBColorSpace;
    const envMap = pmremGen.fromEquirectangular(envTex).texture;
    scene.environment = envMap;
    // Set env intensity on all materials
    scene.traverse(child => {
        if (child.isMesh && child.material) {
            child.material.envMapIntensity = 0.4;
        }
    });
    envTex.dispose();
    pmremGen.dispose();

    // Warmer lights
    scene.traverse(child => {
        if (child.isDirectionalLight) {
            child.intensity *= 1.1;
        }
    });
}

// Mobile generate button
document.getElementById('mobile-generate-btn')?.addEventListener('click', async () => {
    try {
        const cfg = await fetch('config/character.json').then(r => r.json());
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
const loadingEl = document.getElementById('loading');

async function init() {
    try {
        // 1. Load base model
        // Load texture library from manifest
        await texLib.loadFromManifest(MANIFEST_PATH);

        loadingEl.textContent = 'Chargement du modele...';
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
        loadingEl.textContent = 'Chargement des animations...';

        const loadPromises = [];
        for (const [catName, catData] of Object.entries(manifestData.categories)) {
            character.registerCategory(catName, catData.type, catData.folder);
            for (const file of catData.files) {
                const url = `fbx/${catData.folder}/${file}`;
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
        const controls = new Controls(character);
        controls.build();

        const matContainer = document.getElementById('material-controls-container');
        if (matContainer) {
            shaderControlsRef = new ShaderControls(shadingManager);
            shaderControlsRef.build(matContainer);
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

        // Hook audio to emotion selection
        const origSelectItem = character.selectItem.bind(character);
        character.selectItem = (catName, filename) => {
            origSelectItem(catName, filename);
            if (catName === 'Emotion') {
                if (filename) audioManager.play(filename);
                else audioManager.stop();
            }
        };

        // Props
        const propsContainer = document.getElementById('props-controls-container');
        if (propsContainer) {
            const propsManager = new PropsManager(scene, character);
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

        loadingEl.classList.add('hidden');
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
function animate() {
    requestAnimationFrame(animate);
    character.update(clock.getDelta());
    orbit.update();
    postFX.render();
}
animate();
