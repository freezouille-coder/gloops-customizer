import { COLOR_PALETTE } from './palette.js';
import { CharacterPresets, randomGloopName } from './character-presets.js';

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
        this.presets = new CharacterPresets(character, shadingManager);
        this._presetListEl = null;
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
        randomAllBtn.addEventListener('click', () => {
            this._randomizeAll();
            if (this._nameInput && !this._nameInput.value.trim()) {
                this._nameInput.value = randomGloopName();
            }
        });
        this.container.appendChild(randomAllBtn);

        // --- Character Preset library ---
        this.container.appendChild(this._buildPresetSection());

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
                    const e = this.sm.getEntry(mat);
                    if (e) e._patternPath = v.path;
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
                if (!mat) break;
                const ch = attr.channel || 0;
                if (attr.side === 'B') {
                    this.sm.setRGBColorB(mat, ch, pick.hex);
                } else {
                    this.sm.setRGBColorA(mat, ch, pick.hex);
                }
                // Apply linked colors
                this._applyLinkedColors(key, pick.hex);
                break;
            }
            case 'pattern': {
                const mat = this._findMat(attr.material);
                if (!mat) break;
                const entry = this.sm.getEntry(mat);
                if (!entry || !entry._patternVariants) break;
                const pick = entry._patternVariants[Math.floor(Math.random() * entry._patternVariants.length)];
                const img = new Image();
                img.onload = () => {
                    this.sm.setPatternMap(mat, img);
                    entry._patternPath = pick.path;
                };
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
                if (attr.material) {
                    const mat = this._findMat(attr.material);
                    if (mat) {
                        this.sm.setPatternMode(mat, pick);
                        // Apply pattern hue/sat defaults per mode
                        const entry = this.sm.getEntry(mat);
                        const patDef = entry && entry._patternDefaults && entry._patternDefaults[pick];
                        if (patDef) {
                            this.sm.setPatternHueShift(mat, patDef.hue || 0);
                            this.sm.setPatternSatShift(mat, patDef.sat || 0);
                        }
                    }
                } else {
                    for (const name of this.sm.getMaterialNames()) {
                        this.sm.setPatternMode(name, pick);
                    }
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

    /**
     * Apply linked colors: when body tongue color changes,
     * horns R color follows automatically.
     */
    _applyLinkedColors(key, hex) {
        const linked = this.config.linkedColors || {};
        // Check if any linked color references this key's material+channel
        // e.g. "horns_R_A": "body_G_A" means horns R Color A = body G Color A
        for (const [target, source] of Object.entries(linked)) {
            const [tMesh, tCh, tSide] = target.split('_');
            const [sMesh, sCh, sSide] = source.split('_');

            // Check if the current randomization matches the source
            const randomizable = this.config.randomizable || {};
            for (const [rKey, rAttr] of Object.entries(randomizable)) {
                if (rAttr.material === sMesh &&
                    rAttr.channel === {'R':0,'G':1,'B':2}[sCh] &&
                    rAttr.side === sSide &&
                    rKey === key) {
                    // Apply to target
                    const tMat = this._findMat(tMesh);
                    const tChIdx = {'R':0,'G':1,'B':2}[tCh];
                    if (tMat && tChIdx !== undefined) {
                        if (tSide === 'B') this.sm.setRGBColorB(tMat, tChIdx, hex);
                        else this.sm.setRGBColorA(tMat, tChIdx, hex);
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

    // ----- Character preset library -----

    _buildPresetSection() {
        const wrap = document.createElement('div');
        wrap.className = 'gen-presets';

        const title = document.createElement('div');
        title.className = 'gen-presets-title';
        title.textContent = '👤 Characters';
        wrap.appendChild(title);

        const row = document.createElement('div');
        row.className = 'gen-presets-row';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Name (e.g. Boss Bob)';
        nameInput.className = 'gen-preset-name';
        this._nameInput = nameInput;

        const diceBtn = document.createElement('button');
        diceBtn.className = 'gen-preset-btn';
        diceBtn.textContent = '🎲';
        diceBtn.title = 'Random name';
        diceBtn.addEventListener('click', () => {
            nameInput.value = randomGloopName();
        });

        const saveBtn = document.createElement('button');
        saveBtn.className = 'gen-preset-btn';
        saveBtn.textContent = '💾';
        saveBtn.title = 'Save current Gloop to library';
        saveBtn.addEventListener('click', () => {
            const name = (nameInput.value || '').trim();
            if (!name) { nameInput.focus(); return; }
            const preset = this.presets.capture(name);
            this.presets.saveLocal(name, preset);
            nameInput.value = '';
            this._refreshPresetList();
        });

        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'gen-preset-btn';
        downloadBtn.textContent = '⬇';
        downloadBtn.title = 'Download current Gloop as .json';
        downloadBtn.addEventListener('click', () => {
            const name = (nameInput.value || 'gloop').trim();
            this.presets.download(this.presets.capture(name));
        });

        const importBtn = document.createElement('button');
        importBtn.className = 'gen-preset-btn';
        importBtn.textContent = '⬆';
        importBtn.title = 'Import .json preset';
        importBtn.addEventListener('click', async () => {
            try {
                const preset = await this.presets.importFile();
                if (!preset) return;
                await this.presets.apply(preset);
                if (preset.name) {
                    this.presets.saveLocal(preset.name, preset);
                    this._refreshPresetList();
                }
            } catch (e) {
                console.error(e);
                alert('Could not import preset: ' + e.message);
            }
        });

        row.appendChild(nameInput);
        row.appendChild(diceBtn);
        row.appendChild(saveBtn);
        row.appendChild(downloadBtn);
        row.appendChild(importBtn);
        wrap.appendChild(row);

        this._presetListEl = document.createElement('div');
        this._presetListEl.className = 'gen-preset-list';
        wrap.appendChild(this._presetListEl);
        this._refreshPresetList();

        return wrap;
    }

    _refreshPresetList() {
        if (!this._presetListEl) return;
        this._presetListEl.innerHTML = '';
        const names = this.presets.listLocal();
        if (names.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'gen-preset-empty';
            empty.textContent = 'No saved characters yet';
            this._presetListEl.appendChild(empty);
            return;
        }
        for (const name of names) {
            const item = document.createElement('div');
            item.className = 'gen-preset-item';

            const lbl = document.createElement('button');
            lbl.className = 'gen-preset-load';
            lbl.textContent = name;
            lbl.title = 'Load this character';
            lbl.addEventListener('click', async () => {
                const preset = this.presets.loadLocal(name);
                if (preset) {
                    try { await this.presets.apply(preset); }
                    catch (e) { console.error(e); }
                }
            });

            const dl = document.createElement('button');
            dl.className = 'gen-preset-mini';
            dl.textContent = '⬇';
            dl.title = 'Download .json';
            dl.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const preset = this.presets.loadLocal(name);
                if (preset) this.presets.download(preset);
            });

            const del = document.createElement('button');
            del.className = 'gen-preset-mini';
            del.textContent = '×';
            del.title = 'Delete';
            del.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (confirm(`Delete "${name}"?`)) {
                    this.presets.deleteLocal(name);
                    this._refreshPresetList();
                }
            });

            item.appendChild(lbl);
            item.appendChild(dl);
            item.appendChild(del);
            this._presetListEl.appendChild(item);
        }
    }
}
