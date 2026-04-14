/**
 * Character preset system.
 *
 * Captures the "identity" of a generated character — animation choices,
 * per-material RGB channel colors, pattern mode / variant, eye style, etc.
 * Stores them as JSON files (download/import) and in localStorage by name,
 * so a custom Gloop can be saved and reused later as a hero, NPC, or villain.
 */

const STORAGE_KEY = 'gloops_character_presets';
const TARGET_MATS = ['body', 'horns', 'eyes'];

// Simple, fun, monster-ish name pool
const NAME_FIRST = [
    'Bob', 'Zog', 'Mim', 'Gru', 'Pip', 'Blob', 'Glob', 'Nug', 'Wug', 'Zib',
    'Mok', 'Tup', 'Boog', 'Glip', 'Snik', 'Wob', 'Krok', 'Drix', 'Furp', 'Lub',
    'Mort', 'Zazu', 'Klop', 'Plop', 'Snorf', 'Fizz', 'Bink', 'Goz', 'Yub', 'Vex',
    'Mungo', 'Trix', 'Dook', 'Skib', 'Wozz', 'Pog', 'Klem', 'Nix', 'Zob', 'Brik'
];
const NAME_LAST = [
    'le Grand', 'le Petit', 'le Vert', 'le Rose', 'le Fou', 'le Sage', 'le Gros',
    'le Malin', 'le Cool', 'le Brave', 'le Doux', 'le Costaud', 'le Boss',
    'Pattes-Molles', 'Gros-Bidon', 'Mange-Tout', 'Petit-Pied', 'Tete-Carree',
    'Trois-Dents', 'Oeil-Rond', 'Joue-Ronde', 'Grand-Sourire'
];

export function randomGloopName() {
    const first = NAME_FIRST[Math.floor(Math.random() * NAME_FIRST.length)];
    // 60% chance of a last name
    if (Math.random() < 0.6) {
        const last = NAME_LAST[Math.floor(Math.random() * NAME_LAST.length)];
        return `${first} ${last}`;
    }
    return first;
}

export class CharacterPresets {
    constructor(character, shadingManager) {
        this.character = character;
        this.sm = shadingManager;
    }

    // ----- Capture current state -----

    capture(name = 'Untitled') {
        const preset = {
            _type: 'gloops_character_preset',
            _version: 1,
            name,
            createdAt: new Date().toISOString(),
            animation: {},
            materials: {},
        };

        // Animations / poses
        for (const cat of this.character.getCategoryNames()) {
            preset.animation[cat] = this.character.getActive(cat) || null;
        }

        // Per-material identity
        for (const kw of TARGET_MATS) {
            const matName = this._findMat(kw);
            if (!matName) continue;
            const e = this.sm.getEntry(matName);
            if (!e) continue;

            preset.materials[kw] = {
                rgbColorsA: (e.rgbColorsA || []).map(c => '#' + c.getHexString()),
                rgbColorsB: (e.rgbColorsB || []).map(c => '#' + c.getHexString()),
                rgbTexPathsA: [...(e.rgbTexPathsA || [])],
                patternMode: e.patternMode || null,
                patternHueShift: e.patternHueShift || 0,
                patternSatShift: e.patternSatShift || 0,
                patternPath: this._patternPath(e),
            };
        }

        return preset;
    }

    // ----- Apply a preset -----

    async apply(preset) {
        if (!preset || preset._type !== 'gloops_character_preset') {
            throw new Error('Not a Gloops character preset');
        }

        // Animations
        for (const [cat, filename] of Object.entries(preset.animation || {})) {
            if (filename) this.character.selectItem(cat, filename);
        }

        // Materials
        for (const [kw, mvals] of Object.entries(preset.materials || {})) {
            const matName = this._findMat(kw);
            if (!matName) continue;

            if (mvals.rgbColorsA) {
                mvals.rgbColorsA.forEach((c, i) => this.sm.setRGBColorA(matName, i, c));
            }
            if (mvals.rgbColorsB) {
                mvals.rgbColorsB.forEach((c, i) => this.sm.setRGBColorB(matName, i, c));
            }

            // Diffuse variants (e.g. eye style) — load from variants list by path match
            if (mvals.rgbTexPathsA) {
                const entry = this.sm.getEntry(matName);
                for (let i = 0; i < mvals.rgbTexPathsA.length; i++) {
                    const path = mvals.rgbTexPathsA[i];
                    if (!path) continue;
                    const img = await this._loadImage(path);
                    if (img) this.sm.setRGBTextureA(matName, i, img, path);
                }
                void entry;
            }

            // Pattern mode + variant
            if (mvals.patternMode) {
                this.sm.setPatternMode(matName, mvals.patternMode);
            }
            if (mvals.patternHueShift !== undefined) {
                this.sm.setPatternHueShift(matName, mvals.patternHueShift);
            }
            if (mvals.patternSatShift !== undefined) {
                this.sm.setPatternSatShift(matName, mvals.patternSatShift);
            }
            if (mvals.patternPath) {
                const entry = this.sm.getEntry(matName);
                const variant = (entry && entry._patternVariants || [])
                    .find(v => mvals.patternPath.endsWith(v.path) || v.path.endsWith(mvals.patternPath));
                const path = variant ? variant.path : mvals.patternPath;
                const img = await this._loadImage(path);
                if (img) {
                    this.sm.setPatternMap(matName, img);
                    if (entry) entry._patternPath = path;
                }
            }
        }
    }

    // ----- localStorage library -----

    listLocal() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            const obj = JSON.parse(raw);
            return Object.keys(obj).sort();
        } catch (e) {
            return [];
        }
    }

    saveLocal(name, preset) {
        const all = this._readAll();
        all[name] = { ...preset, name };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    }

    loadLocal(name) {
        const all = this._readAll();
        return all[name] || null;
    }

    deleteLocal(name) {
        const all = this._readAll();
        delete all[name];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    }

    _readAll() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }

    // ----- File download / import -----

    download(preset) {
        const safe = (preset.name || 'gloop').replace(/[^a-z0-9_-]/gi, '_');
        const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Gloops_character_${safe}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    importFile() {
        return new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.addEventListener('change', () => {
                if (!input.files[0]) return resolve(null);
                const reader = new FileReader();
                reader.onload = (e) => {
                    try {
                        resolve(JSON.parse(e.target.result));
                    } catch (err) {
                        reject(err);
                    }
                };
                reader.onerror = () => reject(reader.error);
                reader.readAsText(input.files[0]);
            });
            input.click();
        });
    }

    // ----- helpers -----

    _findMat(keyword) {
        if (!keyword) return null;
        const kw = keyword.toLowerCase();
        return this.sm.getMaterialNames().find(n => n.toLowerCase().includes(kw)) || null;
    }

    _patternPath(entry) {
        if (entry._patternPath) return entry._patternPath;
        const src = entry.patternMap && entry.patternMap.src;
        if (!src) return null;
        // Strip page origin so the path is portable across hosts
        try {
            const u = new URL(src, window.location.href);
            if (u.origin === window.location.origin) {
                return u.pathname.replace(/^\//, '');
            }
            return src;
        } catch (e) {
            return src;
        }
    }

    _loadImage(path) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = path;
        });
    }
}
