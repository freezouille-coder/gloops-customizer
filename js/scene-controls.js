import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

/**
 * Light rig presets.
 */
const LIGHT_PRESETS = {
    'Studio': {
        ambient: { color: 0xffffff, intensity: 0.5 },
        lights: [
            { type: 'dir', color: 0xffffff, intensity: 1.2, pos: [3, 5, 4], shadow: true },
            { type: 'dir', color: 0x8888ff, intensity: 0.4, pos: [-3, 2, -2] },
        ]
    },
    '3-Point': {
        ambient: { color: 0xffffff, intensity: 0.3 },
        lights: [
            { type: 'dir', color: 0xfff5e6, intensity: 1.4, pos: [4, 6, 3], shadow: true },   // Key
            { type: 'dir', color: 0x99bbff, intensity: 0.6, pos: [-4, 3, -1] },                // Fill
            { type: 'dir', color: 0xffffff, intensity: 0.8, pos: [0, 4, -5] },                 // Back/Rim
        ]
    },
    'Outdoor': {
        ambient: { color: 0xaaccff, intensity: 0.7 },
        lights: [
            { type: 'dir', color: 0xfffae6, intensity: 1.6, pos: [5, 8, 3], shadow: true },    // Sun
            { type: 'dir', color: 0x88aadd, intensity: 0.3, pos: [-3, 1, -2] },                // Sky bounce
        ]
    },
    'Dramatic': {
        ambient: { color: 0x111122, intensity: 0.15 },
        lights: [
            { type: 'dir', color: 0xff8844, intensity: 2.0, pos: [5, 3, 1], shadow: true },
            { type: 'dir', color: 0x2244aa, intensity: 0.6, pos: [-4, 5, -3] },
        ]
    },
    'Soft': {
        ambient: { color: 0xffffff, intensity: 0.8 },
        lights: [
            { type: 'dir', color: 0xffffff, intensity: 0.6, pos: [2, 5, 3], shadow: true },
            { type: 'dir', color: 0xffffff, intensity: 0.4, pos: [-2, 3, 1] },
            { type: 'dir', color: 0xeeeeff, intensity: 0.3, pos: [0, 2, -4] },
        ]
    },
    'Night': {
        ambient: { color: 0x0a0a22, intensity: 0.1 },
        lights: [
            { type: 'dir', color: 0x6688cc, intensity: 0.8, pos: [-2, 6, 2], shadow: true },
            { type: 'dir', color: 0x334466, intensity: 0.3, pos: [3, 1, -3] },
        ]
    },
};

export class SceneControls {
    constructor(scene, camera, renderer, ground, postFX) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.ground = ground;
        this.postFX = postFX;
        this.container = null;

        // Track dynamic lights so we can remove them
        this._dynamicLights = [];
        this._ambientLight = null;
        this._pmremGenerator = new THREE.PMREMGenerator(renderer);
        this._pmremGenerator.compileEquirectangularShader();
        this._envIntensity = 1.0;
        this._rgbeLoader = new RGBELoader();

