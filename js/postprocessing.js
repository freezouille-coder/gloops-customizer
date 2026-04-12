import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';

// ---- Custom Shaders ----

const VignetteShader = {
    uniforms: { tDiffuse: { value: null }, offset: { value: 1.0 }, darkness: { value: 1.2 } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
        uniform sampler2D tDiffuse; uniform float offset; uniform float darkness; varying vec2 vUv;
        void main() {
            vec4 c = texture2D(tDiffuse, vUv);
            vec2 uv = (vUv - 0.5) * vec2(offset);
            c.rgb *= mix(1.0, clamp(1.0 - dot(uv,uv), 0.0, 1.0), darkness);
            gl_FragColor = c;
        }`
};

const GrainShader = {
    uniforms: {
        tDiffuse: { value: null },
        amount: { value: 0.08 },
        scale: { value: 1.0 },
        time: { value: 0 },
        colorNoise: { value: 0.0 }, // 0 = B&W, 1 = RGB
    },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float amount;
        uniform float scale;
        uniform float time;
        uniform float colorNoise;
        varying vec2 vUv;
        float hash(vec2 p) {
            vec3 p3 = fract(vec3(p.xyx) * 0.1031);
            p3 += dot(p3, p3.yzx + 33.33);
            return fract((p3.x + p3.y) * p3.z);
        }
        void main() {
            vec4 c = texture2D(tDiffuse, vUv);
            vec2 seed = floor(vUv * scale * 512.0) + floor(time * 10.0);
            if (colorNoise > 0.5) {
                // RGB noise — different noise per channel
                c.r += (hash(seed + 0.0) - 0.5) * amount;
                c.g += (hash(seed + 100.0) - 0.5) * amount;
                c.b += (hash(seed + 200.0) - 0.5) * amount;
            } else {
                // B&W noise — same noise all channels
                float n = (hash(seed) - 0.5) * amount;
                c.rgb += n;
            }
            gl_FragColor = clamp(c, 0.0, 1.0);
        }`
};

const PixelizeShader = {
    uniforms: {
        tDiffuse: { value: null },
        resolution: { value: new THREE.Vector2(1, 1) },
        pixelSize: { value: 1.0 },
    },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec2 resolution;
        uniform float pixelSize;
        varying vec2 vUv;
        void main() {
            if (pixelSize <= 1.0) {
                gl_FragColor = texture2D(tDiffuse, vUv);
                return;
            }
            vec2 dxy = pixelSize / resolution;
            vec2 coord = dxy * floor(vUv / dxy) + dxy * 0.5;
            gl_FragColor = texture2D(tDiffuse, coord);
        }`
};

const ChromaticAberrationShader = {
    uniforms: { tDiffuse: { value: null }, amount: { value: 0.003 } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
        uniform sampler2D tDiffuse; uniform float amount; varying vec2 vUv;
        void main() {
            vec2 dir = vUv - 0.5;
            float r = texture2D(tDiffuse, vUv + dir * amount).r;
            float g = texture2D(tDiffuse, vUv).g;
            float b = texture2D(tDiffuse, vUv - dir * amount).b;
            float a = texture2D(tDiffuse, vUv).a;
            gl_FragColor = vec4(r, g, b, a);
        }`
};

const SharpenShader = {
    uniforms: { tDiffuse: { value: null }, amount: { value: 0.5 }, resolution: { value: new THREE.Vector2(1, 1) } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
        uniform sampler2D tDiffuse; uniform float amount; uniform vec2 resolution; varying vec2 vUv;
        void main() {
            vec2 step = 1.0 / resolution;
            vec4 c = texture2D(tDiffuse, vUv);
            vec4 n = texture2D(tDiffuse, vUv + vec2(0, step.y));
            vec4 s = texture2D(tDiffuse, vUv - vec2(0, step.y));
            vec4 e = texture2D(tDiffuse, vUv + vec2(step.x, 0));
            vec4 w = texture2D(tDiffuse, vUv - vec2(step.x, 0));
            vec4 sharp = c * (1.0 + 4.0 * amount) - (n + s + e + w) * amount;
            gl_FragColor = clamp(sharp, 0.0, 1.0);
        }`
};

const ColorBalanceShader = {
    uniforms: {
        tDiffuse: { value: null },
        shadows: { value: new THREE.Vector3(0, 0, 0) },
        midtones: { value: new THREE.Vector3(0, 0, 0) },
        highlights: { value: new THREE.Vector3(0, 0, 0) },
        brightness: { value: 0 },
        contrast: { value: 0 },
        saturation: { value: 1 },
    },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec3 shadows, midtones, highlights;
        uniform float brightness, contrast, saturation;
        varying vec2 vUv;
        void main() {
            vec4 c = texture2D(tDiffuse, vUv);
            float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
            // Color balance
            float sw = 1.0 - smoothstep(0.0, 0.5, lum);
            float hw = smoothstep(0.5, 1.0, lum);
            float mw = 1.0 - sw - hw;
            c.rgb += shadows * sw + midtones * mw + highlights * hw;
            // Brightness & contrast
            c.rgb += brightness;
            c.rgb = (c.rgb - 0.5) * (1.0 + contrast) + 0.5;
            // Saturation
            float grey = dot(c.rgb, vec3(0.299, 0.587, 0.114));
            c.rgb = mix(vec3(grey), c.rgb, saturation);
            gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), c.a);
        }`
};


export class PostProcessing {
    constructor(renderer, scene, camera) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;

        const size = renderer.getSize(new THREE.Vector2());
        this.composer = new EffectComposer(renderer);

        // 1. Render
        this.renderPass = new RenderPass(scene, camera);
        this.composer.addPass(this.renderPass);

        // 2. SSAO
        this.ssaoPass = new SSAOPass(scene, camera, size.x, size.y);
        this.ssaoPass.kernelRadius = 16;
        this.ssaoPass.minDistance = 0.005;
        this.ssaoPass.maxDistance = 0.1;
        this.ssaoPass.output = SSAOPass.OUTPUT.Default;
        this.ssaoPass.enabled = false;
        this.composer.addPass(this.ssaoPass);

        // 3. Outline
        this.outlinePass = new OutlinePass(new THREE.Vector2(size.x, size.y), scene, camera);
        this.outlinePass.edgeStrength = 3;
        this.outlinePass.edgeGlow = 0;
        this.outlinePass.edgeThickness = 1;
        this.outlinePass.visibleEdgeColor.set(0x222222);
        this.outlinePass.hiddenEdgeColor.set(0x222222);
        this.outlinePass.enabled = false;
        this.composer.addPass(this.outlinePass);

        // 4. Bloom
        this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.3, 0.4, 0.85);
        this.bloomPass.enabled = false;
        this.composer.addPass(this.bloomPass);

        // 5. Color Balance
        this.colorBalancePass = new ShaderPass(ColorBalanceShader);
        this.colorBalancePass.enabled = false;
        this.composer.addPass(this.colorBalancePass);

        // 5. Sharpen
        this.sharpenPass = new ShaderPass(SharpenShader);
        this.sharpenPass.uniforms.resolution.value.set(size.x, size.y);
        this.sharpenPass.enabled = false;
        this.composer.addPass(this.sharpenPass);

        // 6. Chromatic Aberration
        this.chromaPass = new ShaderPass(ChromaticAberrationShader);
        this.chromaPass.enabled = false;
        this.composer.addPass(this.chromaPass);

        // 7. Grain
        this.grainPass = new ShaderPass(GrainShader);
        this.grainPass.enabled = false;
        this.composer.addPass(this.grainPass);

        // 8. Pixelise
        this.pixelPass = new ShaderPass(PixelizeShader);
        this.pixelPass.uniforms.resolution.value.set(size.x, size.y);
        this.pixelPass.enabled = false;
        this.composer.addPass(this.pixelPass);

        // 9. Vignette
        this.vignettePass = new ShaderPass(VignetteShader);
        this.vignettePass.enabled = false;
        this.composer.addPass(this.vignettePass);

        // 10. SMAA
        this.smaaPass = new SMAAPass(size.x, size.y);
        this.smaaPass.enabled = true;
        this.composer.addPass(this.smaaPass);

        // 10. Output
        this.outputPass = new OutputPass();
        this.composer.addPass(this.outputPass);

        this._clock = new THREE.Clock();
    }

    resize(width, height) {
        this.composer.setSize(width, height);
        this.sharpenPass.uniforms.resolution.value.set(width, height);
        this.pixelPass.uniforms.resolution.value.set(width, height);
    }

    render() {
        // Update grain time
        this.grainPass.uniforms.time.value = this._clock.getElapsedTime();
        this.composer.render();
    }

    // --- SSAO ---
    setSSAO(v) { this.ssaoPass.enabled = v; }
    setSSAORadius(v) { this.ssaoPass.kernelRadius = v; }
    setSSAOIntensity(v) {
        this.ssaoPass.minDistance = 0.001;
        this.ssaoPass.maxDistance = v;
    }

    // --- Bloom ---
    setBloom(v) { this.bloomPass.enabled = v; }
    setBloomStrength(v) { this.bloomPass.strength = v; }
    setBloomRadius(v) { this.bloomPass.radius = v; }
    setBloomThreshold(v) { this.bloomPass.threshold = v; }

    // --- Vignette ---
    setVignette(v) { this.vignettePass.enabled = v; }
    setVignetteDarkness(v) { this.vignettePass.uniforms.darkness.value = v; }

    // --- SMAA ---
    setSMAA(v) { this.smaaPass.enabled = v; }

    // --- Grain ---
    setGrain(v) { this.grainPass.enabled = v; }
    setGrainAmount(v) { this.grainPass.uniforms.amount.value = v; }
    setGrainScale(v) { this.grainPass.uniforms.scale.value = v; }
    setGrainColorNoise(v) { this.grainPass.uniforms.colorNoise.value = v ? 1.0 : 0.0; }

    // --- Pixelise ---
    setPixelise(v) { this.pixelPass.enabled = v; }
    setPixelSize(v) { this.pixelPass.uniforms.pixelSize.value = v; }

    // --- Sharpen ---
    setSharpen(v) { this.sharpenPass.enabled = v; }
    setSharpenAmount(v) { this.sharpenPass.uniforms.amount.value = v; }

    // --- Chromatic Aberration ---
    setChroma(v) { this.chromaPass.enabled = v; }
    setChromaAmount(v) { this.chromaPass.uniforms.amount.value = v; }

    // --- Color Balance ---
    setColorBalance(v) { this.colorBalancePass.enabled = v; }
    setColorBalanceShadows(r, g, b) { this.colorBalancePass.uniforms.shadows.value.set(r, g, b); }
    setColorBalanceMidtones(r, g, b) { this.colorBalancePass.uniforms.midtones.value.set(r, g, b); }
    setColorBalanceHighlights(r, g, b) { this.colorBalancePass.uniforms.highlights.value.set(r, g, b); }
    setBrightness(v) { this.colorBalancePass.uniforms.brightness.value = v; }
    setContrast(v) { this.colorBalancePass.uniforms.contrast.value = v; }
    setSaturation(v) { this.colorBalancePass.uniforms.saturation.value = v; }

    // --- Outline ---
    setOutlineObjects(objects) { this.outlinePass.selectedObjects = objects; }
    setOutline(v) { this.outlinePass.enabled = v; }
    setOutlineThickness(v) { this.outlinePass.edgeThickness = v; }
    setOutlineStrength(v) { this.outlinePass.edgeStrength = v; }
    setOutlineGlow(v) { this.outlinePass.edgeGlow = v; }
    setOutlineColor(c) {
        this.outlinePass.visibleEdgeColor.set(c);
        this.outlinePass.hiddenEdgeColor.set(c);
    }
}
