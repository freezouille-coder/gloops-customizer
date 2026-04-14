/**
 * Reusable character setup pipeline. Extracted from app.js so NPCs
 * (and any future cloned Gloops) can run the exact same steps with
 * their own ShadingManager.
 */

import { COLOR_PALETTE } from './palette.js';

const _imgCache = new Map();

function loadImg(path) {
    if (_imgCache.has(path)) {
        const cached = _imgCache.get(path);
        if (cached.complete) return Promise.resolve(cached);
        return new Promise(r => {
            cached.addEventListener('load', () => r(cached));
            cached.addEventListener('error', () => r(null));
        });
    }
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => { _imgCache.set(path, img); resolve(img); };
        img.onerror = () => resolve(null);
        img.src = path;
    });
}

/**
 * Auto-connect textures from manifest.autoConnect to a ShadingManager.
 * Mirrors the original logic in app.js but takes `sm` as a parameter.
 */
export async function autoConnectTextures(sm, autoConnect) {
    const matNames = sm.getMaterialNames();

    for (const matName of matNames) {
        const matLower = matName.toLowerCase();
        let folderData = null;
        for (const [folder, types] of Object.entries(autoConnect)) {
            if (matLower.includes(folder.toLowerCase()) || folder.toLowerCase().includes(matLower)) {
                folderData = types;
                break;
            }
        }
        if (!folderData) continue;

        const hasDiffuse = folderData['diffuse'];

        for (const [type, entries] of Object.entries(folderData)) {
            const primary = entries.find(e => e.variant === null) || entries[0];
            if (!primary) continue;

            const img = await loadImg(primary.path);
            if (!img) continue;

            switch (type) {
                case 'rgbMask':
                    if (!hasDiffuse) sm.setRGBMask(matName, img, primary.path);
                    break;
                case 'blendMask':
                    if (!hasDiffuse) sm.setMask(matName, img, primary.path);
                    break;
                case 'diffuse': {
                    sm.setRGBTextureA(matName, 0, img, primary.path);
                    const e2 = sm.getEntry(matName);
                    if (e2) {
                        e2._diffuseVariants = entries
                            .sort((a, b) => (a.variant ?? -1) - (b.variant ?? -1))
                            .map(e => ({ path: e.path, id: e.id, variant: e.variant }));
                    }
                    break;
                }
                case 'normalMap': sm.setNormalMap(matName, img); break;
                case 'bumpMap': sm.setBumpMap(matName, img); break;
                case 'diffuseWeightMap': sm.setDiffuseWeightMap(matName, img); break;
                case 'pattern': {
                    const eP = sm.getEntry(matName);
                    if (eP) {
                        eP._patternVariants = entries
                            .sort((a, b) => (a.variant ?? -1) - (b.variant ?? -1))
                            .map(e2 => ({ path: e2.path, id: e2.id, variant: e2.variant }));
                    }
                    sm.setPatternMap(matName, img);
                    break;
                }
                case 'roughnessMap': sm.setRoughnessMap(matName, img); break;
                case 'metalnessMap': sm.setMetalnessMap(matName, img); break;
                case 'aoMap': sm.setAOMap(matName, img); break;
                case 'displacementMap': {
                    const e = sm.getEntry(matName);
                    if (e) e._displacementAvailable = primary.path;
                    break;
                }
                case 'alphaMap': sm.setAlphaMap(matName, img); break;
                case 'emissiveMap': sm.setEmissiveMap(matName, img); break;
            }
        }

        // Per-material defaults
        if (matLower.includes('eye') && !matLower.includes('glass') && !matLower.includes('brow') && !matLower.includes('lid')) {
            sm.setEmissiveUseBaseColor(matName, true);
            const entry = sm.getEntry(matName);
            if (entry) entry.material.emissiveIntensity = 1;
            if (folderData['diffuse']) {
                const v8 = folderData['diffuse'].find(e => e.variant === 8);
                if (v8) {
                    const v8Img = await loadImg(v8.path);
                    if (v8Img) sm.setRGBTextureA(matName, 0, v8Img, v8.path);
                }
            }
        }
        if (matLower.includes('glass') && folderData['emissiveMap']) {
            sm.setEmissiveUseBaseColor(matName, true);
            const entry = sm.getEntry(matName);
            if (entry) entry.material.emissiveIntensity = 1;
        }
    }
}

/**
 * Apply per-material defaults from character.json (sheen, horns black,
 * pattern defaults). Does NOT touch scene-level things like ground or IBL.
 */
