import * as THREE from 'three';

/**
 * Material entry managed by ShadingManager.
 */
class MaterialEntry {
    constructor(name, meshes, material) {
        this.name = name;
        this.meshes = meshes;       // Array of meshes sharing this material
        this.material = material;    // MeshStandardMaterial

        // BlendColor state
        this.colorA = material.color ? material.color.clone() : new THREE.Color(1, 1, 1);
        this.colorB = new THREE.Color(0, 0, 0);
        this.mapA = null;    // Image element or null
        this.mapB = null;
        this.mask = null;
        this.flipV = true;   // Flip V for Maya FBX UVs (1-v)

        // RGB mask: 3 channels (R, G, B), each with Color A + B + Texture A/B
        this.rgbMask = null;
        this.rgbColorsA = [new THREE.Color(1,1,1), new THREE.Color(1,1,1), new THREE.Color(1,1,1)];
        this.rgbColorsB = [new THREE.Color(1,1,1), new THREE.Color(1,1,1), new THREE.Color(1,1,1)];
        this.rgbTexturesA = [null, null, null];
        this.rgbTexturesB = [null, null, null];
        this.rgbTexPathsA = [null, null, null];
        this.rgbTexPathsB = [null, null, null];
        // Diffuse weight texture (greyscale, multiplies diffuse output)
        this.diffuseWeightMap = null;

        // Pattern system
        this.patternMap = null;          // current pattern Image
        this.patternMode = 'casual';     // 'casual', 'luxury'
        this.patternIntensity = 0.5;     // 0-1
        this.patternBumpScale = 0.05;
        this.patternHueShift = 0;        // -180 to 180 degrees
        this.patternSatShift = 0;        // -1 to 1
        this._patternVariants = [];      // [{path, id, variant}]

        // Blend canvas for compositing
        this._canvas = document.createElement('canvas');
        this._canvas.width = 512;
        this._canvas.height = 512;
        this._ctx = this._canvas.getContext('2d');
        this._blendTexture = null;
    }
}

export class ShadingManager {
    constructor() {
        this.entries = new Map(); // materialName -> MaterialEntry
        this.textureLoader = new THREE.TextureLoader();
    }

