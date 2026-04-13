import { COLOR_PALETTE } from './palette.js';

/**
 * Generate tab: create random characters using config from character.json
 */
export class GenerateControls {
    constructor(character, shadingManager, manifest) {
        this.character = character;
        this.sm = shadingManager;
        this.manifest = manifest;
        this.config = null;
        this.container = null;
    }

    async build(container) {
        this.container = container;
        this.container.innerHTML = '';

        // Load config
        try {
            const resp = await fetch('config/character.json');
            this.config = await resp.json();
        } catch (e) {
            this.config = { randomizable: {}, channelLabels: {}, colorNames: {} };
        }

        // --- Big Random Button ---
        const randomAllBtn = document.createElement('button');
        randomAllBtn.textContent = '🎲 Generate Random';
        randomAllBtn.id = 'btn-generate-random';
        randomAllBtn.addEventListener('click', () => this._randomizeAll());
        this.container.appendChild(randomAllBtn);

        // --- Build randomizable attributes ---
        const randomizable = this.config.randomizable || {};

        for (const [key, attr] of Object.entries(randomizable)) {
            const section = this._buildAttribute(key, attr);
            if (section) this.container.appendChild(section);
        }
    }

    _buildAttribute(key, attr) {
        const row = document.createElement('div');
        row.className = 'gen-row';

        // Enable checkbox
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'mat-checkbox';
        cb.checked = attr.enabled !== false;
        cb.id = `gen-cb-${key}`;
        cb.addEventListener('change', () => attr.enabled = cb.checked);

        // Label
        const lbl = document.createElement('label');
        lbl.className = 'gen-label';
        lbl.textContent = attr.label || key;
        lbl.htmlFor = cb.id;

        // Random button
        const btn = document.createElement('button');
        btn.textContent = '🎲';
        btn.className = 'btn-category-random';
        btn.addEventListener('click', () => this._randomizeOne(key, attr));

        row.appendChild(cb);
        row.appendChild(lbl);
        row.appendChild(btn);

        // Add inline controls for specific types
        if (attr.type === 'palette') {
            const palette = this._buildMiniPalette(key, attr);
            const wrapper = document.createElement('div');
            wrapper.appendChild(row);
            wrapper.appendChild(palette);
            return wrapper;
        }

        if (attr.type === 'diffuseVariant') {
            const thumbs = this._buildVariantThumbs(attr);
            if (thumbs) {
                const wrapper = document.createElement('div');
                wrapper.appendChild(row);
                wrapper.appendChild(thumbs);
                return wrapper;
            }
        }

        if (attr.type === 'pattern') {
            const thumbs = this._buildPatternThumbs(attr);
            if (thumbs) {
                const wrapper = document.createElement('div');
                wrapper.appendChild(row);
                wrapper.appendChild(thumbs);
                return wrapper;
            }
        }

        return row;
    }

    _buildMiniPalette(key, attr) {
        const row = document.createElement('div');
        row.className = 'palette-row';
        row.style.padding = '2px 30px 6px';

        for (const c of COLOR_PALETTE) {
            const s = document.createElement('div');
            s.className = 'gen-swatch';
            s.style.backgroundColor = c.hex;
            s.title = (this.config.colorNames && this.config.colorNames[c.name]) || c.name;
            s.addEventListener('click', () => {
                const mat = this._findMat(attr.material);
                if (mat) this.sm.setRGBColorA(mat, attr.channel || 0, c.hex);
                row.querySelectorAll('.gen-swatch').forEach(x => x.classList.remove('active'));
                s.classList.add('active');
            });
            row.appendChild(s);
        }
        return row;
    }

    _buildVariantThumbs(attr) {
        const mat = this._findMat(attr.material);
        if (!mat) return null;
        const entry = this.sm.getEntry(mat);
        if (!entry || !entry._diffuseVariants || entry._diffuseVariants.length < 2) return null;

        const row = document.createElement('div');
        row.className = 'palette-row';
        row.style.padding = '2px 30px 6px';

        for (const v of entry._diffuseVariants) {
            const thumb = document.createElement('canvas');
            thumb.className = 'gen-thumb';
            thumb.width = 32; thumb.height = 32;
            const img = new Image();
            img.onload = () => thumb.getContext('2d').drawImage(img, 0, 0, 32, 32);
            img.src = v.path;
            thumb.addEventListener('click', () => {
                const fullImg = new Image();
                fullImg.onload = () => {
                    this.sm.setRGBTextureA(mat, 0, fullImg, v.path);
                    row.querySelectorAll('.gen-thumb').forEach(t => t.style.borderColor = 'transparent');
                    thumb.style.borderColor = '#e94560';
                };
                fullImg.src = v.path;
            });
            row.appendChild(thumb);
        }
        return row;
    }