export function applyMaterialDefaults(sm, characterConfig) {
    const defaults = characterConfig.defaults || {};
    const findMat = (kw) => sm.getMaterialNames().find(n => n.toLowerCase().includes(kw));

    if (defaults.sheen) {
        for (const name of sm.getMaterialNames()) {
            sm.setSheen(name, defaults.sheen.intensity || 0);
            sm.setSheenRoughness(name, defaults.sheen.roughness || 0.5);
            const entry = sm.getEntry(name);
            if (entry && defaults.sheen.useBaseColor) {
                entry._sheenUseBaseColor = true;
                entry._sheenSatMult = defaults.sheen.saturationMult || 0.5;
            }
        }
    }

    if (defaults.horns) {
        const hornsMat = findMat('horns');
        if (hornsMat) {
            if (defaults.horns.B_A) sm.setRGBColorA(hornsMat, 2, defaults.horns.B_A);
            if (defaults.horns.B_B) sm.setRGBColorB(hornsMat, 2, defaults.horns.B_B);
        }
    }

    if (defaults.pattern) {
        for (const name of sm.getMaterialNames()) {
            const entry = sm.getEntry(name);
            if (entry) entry._patternDefaults = defaults.pattern;
        }
    }

    const patternChannels = characterConfig.patternChannels || {};
    const chMap = { 'R': 0, 'G': 1, 'B': 2 };
    for (const [meshKw, ch] of Object.entries(patternChannels)) {
        const mat = findMat(meshKw);
        if (mat) {
            const entry = sm.getEntry(mat);
            if (entry) entry._patternChannel = chMap[ch];
        }
    }
}

/**
 * Apply a fully random "preset" to a character — palette colors, pattern
 * mode + variant, eye style. Same logic as the Generate tab's randomizeAll
 * but standalone (no UI). Returns the preset object.
 */
export async function randomizeCharacter(sm, characterConfig) {
    const randomizable = characterConfig.randomizable || {};
    const pickRand = arr => arr[Math.floor(Math.random() * arr.length)];
    const findMat = (kw) => sm.getMaterialNames().find(n => n.toLowerCase().includes(kw));

    for (const [key, attr] of Object.entries(randomizable)) {
        if (attr.enabled === false) continue;
        switch (attr.type) {
            case 'palette': {
                const mat = findMat(attr.material);
                if (!mat) break;
                const c = pickRand(COLOR_PALETTE);
                if (attr.side === 'B') sm.setRGBColorB(mat, attr.channel || 0, c.hex);
                else sm.setRGBColorA(mat, attr.channel || 0, c.hex);
                break;
            }
            case 'pattern': {
                const mat = findMat(attr.material);
                if (!mat) break;
                const entry = sm.getEntry(mat);
                if (!entry || !entry._patternVariants) break;
                const v = pickRand(entry._patternVariants);
                const img = await loadImg(v.path);
                if (img) { sm.setPatternMap(mat, img); entry._patternPath = v.path; }
                break;
            }
            case 'mode': {
                const mat = findMat(attr.material);
                if (!mat) break;
                const m = pickRand(attr.options);
                sm.setPatternMode(mat, m);
                const entry = sm.getEntry(mat);
                const patDef = entry && entry._patternDefaults && entry._patternDefaults[m];
                if (patDef) {
                    sm.setPatternHueShift(mat, patDef.hue || 0);
                    sm.setPatternSatShift(mat, patDef.sat || 0);
                }
                break;
            }
            case 'diffuseVariant': {
                const mat = findMat(attr.material);
                if (!mat) break;
                const entry = sm.getEntry(mat);
                if (!entry || !entry._diffuseVariants) break;
                const v = pickRand(entry._diffuseVariants);
                const img = await loadImg(v.path);
                if (img) sm.setRGBTextureA(mat, 0, img, v.path);
                break;
            }
        }
    }

    // Apply linked color rules (horns tongue follows body tongue)
    const linked = characterConfig.linkedColors || {};
    for (const [target, source] of Object.entries(linked)) {
        const [tMesh, tCh, tSide] = target.split('_');
        const [sMesh, sCh, sSide] = source.split('_');
        const sMat = findMat(sMesh);
        const tMat = findMat(tMesh);
        if (!sMat || !tMat) continue;
        const chIdx = { 'R': 0, 'G': 1, 'B': 2 };
        const sEntry = sm.getEntry(sMat);
        if (!sEntry) continue;
        const colArr = sSide === 'B' ? sEntry.rgbColorsB : sEntry.rgbColorsA;
        const c = '#' + colArr[chIdx[sCh]].getHexString();
        if (tSide === 'B') sm.setRGBColorB(tMat, chIdx[tCh], c);
        else sm.setRGBColorA(tMat, chIdx[tCh], c);
    }
}