    /**
     * Scan the model, collect all materials, replace with clean PBR materials.
     */
    scanModel(model, opts = {}) {
        // Maya FBX has V-flipped UVs (0=top). When Blender re-exports as
        // glTF it normalises them to the spec (V=0 at bottom) → GLB meshes
        // need flipV = false, FBX meshes need flipV = true.
        // character.js tags the loaded object with userData.isGLB / isFBX
        // so we can auto-detect here. Caller can still force via opts.flipV.
        let flipV;
        if (opts.flipV !== undefined) {
            flipV = opts.flipV;
        } else if (model.userData && model.userData.isGLB) {
            flipV = false;
        } else {
            flipV = true; // default = Maya/FBX convention
        }
        this._defaultFlipV = flipV;    // props will inherit this
        const matMap = new Map(); // material uuid -> { name, meshes }

        model.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = true;
            child.receiveShadow = true;

            const oldMat = child.material;
            if (!oldMat) return;

            const matKey = oldMat.uuid;

            if (matMap.has(matKey)) {
                matMap.get(matKey).meshes.push(child);
                return;
            }

            matMap.set(matKey, {
                oldMat,
                name: oldMat.name || child.name || `mat_${matMap.size}`,
                meshes: [child]
            });
        });

        for (const [uuid, info] of matMap) {
            const { oldMat, name, meshes } = info;

            // Create MeshPhysicalMaterial (extends Standard with SSS, Sheen, Clearcoat)
            const color = new THREE.Color(0xffffff); // Default white

            const newMat = new THREE.MeshPhysicalMaterial({
                color: color,
                // Force full roughness on all Gloops mats — the incoming
                // material values from GLB often come through as 0.5 or
                // similar, which looks plasticky on the character.
                roughness: 1.0,
                metalness: oldMat.metalness !== undefined ? oldMat.metalness : 0,
                name: name,
                // SSS defaults
                thickness: 0,
                transmission: 0,
                // Sheen
                sheen: 0,
                sheenRoughness: 0.5,
                sheenColor: new THREE.Color(1, 1, 1),
                // Clearcoat
                clearcoat: 0,
                clearcoatRoughness: 0,
                // IOR
                ior: 1.5,
                // SSS attenuation (skin-like)
                attenuationColor: new THREE.Color(0.8, 0.3, 0.2),
                attenuationDistance: 0.5,
                // Specular
                specularIntensity: 1.0,
                specularColor: new THREE.Color(1, 1, 1),
            });

            // Apply to all meshes using this material
            for (const mesh of meshes) {
                mesh.material = newMat;
            }

            const entry = new MaterialEntry(name, meshes, newMat);
            entry.flipV = flipV;   // set per load (false for GLB, true for FBX)
            this.entries.set(name, entry);
        }

        console.log(
            `ShadingManager: ${this.entries.size} materials (flipV=${flipV}):`,
            [...this.entries.keys()]
        );
    }

    // ----- BlendColor: CPU-side canvas compositing -----

    /**
     * Recompute the blend texture for a material.
     * result = mix(colorA/mapA, colorB/mapB, mask)
     */
    _updateBlend(entry) {
        const { _canvas: canvas, _ctx: ctx } = entry;
        const w = canvas.width;
        const h = canvas.height;

        // === Unified diffuse compositing ===
        // Without RGB mask: treat as if full R channel (R=1, G=0, B=0)
        // So R-Color A = the simple diffuse color/texture
        // With RGB mask: 3 zones with their own colors

        // Step 1: Read RGB mask (or generate full-red default)
        let rgbData = null;
        if (entry.rgbMask) {
            const mc = document.createElement('canvas'); mc.width = w; mc.height = h;
            const mctx = mc.getContext('2d');
            mctx.drawImage(entry.rgbMask, 0, 0, w, h);
            rgbData = mctx.getImageData(0, 0, w, h);
        }

        // Step 2: Read B&W blend mask (optional)
        let blendData = null;
        if (entry.mask) {
            const bc = document.createElement('canvas'); bc.width = w; bc.height = h;
            const bctx = bc.getContext('2d');
            bctx.drawImage(entry.mask, 0, 0, w, h);
            blendData = bctx.getImageData(0, 0, w, h);
        }

        // Step 3: Check if R-Color A has a texture (rgbTexturesA[0])
        // If so, draw it as base; otherwise use flat color
        const rColorA = entry.rgbColorsA[0];
        const rTexA = entry.rgbTexturesA ? entry.rgbTexturesA[0] : null;

        if (rTexA) {
            ctx.drawImage(rTexA, 0, 0, w, h);
        } else {
            ctx.fillStyle = '#' + rColorA.getHexString();
            ctx.fillRect(0, 0, w, h);
        }

        // Step 4: Apply zone colors/textures
        if (rgbData) {
            // RGB Mask mode: 3 zones (R, G, B channels)
            const baseData = ctx.getImageData(0, 0, w, h);
            const colorsA = entry.rgbColorsA;
            const colorsB = entry.rgbColorsB;
            const NUM_CH = 3;

            const chDataA = new Array(NUM_CH).fill(null);
            const chDataB = new Array(NUM_CH).fill(null);
            for (let ch = 0; ch < NUM_CH; ch++) {
                if (entry.rgbTexturesA[ch]) {
                    const tc = document.createElement('canvas'); tc.width = w; tc.height = h;
                    tc.getContext('2d').drawImage(entry.rgbTexturesA[ch], 0, 0, w, h);
                    chDataA[ch] = tc.getContext('2d').getImageData(0, 0, w, h);
                }
                if (entry.rgbTexturesB[ch]) {
                    const tc = document.createElement('canvas'); tc.width = w; tc.height = h;
                    tc.getContext('2d').drawImage(entry.rgbTexturesB[ch], 0, 0, w, h);
                    chDataB[ch] = tc.getContext('2d').getImageData(0, 0, w, h);
                }
            }

            // Check which channels are "neutral" (white color, no texture = passthrough)
            const isNeutralA = colorsA.map((c, ch) =>
                !chDataA[ch] && c.r > 0.99 && c.g > 0.99 && c.b > 0.99);
            const isNeutralB = colorsB.map((c, ch) =>
                !chDataB[ch] && c.r > 0.99 && c.g > 0.99 && c.b > 0.99);

            for (let i = 0; i < baseData.data.length; i += 4) {
                const weights = [rgbData.data[i]/255, rgbData.data[i+1]/255, rgbData.data[i+2]/255];
                const total = weights[0] + weights[1] + weights[2];
                if (total > 0.01) {
                    const t = blendData ? blendData.data[i] / 255 : 0;

                    let allNeutral = true;
                    for (let ch = 0; ch < NUM_CH; ch++) {
                        if (weights[ch] / total > 0.01) {
                            if (!(isNeutralA[ch] && isNeutralB[ch])) {
                                allNeutral = false;
                                break;
                            }
                        }
                    }
                    if (allNeutral) continue;

                    let fR = 0, fG = 0, fB = 0;
                    for (let ch = 0; ch < NUM_CH; ch++) {
                        const nw = weights[ch] / total;
                        if (nw < 0.001) continue;

                        // If this channel is neutral, use base pixel
                        if (isNeutralA[ch] && isNeutralB[ch]) {
                            fR += (baseData.data[i]/255) * nw;
                            fG += (baseData.data[i+1]/255) * nw;
                            fB += (baseData.data[i+2]/255) * nw;
                            continue;
                        }

                        // Sample A
                        const aR = chDataA[ch] ? chDataA[ch].data[i]/255 : colorsA[ch].r;
                        const aG = chDataA[ch] ? chDataA[ch].data[i+1]/255 : colorsA[ch].g;
                        const aB = chDataA[ch] ? chDataA[ch].data[i+2]/255 : colorsA[ch].b;
                        // Sample B
                        const bR = chDataB[ch] ? chDataB[ch].data[i]/255 : colorsB[ch].r;
                        const bG = chDataB[ch] ? chDataB[ch].data[i+1]/255 : colorsB[ch].g;
                        const bB2 = chDataB[ch] ? chDataB[ch].data[i+2]/255 : colorsB[ch].b;
                        // Blend A/B by mask
                        fR += (aR*(1-t) + bR*t) * nw;
                        fG += (aG*(1-t) + bG*t) * nw;
                        fB += (aB*(1-t) + bB2*t) * nw;
                    }
                    baseData.data[i]   = baseData.data[i]*(1-total) + fR*255*total;
                    baseData.data[i+1] = baseData.data[i+1]*(1-total) + fG*255*total;
                    baseData.data[i+2] = baseData.data[i+2]*(1-total) + fB*255*total;
                }
            }
            ctx.putImageData(baseData, 0, 0);
        } else if (blendData) {
            // Simple mode: blend R-Color A with R-Color B via mask
            const baseData = ctx.getImageData(0, 0, w, h);
            const rTexB = entry.rgbTexturesB ? entry.rgbTexturesB[0] : null;
            const rColB = entry.rgbColorsB[0];
            let bPixels = null;
            if (rTexB) {
                const tc = document.createElement('canvas'); tc.width = w; tc.height = h;
                tc.getContext('2d').drawImage(rTexB, 0, 0, w, h);
                bPixels = tc.getContext('2d').getImageData(0, 0, w, h);
            }
            for (let i = 0; i < baseData.data.length; i += 4) {
                const t = blendData.data[i] / 255;
                if (t > 0.001) {
                    const br = bPixels ? bPixels.data[i]/255 : rColB.r;
                    const bg = bPixels ? bPixels.data[i+1]/255 : rColB.g;
                    const bb = bPixels ? bPixels.data[i+2]/255 : rColB.b;
                    baseData.data[i]   = baseData.data[i]*(1-t) + br*255*t;
                    baseData.data[i+1] = baseData.data[i+1]*(1-t) + bg*255*t;
                    baseData.data[i+2] = baseData.data[i+2]*(1-t) + bb*255*t;
                }
            }
            ctx.putImageData(baseData, 0, 0);
        }

        // Apply diffuse weight (slider + texture map)
        const dw = entry.diffuseWeight !== undefined ? entry.diffuseWeight : 1;
        if (dw < 1 || entry.diffuseWeightMap) {
            const data = ctx.getImageData(0, 0, w, h);
            let wMapData = null;
            if (entry.diffuseWeightMap) {
                const wc = document.createElement('canvas'); wc.width = w; wc.height = h;
                wc.getContext('2d').drawImage(entry.diffuseWeightMap, 0, 0, w, h);
                wMapData = wc.getContext('2d').getImageData(0, 0, w, h);
            }
            for (let i = 0; i < data.data.length; i += 4) {
                let weight = dw;
                if (wMapData) weight *= wMapData.data[i] / 255; // red channel
                data.data[i]   *= weight;
                data.data[i+1] *= weight;
                data.data[i+2] *= weight;
            }
            ctx.putImageData(data, 0, 0);
        }

        // Apply pattern on diffuse (both Casual and Luxury apply hue/sat shift)
        // Pattern is masked by RGB mask channel (patternChannel: 'R'=0, 'G'=1, 'B'=2)
        if (entry.patternMap) {
            const data = ctx.getImageData(0, 0, w, h);
            const pc = document.createElement('canvas'); pc.width = w; pc.height = h;
            pc.getContext('2d').drawImage(entry.patternMap, 0, 0, w, h);
            const pData = pc.getContext('2d').getImageData(0, 0, w, h);
            const intensity = entry.patternIntensity;
            const hueShift = entry.patternHueShift || 0;
            const satShift = entry.patternSatShift || 0;
            const isCasual = entry.patternMode === 'casual';

            // Get RGB mask for channel restriction
            let rgbMaskData = null;
            const patCh = entry._patternChannel; // 0=R, 1=G, 2=B, undefined=all
            if (patCh !== undefined && entry.rgbMask) {
                const mc = document.createElement('canvas'); mc.width = w; mc.height = h;
                mc.getContext('2d').drawImage(entry.rgbMask, 0, 0, w, h);
                rgbMaskData = mc.getContext('2d').getImageData(0, 0, w, h);
            }

            for (let i = 0; i < data.data.length; i += 4) {
                let p = pData.data[i] / 255;
                if (p < 0.01) continue;

                // Restrict pattern to specific RGB mask channel
                if (rgbMaskData && patCh !== undefined) {
                    const channelWeight = rgbMaskData.data[i + patCh] / 255;
                    p *= channelWeight;
                    if (p < 0.01) continue;
                }

                const amount = p * intensity;
                let r = data.data[i] / 255;
                let g = data.data[i+1] / 255;
                let b = data.data[i+2] / 255;

                // Casual: darken
                if (isCasual) {
                    const darken = 1 - (amount * 0.6);
                    r *= darken; g *= darken; b *= darken;
                }

                // Hue/Sat shift (only where pattern is active)
                if ((hueShift !== 0 || satShift !== 0) && amount > 0.01) {
                    // RGB to HSL
                    const max = Math.max(r, g, b), min = Math.min(r, g, b);
                    let h, s, l = (max + min) / 2;

                    if (max === min) {
                        h = s = 0;
                    } else {
                        const d = max - min;
                        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
                        else if (max === g) h = ((b - r) / d + 2) / 6;
                        else h = ((r - g) / d + 4) / 6;
                    }

                    // Apply shifts (lerped by pattern amount)
                    h = (h + (hueShift / 360) * amount) % 1;
                    if (h < 0) h += 1;
                    s = Math.max(0, Math.min(1, s + satShift * amount));

                    // HSL to RGB
                    const hue2rgb = (p2, q2, t2) => {
                        if (t2 < 0) t2 += 1;
                        if (t2 > 1) t2 -= 1;
                        if (t2 < 1/6) return p2 + (q2 - p2) * 6 * t2;
                        if (t2 < 1/2) return q2;
                        if (t2 < 2/3) return p2 + (q2 - p2) * (2/3 - t2) * 6;
                        return p2;
                    };

                    if (s === 0) {
                        r = g = b = l;
                    } else {
                        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                        const p2 = 2 * l - q;
                        r = hue2rgb(p2, q, h + 1/3);
                        g = hue2rgb(p2, q, h);
                        b = hue2rgb(p2, q, h - 1/3);
                    }
                }

                data.data[i]   = Math.max(0, Math.min(255, r * 255));
                data.data[i+1] = Math.max(0, Math.min(255, g * 255));
                data.data[i+2] = Math.max(0, Math.min(255, b * 255));
            }
            ctx.putImageData(data, 0, 0);
        }

        // Flip V if needed (Maya FBX has inverted V)
        if (entry.flipV) {
            const flipped = document.createElement('canvas');
            flipped.width = w;
            flipped.height = h;
            const fCtx = flipped.getContext('2d');
            fCtx.translate(0, h);
            fCtx.scale(1, -1);
            fCtx.drawImage(canvas, 0, 0);
            // Use flipped canvas for the texture
            if (entry._blendTexture) entry._blendTexture.dispose();
            entry._blendTexture = new THREE.CanvasTexture(flipped);
        } else {
            if (entry._blendTexture) entry._blendTexture.dispose();
            entry._blendTexture = new THREE.CanvasTexture(canvas);
        }

        entry._blendTexture.colorSpace = THREE.SRGBColorSpace;
        entry._blendTexture.flipY = false;

        entry.material.map = entry._blendTexture;
        entry.material.color.set(0xffffff);

        // Sync emissive if using base color
        if (entry._emissiveUseBaseColor) {
            this._updateEmissiveMap(entry);
        }

        // Sync sheen color from base color (hue only, reduced sat, max value)
        if (entry._sheenUseBaseColor) {
            // Sample average color from the composited canvas
            const sampleData = ctx.getImageData(0, 0, w, h);
            let rAvg = 0, gAvg = 0, bAvg = 0, count = 0;
            const step = 8; // sample every 8th pixel for speed
            for (let si = 0; si < sampleData.data.length; si += 4 * step) {
                rAvg += sampleData.data[si]; gAvg += sampleData.data[si+1]; bAvg += sampleData.data[si+2];
                count++;
            }
            if (count > 0) {
                rAvg /= count * 255; gAvg /= count * 255; bAvg /= count * 255;
                // RGB to HSL
                const max = Math.max(rAvg, gAvg, bAvg), min = Math.min(rAvg, gAvg, bAvg);
                let h = 0, s = 0;
                if (max !== min) {
                    const d = max - min;
                    s = d / (max + min > 1 ? 2 - max - min : max + min);
                    if (max === rAvg) h = ((gAvg - bAvg) / d + (gAvg < bAvg ? 6 : 0)) / 6;
                    else if (max === gAvg) h = ((bAvg - rAvg) / d + 2) / 6;
                    else h = ((rAvg - gAvg) / d + 4) / 6;
                }
                // Apply: keep hue, reduce saturation, max lightness (value=1)
                const satMult = entry._sheenSatMult || 0.5;
                const newS = s * satMult;
                const newL = 0.75; // bright sheen
                // HSL to RGB
                const hue2rgb = (p2, q2, t2) => {
                    if (t2 < 0) t2 += 1; if (t2 > 1) t2 -= 1;
                    if (t2 < 1/6) return p2 + (q2 - p2) * 6 * t2;
                    if (t2 < 1/2) return q2;
                    if (t2 < 2/3) return p2 + (q2 - p2) * (2/3 - t2) * 6;
                    return p2;
                };
                let sr, sg, sb;
                if (newS === 0) { sr = sg = sb = newL; }
                else {
                    const q = newL < 0.5 ? newL * (1 + newS) : newL + newS - newL * newS;
                    const p2 = 2 * newL - q;
                    sr = hue2rgb(p2, q, h + 1/3);
                    sg = hue2rgb(p2, q, h);
                    sb = hue2rgb(p2, q, h - 1/3);
                }
                entry.material.sheenColor.setRGB(sr, sg, sb);
            }
        }

        entry.material.needsUpdate = true;
    }

    /**
     * Clear the blend texture and revert to flat color A.
     */
    _clearBlend(entry) {
        if (entry._blendTexture) {
            entry._blendTexture.dispose();
            entry._blendTexture = null;
        }
        entry.material.map = null;
        const dw = entry.diffuseWeight !== undefined ? entry.diffuseWeight : 1;
        // Use R-Color A as the default diffuse
        entry.material.color.copy(entry.rgbColorsA[0]).multiplyScalar(dw);
        entry.material.needsUpdate = true;
    }

    /**
     * Decide whether to use blend texture or flat color.
     */
    _refreshMaterial(name) {
        const e = this.entries.get(name);
        if (!e) return;

        const hasChannelTex = e.rgbTexturesA && e.rgbTexturesA.some(t => t !== null);
        const hasPattern = e.patternMap && e.patternMode === 'casual';
        const needsBlend = e.mapA || e.mapB || e.mask || e.rgbMask || hasChannelTex || e.diffuseWeightMap || hasPattern;
        if (needsBlend) {
            this._updateBlend(e);
        } else {
            this._clearBlend(e);
        }
    }

    // ----- Public setters -----

    setColorA(name, color) {
        const e = this.entries.get(name);
        if (!e) return;
        e.colorA.set(color);
        this._refreshMaterial(name);
    }

    setColorB(name, color) {
        const e = this.entries.get(name);
        if (!e) return;
        e.colorB.set(color);
        this._refreshMaterial(name);
    }

    setTextureA(name, img) {
        const e = this.entries.get(name);
        if (!e) return;
        e.mapA = img; // Image element or null
        this._refreshMaterial(name);
    }

    setTextureB(name, img) {
        const e = this.entries.get(name);
        if (!e) return;
        e.mapB = img;
        this._refreshMaterial(name);
    }

    setMask(name, img, path) {
        const e = this.entries.get(name);
        if (!e) return;
        e.mask = img;
        e._maskPath = path || null;
        this._refreshMaterial(name);
    }

    setRoughness(name, value) {
        const e = this.entries.get(name);
        if (!e) return;
        e.material.roughness = value;
    }

    setMetalness(name, value) {
        const e = this.entries.get(name);
        if (!e) return;
        e.material.metalness = value;
    }

    /**
     * Create a texture from an Image element, optionally V-flipping the
     * pixels so Maya/FBX UVs (0=top) match standard (0=bottom). For GLB
     * assets the UVs are already standard so we must NOT flip.
     *
     * @param {HTMLImageElement} img
     * @param {THREE.ColorSpace} colorSpace
     * @param {boolean} flip  pass entry.flipV here
     */
    _makeFlippedTexture(img, colorSpace, flip = true) {
        const w = img.width || img.naturalWidth || 512;
        const h = img.height || img.naturalHeight || 512;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (flip) {
            // Flip vertically (1-v for Maya FBX UVs)
            ctx.translate(0, h);
            ctx.scale(1, -1);
        }
        ctx.drawImage(img, 0, 0, w, h);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = colorSpace;
        tex.flipY = false;
        return tex;
    }

    setNormalMap(name, img) {
        const e = this.entries.get(name);
        if (!e) return;
        if (img) {
            e.material.normalMap = this._makeFlippedTexture(img, THREE.LinearSRGBColorSpace, e.flipV);
            // Our normal maps are authored with the DirectX convention
            // (Y = down). three.js defaults to OpenGL (Y = up). The old
            // FBX pipeline hid this because the pixel V-flip happened to
            // invert Y as a side effect. On GLB (flipV=false) we have to
            // flip Y explicitly via normalScale so lighting matches.
            e.material.normalScale.y = e.flipV ? 1 : -1;
        } else {
            e.material.normalMap = null;
        }
        e.material.needsUpdate = true;
    }

    setRoughnessMap(name, img) {
        const e = this.entries.get(name);
        if (!e) return;
        if (img) {
            e.material.roughnessMap = this._makeFlippedTexture(img, THREE.LinearSRGBColorSpace, e.flipV);
        } else {
            e.material.roughnessMap = null;
        }
        e.material.needsUpdate = true;
    }

    setMetalnessMap(name, img) {
        const e = this.entries.get(name);
        if (!e) return;
        if (img) {
            e.material.metalnessMap = this._makeFlippedTexture(img, THREE.LinearSRGBColorSpace, e.flipV);
        } else {
            e.material.metalnessMap = null;
        }
        e.material.needsUpdate = true;
    }

    setAOMap(name, img) {
        const e = this.entries.get(name);
        if (!e) return;
        if (img) {
            e.material.aoMap = this._makeFlippedTexture(img, THREE.LinearSRGBColorSpace, e.flipV);
            e.material.aoMapIntensity = 1.0;
        } else {
            e.material.aoMap = null;
        }
        e.material.needsUpdate = true;
    }

    setEmissiveMap(name, img) {
        const e = this.entries.get(name);
        if (!e) return;
        e._emissiveWeightImg = img || null;
        this._updateEmissiveMap(e);
    }

    setEmissive(name, color, intensity) {
        const e = this.entries.get(name);
        if (!e) return;
        e.material.emissive.set(color);
        e.material.emissiveIntensity = intensity;
    }

    setEmissiveUseBaseColor(name, value) {
        const e = this.entries.get(name);
        if (!e) return;
        e._emissiveUseBaseColor = value;
        if (value) {
            e.material.emissive.set(0xffffff);
        }
        this._updateEmissiveMap(e);
    }

    /**
     * Rebuild the emissive map based on current settings:
     * - Use Base Color ON + Weight Map: baseColor × weightMap
     * - Use Base Color ON, no Weight: baseColor as emissive
     * - Use Base Color OFF + Weight Map: weightMap only (tinted by emissive color)
     * - Use Base Color OFF, no Weight: no emissive map
     */
    _updateEmissiveMap(entry) {
        const useBase = entry._emissiveUseBaseColor;
        const weightImg = entry._emissiveWeightImg;

        if (!useBase && !weightImg) {
            entry.material.emissiveMap = null;
            entry.material.needsUpdate = true;
            return;
        }

        if (useBase && !weightImg) {
            // Just use the diffuse as emissive directly
            entry.material.emissiveMap = entry._blendTexture || entry.material.map || null;
            entry.material.needsUpdate = true;
            return;
        }

        // We have a weight map — need to composite
        const size = 512;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        if (useBase && entry._canvas) {
            // Use the compositing canvas (pre-flip, has the actual diffuse colors)
            ctx.drawImage(entry._canvas, 0, 0, size, size);
        } else if (useBase) {
            // Flat base color
            ctx.fillStyle = '#' + entry.rgbColorsA[0].getHexString();
            ctx.fillRect(0, 0, size, size);
        } else {
            // No base color — white (emissive color controls the tint)
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, size, size);
        }

        // Multiply by weight map
        if (weightImg) {
            const baseData = ctx.getImageData(0, 0, size, size);
            const wc = document.createElement('canvas');
            wc.width = size; wc.height = size;
            wc.getContext('2d').drawImage(weightImg, 0, 0, size, size);
            const weightData = wc.getContext('2d').getImageData(0, 0, size, size);

            for (let i = 0; i < baseData.data.length; i += 4) {
                const w = weightData.data[i] / 255; // use red channel as weight
                baseData.data[i]   *= w;
                baseData.data[i+1] *= w;
                baseData.data[i+2] *= w;
            }
            ctx.putImageData(baseData, 0, 0);
        }

        // Flip V
        if (entry.flipV) {
            const flipped = document.createElement('canvas');
            flipped.width = size; flipped.height = size;
            const fCtx = flipped.getContext('2d');
            fCtx.translate(0, size);
            fCtx.scale(1, -1);
            fCtx.drawImage(canvas, 0, 0);
            entry.material.emissiveMap = new THREE.CanvasTexture(flipped);
        } else {
            entry.material.emissiveMap = new THREE.CanvasTexture(canvas);
        }

        entry.material.emissiveMap.colorSpace = THREE.SRGBColorSpace;
        entry.material.emissiveMap.flipY = false;
        entry.material.needsUpdate = true;
    }

    // --- SSS (skin-like subsurface) ---
    setTransmission(name, v) { const e = this.entries.get(name); if (e) e.material.transmission = v; }
    setThickness(name, v) { const e = this.entries.get(name); if (e) e.material.thickness = v; }
    setIOR(name, v) { const e = this.entries.get(name); if (e) e.material.ior = v; }
    setAttenuationColor(name, c) { const e = this.entries.get(name); if (e) e.material.attenuationColor.set(c); }
    setAttenuationDistance(name, v) { const e = this.entries.get(name); if (e) e.material.attenuationDistance = v; }

    // --- Sheen ---
    setSheen(name, v) { const e = this.entries.get(name); if (e) e.material.sheen = v; }
    setSheenRoughness(name, v) { const e = this.entries.get(name); if (e) e.material.sheenRoughness = v; }
    setSheenColor(name, c) { const e = this.entries.get(name); if (e) e.material.sheenColor.set(c); }

    // --- Clearcoat ---
    setClearcoat(name, v) { const e = this.entries.get(name); if (e) e.material.clearcoat = v; }
    setClearcoatRoughness(name, v) { const e = this.entries.get(name); if (e) e.material.clearcoatRoughness = v; }

    // --- Alpha ---
    setOpacity(name, v) {
        const e = this.entries.get(name);
        if (!e) return;
        e.material.opacity = v;
        e.material.transparent = v < 1 || e.material.alphaMap !== null;
    }

    setAlphaMap(name, img) {
        const e = this.entries.get(name);
        if (!e) return;
        if (img) {
            e.material.alphaMap = this._makeFlippedTexture(img, THREE.LinearSRGBColorSpace, e.flipV);
            e.material.transparent = true;
            e.material.alphaTest = 0.01;
        } else {
            e.material.alphaMap = null;
            e.material.transparent = e.material.opacity < 1;
            e.material.alphaTest = 0;
        }
        e.material.needsUpdate = true;
    }

    // --- Flat / Unlit mode ---
    setFlat(name, value) {
        const e = this.entries.get(name);
        if (!e) return;
        e._isFlat = value;

        if (value) {
            // Save current PBR values
            e._savedPBR = {
                roughness: e.material.roughness,
                metalness: e.material.metalness,
                envMapIntensity: e.material.envMapIntensity,
                normalMap: e.material.normalMap,
                bumpMap: e.material.bumpMap,
                aoMap: e.material.aoMap,
            };
            // Set flat: max roughness, no metal, no environment, no normal/bump/ao
            e.material.roughness = 1;
            e.material.metalness = 0;
            e.material.envMapIntensity = 0;
            e.material.normalMap = null;
            e.material.bumpMap = null;
            e.material.aoMap = null;
            // Use emissive to show color without lighting
            e._emissiveUseBaseColor = true;
            e.material.emissive.set(0xffffff);
            e.material.emissiveIntensity = 1;
            this._updateEmissiveMap(e);
        } else {
            // Restore PBR values
            if (e._savedPBR) {
                e.material.roughness = e._savedPBR.roughness;
                e.material.metalness = e._savedPBR.metalness;
                e.material.envMapIntensity = e._savedPBR.envMapIntensity;
                e.material.normalMap = e._savedPBR.normalMap;
                e.material.bumpMap = e._savedPBR.bumpMap;
                e.material.aoMap = e._savedPBR.aoMap;
            }
            e._emissiveUseBaseColor = false;
            e.material.emissive.set(0x000000);
            e.material.emissiveIntensity = 0;
            e.material.emissiveMap = null;
        }
        e.material.needsUpdate = true;
    }

    // --- Diffuse / Specular Weight ---
    setDiffuseWeight(name, v) {
        const e = this.entries.get(name);
        if (!e) return;
        e.diffuseWeight = v;
        this._refreshMaterial(name);
    }

    setDiffuseWeightMap(name, img) {
        const e = this.entries.get(name);
        if (!e) return;
        e.diffuseWeightMap = img;
        this._refreshMaterial(name);
    }

    // --- Pattern ---
    setPatternMap(name, img) {
        const e = this.entries.get(name);
        if (!e) return;
        e.patternMap = img;
        this._applyPattern(e);
        this._refreshMaterial(name);
    }

    setPatternMode(name, mode) {
        const e = this.entries.get(name);
        if (!e) return;
        e.patternMode = mode; // 'off', 'casual', 'luxury'
        this._applyPattern(e);
        this._refreshMaterial(name);
    }

    setPatternIntensity(name, v) {
        const e = this.entries.get(name);
        if (!e) return;
        e.patternIntensity = v;
        this._applyPattern(e);
        this._refreshMaterial(name);
    }

    setPatternBumpScale(name, v) {
        const e = this.entries.get(name);
        if (!e) return;
        e.patternBumpScale = v;
        this._applyPattern(e);
    }

    setPatternHueShift(name, v) {
        const e = this.entries.get(name);
        if (!e) return;
        e.patternHueShift = v;
        this._refreshMaterial(name);
    }

    setPatternSatShift(name, v) {
        const e = this.entries.get(name);
        if (!e) return;
        e.patternSatShift = v;
        this._refreshMaterial(name);
    }

    /**
     * Apply pattern effects based on mode:
     * - Casual: darken diffuse (done in _updateBlend) + bump inward
     * - Luxury: add to metalness + bump outward
     * - Off: remove pattern effects
     */
    /**
     * Convert a heightmap (greyscale canvas) to a normal map using Sobel filter.
     */
    _heightToNormal(heightCanvas, strength) {
        const w = heightCanvas.width;
        const h = heightCanvas.height;
        const ctx = heightCanvas.getContext('2d');
        const hData = ctx.getImageData(0, 0, w, h).data;

        const normalCanvas = document.createElement('canvas');
        normalCanvas.width = w;
        normalCanvas.height = h;
        const nCtx = normalCanvas.getContext('2d');
        const nData = nCtx.createImageData(w, h);

        const getH = (x, y) => {
            x = Math.max(0, Math.min(w - 1, x));
            y = Math.max(0, Math.min(h - 1, y));
            return hData[(y * w + x) * 4] / 255;
        };

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                // Sobel filter for derivatives
                const tl = getH(x-1, y-1);
                const t  = getH(x,   y-1);
                const tr = getH(x+1, y-1);
                const l  = getH(x-1, y);
                const r  = getH(x+1, y);
                const bl = getH(x-1, y+1);
                const b  = getH(x,   y+1);
                const br = getH(x+1, y+1);

                const dx = (tr + 2*r + br) - (tl + 2*l + bl);
                const dy = (bl + 2*b + br) - (tl + 2*t + tr);

                // Normal vector
                let nx = -dx * strength;
                let ny = -dy * strength;
                let nz = 1.0;

                // Normalize
                const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
                nx /= len; ny /= len; nz /= len;

                // Pack to 0-255 (normal map format: 128 = 0)
                const idx = (y * w + x) * 4;
                nData.data[idx]     = Math.round((nx * 0.5 + 0.5) * 255);
                nData.data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
                nData.data[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
                nData.data[idx + 3] = 255;
            }
        }

        nCtx.putImageData(nData, 0, 0);
        return normalCanvas;
    }

    /**
     * Blend two normal maps together (overlay blending).
     */
    _blendNormals(baseCanvas, overlayCanvas, amount) {
        const w = baseCanvas.width;
        const h = baseCanvas.height;
        const bCtx = baseCanvas.getContext('2d');
        const oCtx = overlayCanvas.getContext('2d');

        // Resize overlay to match base
        const resized = document.createElement('canvas');
        resized.width = w; resized.height = h;
        resized.getContext('2d').drawImage(overlayCanvas, 0, 0, w, h);

        const bData = bCtx.getImageData(0, 0, w, h);
        const oData = resized.getContext('2d').getImageData(0, 0, w, h);
        const result = bCtx.createImageData(w, h);

        for (let i = 0; i < bData.data.length; i += 4) {
            // Unpack normals from 0-255 to -1..1
            const bn = [(bData.data[i]/255)*2-1, (bData.data[i+1]/255)*2-1, (bData.data[i+2]/255)*2-1];
            const on = [(oData.data[i]/255)*2-1, (oData.data[i+1]/255)*2-1, (oData.data[i+2]/255)*2-1];

            // Reoriented Normal Mapping blend
            let rx = bn[0] + on[0] * amount;
            let ry = bn[1] + on[1] * amount;
            let rz = bn[2] * on[2];

            const len = Math.sqrt(rx*rx + ry*ry + rz*rz) || 1;
            rx /= len; ry /= len; rz /= len;

            result.data[i]     = Math.round((rx * 0.5 + 0.5) * 255);
            result.data[i + 1] = Math.round((ry * 0.5 + 0.5) * 255);
            result.data[i + 2] = Math.round((rz * 0.5 + 0.5) * 255);
            result.data[i + 3] = 255;
        }

        const outCanvas = document.createElement('canvas');
        outCanvas.width = w; outCanvas.height = h;
        outCanvas.getContext('2d').putImageData(result, 0, 0);
        return outCanvas;
    }

    _applyPattern(entry) {
        if (!entry.patternMap) {
            // Reset metalness
            if (entry._luxuryMetalnessMap) {
                entry.material.metalnessMap = entry._originalMetalnessMap || null;
                entry.material.metalness = entry._originalMetalness !== undefined ? entry._originalMetalness : 0;
                entry._luxuryMetalnessMap = null;
            }
            // Reset normal from saved copy
            if (entry._patternNormalApplied) {
                if (entry._originalNormalMap) {
                    const tex = new THREE.CanvasTexture(entry._originalNormalMap);
                    tex.colorSpace = THREE.LinearSRGBColorSpace;
                    tex.flipY = false;
                    entry.material.normalMap = tex;
                } else {
                    entry.material.normalMap = null;
                }
                entry._patternNormalApplied = false;
            }
            entry.material.needsUpdate = true;
            return;
        }

        // If switching from luxury to casual, restore metalness
        if (entry.patternMode === 'casual' && entry._luxuryMetalnessMap) {
            entry.material.metalnessMap = entry._originalMetalnessMap || null;
            entry.material.metalness = entry._originalMetalness !== undefined ? entry._originalMetalness : 0;
            entry._luxuryMetalnessMap = null;
        }

        const size = 512;

        // Save original normal map as a COPY the first time
        if (entry._originalNormalMap === undefined) {
            if (entry.material.normalMap && entry.material.normalMap.image) {
                // Clone the canvas so we always have the clean original
                const origImg = entry.material.normalMap.image;
                const copyCanvas = document.createElement('canvas');
                copyCanvas.width = origImg.width || size;
                copyCanvas.height = origImg.height || size;
                copyCanvas.getContext('2d').drawImage(origImg, 0, 0, copyCanvas.width, copyCanvas.height);
                entry._originalNormalMap = copyCanvas;
            } else {
                entry._originalNormalMap = null;
            }
        }

        // Convert pattern heightmap to normal map
        // Flip V to match the flipped normal map from auto-connect
        const hCanvas = document.createElement('canvas');
        hCanvas.width = size; hCanvas.height = size;
        const hCtx = hCanvas.getContext('2d');
        if (entry.flipV) {
            hCtx.translate(0, size);
            hCtx.scale(1, -1);
        }
        hCtx.drawImage(entry.patternMap, 0, 0, size, size);
        hCtx.setTransform(1, 0, 0, 1, 0, 0); // reset transform

        // Invert for casual (inward)
        if (entry.patternMode === 'casual') {
            const hData = hCtx.getImageData(0, 0, size, size);
            for (let i = 0; i < hData.data.length; i += 4) {
                hData.data[i] = 255 - hData.data[i];
                hData.data[i+1] = 255 - hData.data[i+1];
                hData.data[i+2] = 255 - hData.data[i+2];
            }
            hCtx.putImageData(hData, 0, 0);
        }

        const patternNormal = this._heightToNormal(hCanvas, entry.patternBumpScale * 5);

        // Combine with existing normal map
        let finalNormal;
        if (entry._originalNormalMap) {
            // _originalNormalMap is a canvas copy of the original
            const origCanvas = document.createElement('canvas');
            origCanvas.width = size; origCanvas.height = size;
            origCanvas.getContext('2d').drawImage(entry._originalNormalMap, 0, 0, size, size);
            finalNormal = this._blendNormals(origCanvas, patternNormal, entry.patternIntensity);
        } else {
            finalNormal = patternNormal;
        }

        // DON'T flip V here — the original normal was already flipped when auto-connected.
        // The pattern heightmap is flipped before the Sobel, so the generated normal matches.
        entry.material.normalMap = new THREE.CanvasTexture(finalNormal);
        entry.material.normalMap.colorSpace = THREE.LinearSRGBColorSpace;
        entry.material.normalMap.flipY = false;
        entry._patternNormalApplied = true;

        // Luxury: composite pattern into metalness
        if (entry.patternMode === 'luxury') {
            // Save originals if not saved yet
            if (!entry._originalMetalnessMap && entry._originalMetalnessMap !== false) {
                entry._originalMetalnessMap = entry.material.metalnessMap || false;
                entry._originalMetalness = entry.material.metalness;
            }

            // Check if pattern has any content (skip if all black)
            const checkCanvas = document.createElement('canvas');
            checkCanvas.width = 16; checkCanvas.height = 16;
            checkCanvas.getContext('2d').drawImage(entry.patternMap, 0, 0, 16, 16);
            const checkData = checkCanvas.getContext('2d').getImageData(0, 0, 16, 16).data;
            let maxVal = 0;
            for (let ci = 0; ci < checkData.length; ci += 4) maxVal = Math.max(maxVal, checkData[ci]);

            if (maxVal < 5) {
                // Pattern is all black — restore original metalness
                entry.material.metalnessMap = entry._originalMetalnessMap || null;
                entry.material.metalness = entry._originalMetalness !== undefined ? entry._originalMetalness : 0;
                entry._luxuryMetalnessMap = null;
                entry.material.needsUpdate = true;
                return;
            }

            entry.material.metalness = 1;

            const metCanvas = document.createElement('canvas');
            metCanvas.width = size; metCanvas.height = size;
            const mctx = metCanvas.getContext('2d');

            // Start with existing metalness (or black if none)
            if (entry._originalMetalnessMap && entry._originalMetalnessMap.image) {
                mctx.drawImage(entry._originalMetalnessMap.image, 0, 0, size, size);
            } else {
                mctx.fillStyle = '#000000';
                mctx.fillRect(0, 0, size, size);
            }

            // Add pattern to metalness
            const metData = mctx.getImageData(0, 0, size, size);
            const pc = document.createElement('canvas'); pc.width = size; pc.height = size;
            pc.getContext('2d').drawImage(entry.patternMap, 0, 0, size, size);
            const pData = pc.getContext('2d').getImageData(0, 0, size, size);

            for (let i = 0; i < metData.data.length; i += 4) {
                const p = pData.data[i] / 255;
                const add = p * entry.patternIntensity * 255;
                metData.data[i]   = Math.min(255, metData.data[i] + add);
                metData.data[i+1] = Math.min(255, metData.data[i+1] + add);
                metData.data[i+2] = Math.min(255, metData.data[i+2] + add);
            }
            mctx.putImageData(metData, 0, 0);

            if (entry.flipV) {
                const fc = document.createElement('canvas'); fc.width = size; fc.height = size;
                const fctx = fc.getContext('2d');
                fctx.translate(0, size); fctx.scale(1, -1);
                fctx.drawImage(metCanvas, 0, 0);
                entry._luxuryMetalnessMap = new THREE.CanvasTexture(fc);
            } else {
                entry._luxuryMetalnessMap = new THREE.CanvasTexture(metCanvas);
            }
            entry._luxuryMetalnessMap.colorSpace = THREE.LinearSRGBColorSpace;
            entry._luxuryMetalnessMap.flipY = false;
            entry.material.metalnessMap = entry._luxuryMetalnessMap;
        }

        entry.material.needsUpdate = true;
    }

    // --- Bump Map (converts heightmap to normal map) ---
    setBumpMap(name, img) {
        const e = this.entries.get(name);
        if (!e) return;
        e._bumpImg = img;
        if (img) {
            e._bumpScale = e._bumpScale || 0.05;
            this._applyBumpAsNormal(e);
        } else {
            // Restore original normal
            e.material.bumpMap = null;
            if (e._originalNormalMap) {
                const tex = new THREE.CanvasTexture(e._originalNormalMap);
                tex.colorSpace = THREE.LinearSRGBColorSpace;
                tex.flipY = false;
                e.material.normalMap = tex;
            }
            e.material.needsUpdate = true;
        }
    }

    setBumpScale(name, v) {
        const e = this.entries.get(name);
        if (!e) return;
        e._bumpScale = v;
        if (e._bumpImg) {
            this._applyBumpAsNormal(e);
        }
    }

    /**
     * Convert a bump/height map to normal map and blend with existing normal.
     */
    _applyBumpAsNormal(entry) {
        const size = 512;

        // Save original normal if not saved
        if (entry._originalNormalMap === undefined) {
            if (entry.material.normalMap && entry.material.normalMap.image) {
                const origImg = entry.material.normalMap.image;
                const copyCanvas = document.createElement('canvas');
                copyCanvas.width = origImg.width || size;
                copyCanvas.height = origImg.height || size;
                copyCanvas.getContext('2d').drawImage(origImg, 0, 0, copyCanvas.width, copyCanvas.height);
                entry._originalNormalMap = copyCanvas;
            } else {
                entry._originalNormalMap = null;
            }
        }

        // Draw bump with flip V
        const hCanvas = document.createElement('canvas');
        hCanvas.width = size; hCanvas.height = size;
        const hCtx = hCanvas.getContext('2d');
        if (entry.flipV) {
            hCtx.translate(0, size);
            hCtx.scale(1, -1);
        }
        hCtx.drawImage(entry._bumpImg, 0, 0, size, size);
        hCtx.setTransform(1, 0, 0, 1, 0, 0);

        // Convert to normal
        const bumpNormal = this._heightToNormal(hCanvas, (entry._bumpScale || 0.05) * 10);

        // Blend with original
        let finalNormal;
        if (entry._originalNormalMap) {
            const origCanvas = document.createElement('canvas');
            origCanvas.width = size; origCanvas.height = size;
            origCanvas.getContext('2d').drawImage(entry._originalNormalMap, 0, 0, size, size);
            finalNormal = this._blendNormals(origCanvas, bumpNormal, 1.0);
        } else {
            finalNormal = bumpNormal;
        }

        entry.material.normalMap = new THREE.CanvasTexture(finalNormal);
        entry.material.normalMap.colorSpace = THREE.LinearSRGBColorSpace;
        entry.material.normalMap.flipY = false;
        entry.material.needsUpdate = true;
    }

    setSpecularIntensity(name, v) { const e = this.entries.get(name); if (e) e.material.specularIntensity = v; }
    setSpecularColor(name, c) { const e = this.entries.get(name); if (e) e.material.specularColor.set(c); }

    // --- Displacement ---
    setDisplacementMap(name, img) {
        const e = this.entries.get(name);
        if (!e) return;
        if (img) {
            e.material.displacementMap = this._makeFlippedTexture(img, THREE.LinearSRGBColorSpace, e.flipV);
            e.material.displacementScale = 0.1;
        } else {
            e.material.displacementMap = null;
        }
        e.material.needsUpdate = true;
    }
    setDisplacementScale(name, v) { const e = this.entries.get(name); if (e) e.material.displacementScale = v; }
    setDisplacementBias(name, v) { const e = this.entries.get(name); if (e) e.material.displacementBias = v; }

    // --- RGB Mask (per channel: Color A + Color B, blended by single mask) ---
    setRGBMask(name, img, path) {
        const e = this.entries.get(name);
        if (!e) return;
        e.rgbMask = img;
        e._rgbMaskPath = path || null;
        this._refreshMaterial(name);
    }

    /** Toggle double-sided rendering on a material. OFF by default —
     *  most Gloops meshes are closed volumes, so back faces are hidden
     *  anyway. Users turn this ON for sheet-like meshes (capes, flags,
     *  glass panes) where both sides should render. */
    setDoubleSided(name, enabled) {
        const e = this.entries.get(name);
        if (!e) return;
        e.material.side = enabled ? THREE.DoubleSide : THREE.FrontSide;
        e.material.needsUpdate = true;
    }

    setRGBColorA(name, channel, color) {
        const e = this.entries.get(name);
        if (!e) return;
        e.rgbColorsA[channel].set(color);
        this._refreshMaterial(name);
    }

    setRGBColorB(name, channel, color) {
        const e = this.entries.get(name);
        if (!e) return;
        e.rgbColorsB[channel].set(color);
        this._refreshMaterial(name);
    }

    setRGBTextureA(name, channel, img, path) {
        const e = this.entries.get(name);
        if (!e) return;
        e.rgbTexturesA[channel] = img;
        e.rgbTexPathsA[channel] = path || null;
        this._refreshMaterial(name);
    }

    setRGBTextureB(name, channel, img, path) {
        const e = this.entries.get(name);
        if (!e) return;
        e.rgbTexturesB[channel] = img;
        e.rgbTexPathsB[channel] = path || null;
        this._refreshMaterial(name);
    }

    // ----- Getters -----

    getMaterialNames() {
        return [...this.entries.keys()].sort();
    }

    getEntry(name) {
        return this.entries.get(name) || null;
    }

    /* -------------------------------------------------------- */
    /*  Materials change notifications                          */
    /* -------------------------------------------------------- */

    onMaterialsChanged(cb) {
        this._matChangedCb = cb;
    }
    _fireMaterialsChanged() {
        if (this._matChangedCb) this._matChangedCb();
    }

    /* -------------------------------------------------------- */
    /*  Sub-model registration (paired props)                   */
    /* -------------------------------------------------------- */

    /**
     * Register a paired prop's materials in a SHARED per-category pool.
     * All props in the same category (e.g. all Eyes glasses) reuse the
     * same materials, keyed by the source material's name.
     *
     * Example: Aviator + Pirate + Lenon all have a "Glass" material.
     * Only ONE "Glass" entry is created in the MAT panel, and all three
     * meshes are assigned the same Material instance — so editing the
     * shader updates every glass prop simultaneously.
     *
     * Returns the array of entry keys that exist (created or reused).
     */
    addCategoryMaterials(propRoot, categoryLabel) {
        if (!propRoot || !categoryLabel) return [];
        if (!this._categoryMatPool) this._categoryMatPool = new Map();
        if (!this._categoryMatPool.has(categoryLabel)) {
            this._categoryMatPool.set(categoryLabel, new Map());
        }
        const pool = this._categoryMatPool.get(categoryLabel);

        // Collect unique source materials in the sub-model.
        // Handles BOTH single-material and multi-material (array) meshes.
        // For multi-mat meshes, each slot becomes its own entry; we
        // remember which slot index it occupies so we can rewrite the
        // mesh.material array on reuse without losing the others.
        const matMap = new Map(); // uuid -> { oldMat, name, slots: [{mesh, slotIndex}] }

        const visit = (child, mat, slotIndex) => {
            if (!mat) return;
            const key = mat.uuid;
            if (matMap.has(key)) {
                matMap.get(key).slots.push({ mesh: child, slotIndex });
                return;
            }
            const fallbackName = slotIndex >= 0
                ? `${child.name || 'mat'}_${slotIndex}`
                : (child.name || `mat_${matMap.size}`);
            matMap.set(key, {
                oldMat: mat,
                name: mat.name || fallbackName,
                slots: [{ mesh: child, slotIndex }],
            });
        };

        propRoot.traverse((child) => {
            if (!child.isMesh && !child.isSkinnedMesh) return;
            const m = child.material;
            if (!m) return;
            if (Array.isArray(m)) {
                m.forEach((sub, i) => visit(child, sub, i));
            } else {
                visit(child, m, -1);
            }
        });

        let createdCount = 0;
        let reusedCount = 0;
        const allKeys = [];

        // Helper to assign a material to a mesh at the right slot
        const assignSlot = (mesh, slotIndex, newMat) => {
            if (slotIndex < 0) {
                mesh.material = newMat;
            } else {
                if (!Array.isArray(mesh.material)) mesh.material = [mesh.material];
                mesh.material[slotIndex] = newMat;
            }
        };

        for (const info of matMap.values()) {
            const { oldMat, name, slots } = info;
            const meshes = slots.map((s) => s.mesh);
            const entryKey = `🔧 ${categoryLabel} / ${name}`;
            allKeys.push(entryKey);

            let entry = pool.get(name);
            if (entry) {
                // REUSE existing material — assign it to every slot
                for (const { mesh, slotIndex } of slots) {
                    assignSlot(mesh, slotIndex, entry.material);
                    if (!entry.meshes.includes(mesh)) entry.meshes.push(mesh);
                }
                reusedCount++;
                continue;
            }

            // CREATE fresh material for this category
            const newMat = new THREE.MeshPhysicalMaterial({
                color: new THREE.Color(0xffffff),
                roughness: oldMat.roughness ?? 1.0,
                metalness: oldMat.metalness ?? 0,
                name: `${categoryLabel}/${name}`,
                thickness: 0,
                transmission: 0,
                sheen: 0,
                sheenRoughness: 0.5,
                sheenColor: new THREE.Color(1, 1, 1),
                clearcoat: 0,
                clearcoatRoughness: 0,
                ior: 1.5,
                attenuationColor: new THREE.Color(0.8, 0.3, 0.2),
                attenuationDistance: 0.5,
                specularIntensity: 1.0,
                specularColor: new THREE.Color(1, 1, 1),
                skinning: meshes.some((m) => m.isSkinnedMesh),
            });

            for (const { mesh, slotIndex } of slots) {
                assignSlot(mesh, slotIndex, newMat);
            }

            entry = new MaterialEntry(entryKey, meshes, newMat);
            // Paired props follow the same flipV as the character
            entry.flipV = this._defaultFlipV ?? true;
            this.entries.set(entryKey, entry);
            pool.set(name, entry);
            createdCount++;
        }

        if (createdCount > 0) {
            console.log(`[shading] ${categoryLabel}: +${createdCount} new, ${reusedCount} reused`);
            this._fireMaterialsChanged();
        } else if (reusedCount > 0) {
            console.log(`[shading] ${categoryLabel}: ${reusedCount} material(s) reused`);
        }
        return allKeys;
    }

    /**
     * Drop all materials registered for a category. Use this when the
     * user clears every prop of a category and you want a clean slate.
     * (Not called automatically — paired props swap in/out frequently
     * so we keep the pool warm for performance.)
     */
    clearCategoryMaterials(categoryLabel) {
        if (!this._categoryMatPool) return;
        const pool = this._categoryMatPool.get(categoryLabel);
        if (!pool) return;
        for (const entry of pool.values()) {
            this.entries.delete(entry.name);
        }
        this._categoryMatPool.delete(categoryLabel);
        console.log(`[shading] cleared category materials: ${categoryLabel}`);
        this._fireMaterialsChanged();
    }
}