        // Find existing ambient
        scene.traverse(child => {
            if (child.isAmbientLight) this._ambientLight = child;
        });
    }

    build(container) {
        this.container = container;
        this.container.innerHTML = '';

        // --- FOV ---
        this.container.appendChild(this._section('Camera', [
            this._slider('FOV', this.camera.fov, 20, 100, 1, (v) => {
                this.camera.fov = v;
                this.camera.updateProjectionMatrix();
            }),
        ], false));

        // --- Background ---
        const bgColor = this.scene.background || new THREE.Color(0x1a1a2e);
        this.container.appendChild(this._section('Background', [
            this._colorPicker('Color', bgColor, (c) => {
                this.scene.background = new THREE.Color(c);
            }),
        ]));

        // --- Ground ---
        const groundMat = this.ground.material;
        this.container.appendChild(this._section('Ground', [
            this._checkbox('Visible', this.ground.visible, (v) => { this.ground.visible = v; }),
            this._colorPicker('Color', groundMat.color, (c) => { groundMat.color.set(c); }),
            this._slider('Roughness', groundMat.roughness, 0, 1, 0.01, (v) => { groundMat.roughness = v; }),
            this._slider('Metalness', groundMat.metalness, 0, 1, 0.01, (v) => { groundMat.metalness = v; }),
            this._slider('Opacity', groundMat.opacity, 0, 1, 0.01, (v) => {
                groundMat.opacity = v;
                groundMat.transparent = v < 1;
            }),
            this._checkbox('Gradient Shadow', false, (v) => this._setGradientShadow(v)),
            this._fileUpload('Alpha Texture', 'image/*', (file) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const img = new Image();
                    img.onload = () => {
                        const tex = new THREE.CanvasTexture(img);
                        tex.colorSpace = THREE.SRGBColorSpace;
                        groundMat.alphaMap = tex;
                        groundMat.transparent = true;
                        groundMat.needsUpdate = true;
                    };
                    img.src = e.target.result;
                };
                reader.readAsDataURL(file);
            }),
        ]));

        // --- Light Rig ---
        const presetNames = Object.keys(LIGHT_PRESETS);
        this.container.appendChild(this._section('Light Rig', [
            this._dropdown('Preset', presetNames, 'Studio', (name) => this._applyLightPreset(name)),
            this._slider('Intensity', 1.0, 0, 3, 0.05, (v) => this._scaleLightIntensity(v)),
            this._checkbox('Shadows', true, (v) => this._toggleShadows(v)),
        ]));

        // --- Environment ---
        this.container.appendChild(this._section('Environment (IBL)', [
            this._dropdown('Preset', ['None', 'Warm Studio', 'Cool Sky', 'Sunset', 'Neutral'], 'None',
                (name) => this._applyEnvPreset(name)),
            this._fileUpload('HDRI (.hdr)', '.hdr,image/*',
                (file) => this._loadHDRI(file)),
            this._slider('Intensity', 1.0, 0, 3, 0.05,
                (v) => this._setEnvIntensity(v)),
            this._checkbox('Show Background', false,
                (v) => this._setEnvBackground(v)),
        ]));

        // --- Tone Mapping ---
        this.container.appendChild(this._section('Tone Mapping', [
            this._dropdown('Type', ['None', 'Linear', 'Reinhard', 'ACES Filmic'], 'None',
                (name) => {
                    const map = {
                        'None': THREE.NoToneMapping,
                        'Linear': THREE.LinearToneMapping,
                        'Reinhard': THREE.ReinhardToneMapping,
                        'ACES Filmic': THREE.ACESFilmicToneMapping,
                    };
                    this.renderer.toneMapping = map[name] || THREE.NoToneMapping;
                }),
            this._slider('Exposure', 1.0, 0.1, 3, 0.05,
                (v) => { this.renderer.toneMappingExposure = v; }),
        ]));

        // --- Post Processing ---
        if (this.postFX) {
            this.container.appendChild(this._section('Anti-Aliasing', [
                this._checkbox('SMAA', true, (v) => this.postFX.setSMAA(v)),
            ]));

            this.container.appendChild(this._section('SSAO', [
                this._checkbox('Enable', false, (v) => this.postFX.setSSAO(v)),
                this._slider('Radius', 16, 1, 64, 1, (v) => this.postFX.setSSAORadius(v)),
                this._slider('Intensity', 0.1, 0.01, 1, 0.01, (v) => this.postFX.setSSAOIntensity(v)),
            ]));

            this.container.appendChild(this._section('Bloom', [
                this._checkbox('Enable', false, (v) => this.postFX.setBloom(v)),
                this._slider('Strength', 0.3, 0, 3, 0.05, (v) => this.postFX.setBloomStrength(v)),
                this._slider('Radius', 0.4, 0, 1, 0.05, (v) => this.postFX.setBloomRadius(v)),
                this._slider('Threshold', 0.85, 0, 1, 0.05, (v) => this.postFX.setBloomThreshold(v)),
            ]));

            this.container.appendChild(this._section('Color Balance', [
                this._checkbox('Enable', false, (v) => this.postFX.setColorBalance(v)),
                this._slider('Brightness', 0, -0.5, 0.5, 0.01, (v) => this.postFX.setBrightness(v)),
                this._slider('Contrast', 0, -1, 1, 0.01, (v) => this.postFX.setContrast(v)),
                this._slider('Saturation', 1, 0, 2, 0.01, (v) => this.postFX.setSaturation(v)),
            ]));

            this.container.appendChild(this._section('Outline', [
                this._checkbox('Enable', false, (v) => this.postFX.setOutline(v)),
                this._slider('Thickness', 1, 0.5, 4, 0.1, (v) => this.postFX.setOutlineThickness(v)),
                this._slider('Strength', 5, 1, 10, 0.5, (v) => this.postFX.setOutlineStrength(v)),
                this._slider('Glow', 0.5, 0, 1, 0.05, (v) => this.postFX.setOutlineGlow(v)),
                this._colorPicker('Color', new THREE.Color(0x000000), (c) => this.postFX.setOutlineColor(c)),
            ]));

            this.container.appendChild(this._section('Grain', [
                this._checkbox('Enable', false, (v) => this.postFX.setGrain(v)),
                this._slider('Amount', 0.08, 0, 0.3, 0.005, (v) => this.postFX.setGrainAmount(v)),
                this._slider('Scale', 1.0, 0.1, 4, 0.1, (v) => this.postFX.setGrainScale(v)),
                this._checkbox('RGB Noise', false, (v) => this.postFX.setGrainColorNoise(v)),
            ]));

            this.container.appendChild(this._section('Sharpness', [
                this._checkbox('Enable', false, (v) => this.postFX.setSharpen(v)),
                this._slider('Amount', 0.3, 0, 1, 0.05, (v) => this.postFX.setSharpenAmount(v)),
            ]));

            this.container.appendChild(this._section('Chromatic Aberration', [
                this._checkbox('Enable', false, (v) => this.postFX.setChroma(v)),
                this._slider('Amount', 0.003, 0, 0.02, 0.001, (v) => this.postFX.setChromaAmount(v)),
            ]));

            this.container.appendChild(this._section('Pixelise', [
                this._checkbox('Enable', false, (v) => this.postFX.setPixelise(v)),
                this._slider('Pixel Size', 4, 1, 16, 1, (v) => this.postFX.setPixelSize(v)),
            ]));

            this.container.appendChild(this._section('Vignette', [
                this._checkbox('Enable', false, (v) => this.postFX.setVignette(v)),
                this._slider('Darkness', 1.2, 0, 3, 0.1, (v) => this.postFX.setVignetteDarkness(v)),
            ]));
        }
    }

    // --- Ground Gradient ---

    _setGradientShadow(enabled) {
        const mat = this.ground.material;
        if (enabled) {
            const size = 512;
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            const gradient = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
            gradient.addColorStop(0, 'rgba(255,255,255,1)');
            gradient.addColorStop(0.5, 'rgba(255,255,255,0.6)');
            gradient.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, size, size);
            const tex = new THREE.CanvasTexture(canvas);
            mat.alphaMap = tex;
            mat.transparent = true;
        } else {
            mat.alphaMap = null;
            mat.transparent = mat.opacity < 1;
        }
        mat.needsUpdate = true;
    }

    // --- Environment ---

    _applyEnvPreset(name) {
        if (name === 'None') {
            this.scene.environment = null;
            return;
        }

        // Generate a simple gradient environment from colors
        const presets = {
            'Warm Studio':  { top: 0xfff5e0, mid: 0xffe0c0, bot: 0x8b7355, intensity: 0.8 },
            'Cool Sky':     { top: 0x88bbff, mid: 0xaaddff, bot: 0x446688, intensity: 0.6 },
            'Sunset':       { top: 0x1a0533, mid: 0xff6644, bot: 0x442200, intensity: 1.0 },
            'Neutral':      { top: 0xcccccc, mid: 0xffffff, bot: 0x888888, intensity: 0.5 },
        };

        const p = presets[name];
        if (!p) return;

        // Create a simple gradient cubemap from a canvas
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        const topCol = new THREE.Color(p.top);
        const midCol = new THREE.Color(p.mid);
        const botCol = new THREE.Color(p.bot);

        const gradient = ctx.createLinearGradient(0, 0, 0, size);
        gradient.addColorStop(0, '#' + topCol.getHexString());
        gradient.addColorStop(0.5, '#' + midCol.getHexString());
        gradient.addColorStop(1, '#' + botCol.getHexString());
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);

        const tex = new THREE.CanvasTexture(canvas);
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.colorSpace = THREE.SRGBColorSpace;

        const envMap = this._pmremGenerator.fromEquirectangular(tex).texture;
        this.scene.environment = envMap;
        this.scene.environment.intensity = this._envIntensity;
        tex.dispose();
    }

    _loadHDRI(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const buffer = e.target.result;
            const blob = new Blob([buffer]);
            const url = URL.createObjectURL(blob);

            this._rgbeLoader.load(url, (texture) => {
                const envMap = this._pmremGenerator.fromEquirectangular(texture).texture;
                this.scene.environment = envMap;
                texture.dispose();
                URL.revokeObjectURL(url);
                console.log('HDRI loaded');
            });
        };
        reader.readAsArrayBuffer(file);
    }

    _setEnvIntensity(value) {
        this._envIntensity = value;
        if (this.scene.environment) {
            // Update all materials' envMapIntensity
            this.scene.traverse(child => {
                if (child.isMesh && child.material) {
                    child.material.envMapIntensity = value;
                }
            });
        }
    }

    _setEnvBackground(show) {
        if (show && this.scene.environment) {
            this.scene.background = this.scene.environment;
        } else {
            this.scene.background = new THREE.Color(
                this.scene.background?.isColor ? this.scene.background : 0x1a1a2e
            );
        }
    }

    // --- Light Presets ---

    _applyLightPreset(name) {
        const preset = LIGHT_PRESETS[name];
        if (!preset) return;

        // Remove old dynamic lights
        for (const light of this._dynamicLights) {
            this.scene.remove(light);
            if (light.dispose) light.dispose();
        }
        this._dynamicLights = [];

        // Remove old ambient
        if (this._ambientLight) {
            this.scene.remove(this._ambientLight);
        }

        // Add ambient
        this._ambientLight = new THREE.AmbientLight(preset.ambient.color, preset.ambient.intensity);
        this.scene.add(this._ambientLight);

        // Add lights
        for (const def of preset.lights) {
            const light = new THREE.DirectionalLight(def.color, def.intensity);
            light.position.set(...def.pos);
            if (def.shadow) {
                light.castShadow = true;
                light.shadow.mapSize.set(1024, 1024);
                light.shadow.camera.near = 0.1;
                light.shadow.camera.far = 50;
                light.shadow.camera.left = -5;
                light.shadow.camera.right = 5;
                light.shadow.camera.top = 5;
                light.shadow.camera.bottom = -5;
            }
            this.scene.add(light);
            this._dynamicLights.push(light);
        }
    }

    _scaleLightIntensity(factor) {
        for (const light of this._dynamicLights) {
            if (light.isDirectionalLight) {
                // Store base intensity on first call
                if (light._baseIntensity === undefined) {
                    light._baseIntensity = light.intensity;
                }
                light.intensity = light._baseIntensity * factor;
            }
        }
    }

    _toggleShadows(enabled) {
        this.renderer.shadowMap.enabled = enabled;
        for (const light of this._dynamicLights) {
            if (light.castShadow !== undefined) {
                light.castShadow = enabled;
            }
        }
        // Force shadow map recompile
        this.scene.traverse(child => {
            if (child.isMesh) child.material.needsUpdate = true;
        });
    }

    // --- UI Helpers ---

    _section(title, children, collapsed = true) {
        const s = document.createElement('div');
        s.className = 'mat-section';

        const h = document.createElement('div');
        h.className = 'mat-section-title mat-section-toggle';

        const arrow = document.createElement('span');
        arrow.className = 'section-arrow';
        arrow.textContent = collapsed ? '▶' : '▼';

        const lbl = document.createElement('span');
        lbl.textContent = title;

        h.appendChild(lbl);
        h.appendChild(arrow);
        s.appendChild(h);

        const content = document.createElement('div');
        content.className = 'section-content';
        if (collapsed) content.style.display = 'none';
        for (const c of children) content.appendChild(c);
        s.appendChild(content);

        h.addEventListener('click', () => {
            const hidden = content.style.display === 'none';
            content.style.display = hidden ? '' : 'none';
            arrow.textContent = hidden ? '▼' : '▶';
        });

        return s;
    }

    _slider(label, value, min, max, step, onChange) {
        const row = document.createElement('div');
        row.className = 'mat-row';
        const lbl = document.createElement('span');
        lbl.className = 'mat-label';
        lbl.textContent = label;
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = min; slider.max = max; slider.step = step; slider.value = value;
        slider.className = 'mat-slider';
        const val = document.createElement('span');
        val.className = 'mat-slider-value';
        val.textContent = parseFloat(value).toFixed(2);
        slider.addEventListener('input', () => {
            val.textContent = parseFloat(slider.value).toFixed(2);
            onChange(parseFloat(slider.value));
        });
        row.appendChild(lbl); row.appendChild(slider); row.appendChild(val);
        return row;
    }

    _fileUpload(label, accept, onFile) {
        const row = document.createElement('div');
        row.className = 'mat-row';
        const lbl = document.createElement('span');
        lbl.className = 'mat-label';
        lbl.textContent = label;
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = accept;
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => {
            if (fileInput.files[0]) onFile(fileInput.files[0]);
        });
        const btn = document.createElement('button');
        btn.className = 'mat-btn';
        btn.textContent = '📁';
        btn.title = 'Load file';
        btn.addEventListener('click', () => fileInput.click());
        row.appendChild(lbl);
        row.appendChild(btn);
        row.appendChild(fileInput);
        return row;
    }

    _colorPicker(label, colorValue, onChange) {
        const row = document.createElement('div');
        row.className = 'mat-row';
        const lbl = document.createElement('span');
        lbl.className = 'mat-label';
        lbl.textContent = label;
        const picker = document.createElement('input');
        picker.type = 'color';
        picker.className = 'mat-color-picker';
        picker.value = '#' + (colorValue.getHexString ? colorValue.getHexString() : new THREE.Color(colorValue).getHexString());
        picker.addEventListener('input', () => onChange(picker.value));
        row.appendChild(lbl); row.appendChild(picker);
        return row;
    }

    _checkbox(label, checked, onChange) {
        const row = document.createElement('div');
        row.className = 'mat-row';
        const lbl = document.createElement('span');
        lbl.className = 'mat-label';
        lbl.textContent = label;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'mat-checkbox';
        cb.checked = checked;
        cb.addEventListener('change', () => onChange(cb.checked));
        row.appendChild(lbl); row.appendChild(cb);
        return row;
    }

    _dropdown(label, options, defaultVal, onChange) {
        const row = document.createElement('div');
        row.className = 'mat-row';
        const lbl = document.createElement('span');
        lbl.className = 'mat-label';
        lbl.textContent = label;
        const select = document.createElement('select');
        select.className = 'category-select';
        select.style.flex = '1';
        for (const opt of options) {
            const o = document.createElement('option');
            o.value = opt; o.textContent = opt;
            if (opt === defaultVal) o.selected = true;
            select.appendChild(o);
        }
        select.addEventListener('change', () => onChange(select.value));
        row.appendChild(lbl); row.appendChild(select);
        return row;
    }
}