    _buildPatternThumbs(attr) {
        const mat = this._findMat(attr.material);
        if (!mat) return null;
        const entry = this.sm.getEntry(mat);
        if (!entry || !entry._patternVariants || entry._patternVariants.length < 2) return null;

        const row = document.createElement('div');
        row.className = 'palette-row';
        row.style.padding = '2px 30px 6px';

        for (const v of entry._patternVariants) {
            const thumb = document.createElement('canvas');
            thumb.className = 'gen-thumb';
            thumb.width = 28; thumb.height = 28;
            const img = new Image();
            img.onload = () => thumb.getContext('2d').drawImage(img, 0, 0, 28, 28);
            img.src = v.path;
            thumb.addEventListener('click', () => {
                const fullImg = new Image();
                fullImg.onload = () => {
                    this.sm.setPatternMap(mat, fullImg);
                    row.querySelectorAll('.gen-thumb').forEach(t => t.style.borderColor = 'transparent');
                    thumb.style.borderColor = '#e94560';
                };
                fullImg.src = v.path;
            });
            row.appendChild(thumb);
        }
        return row;
    }

    // ----- Randomize -----

    _randomizeAll() {
        const randomizable = this.config.randomizable || {};
        for (const [key, attr] of Object.entries(randomizable)) {
            if (attr.enabled !== false) {
                this._randomizeOne(key, attr);
            }
        }
    }

    _randomizeOne(key, attr) {
        switch (attr.type) {
            case 'palette': {
                const pick = COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
                const mat = this._findMat(attr.material);
                if (mat) this.sm.setRGBColorA(mat, attr.channel || 0, pick.hex);
                break;
            }
            case 'pattern': {
                const mat = this._findMat(attr.material);
                if (!mat) break;
                const entry = this.sm.getEntry(mat);
                if (!entry || !entry._patternVariants) break;
                const pick = entry._patternVariants[Math.floor(Math.random() * entry._patternVariants.length)];
                const img = new Image();
                img.onload = () => this.sm.setPatternMap(mat, img);
                img.src = pick.path;
                break;
            }
            case 'diffuseVariant': {
                const mat = this._findMat(attr.material);
                if (!mat) break;
                const entry = this.sm.getEntry(mat);
                if (!entry || !entry._diffuseVariants) break;
                const pick = entry._diffuseVariants[Math.floor(Math.random() * entry._diffuseVariants.length)];
                const img = new Image();
                img.onload = () => this.sm.setRGBTextureA(mat, 0, img, pick.path);
                img.src = pick.path;
                break;
            }
            case 'mode': {
                const pick = attr.options[Math.floor(Math.random() * attr.options.length)];
                for (const name of this.sm.getMaterialNames()) {
                    this.sm.setPatternMode(name, pick);
                }
                break;
            }
            case 'range': {
                const mat = this._findMat(attr.material);
                if (!mat) break;
                const val = attr.min + Math.random() * (attr.max - attr.min);
                if (key === 'patternHue') this.sm.setPatternHueShift(mat, val);
                else if (key === 'patternSat') this.sm.setPatternSatShift(mat, val);
                break;
            }
            default: {
                // Animation category
                if (attr.category) {
                    const items = this.character.getCategoryItems(attr.category);
                    if (items.length > 0) {
                        const pick = items[Math.floor(Math.random() * items.length)];
                        this.character.selectItem(attr.category, pick.filename);
                    }
                }
            }
        }
    }

    _findMat(keyword) {
        if (!keyword) return null;
        const kw = keyword.toLowerCase();
        return this.sm.getMaterialNames().find(n => n.toLowerCase().includes(kw)) || null;
    }
}
