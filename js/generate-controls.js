import { COLOR_PALETTE } from './palette.js';

/**
 * Generate tab: create random characters by randomizing
 * selected attributes (colors, animations, teeth, patterns, etc.)
 */
export class GenerateControls {
    constructor(character, shadingManager, manifest) {
        this.character = character;
        this.sm = shadingManager;
        this.manifest = manifest;
        this.container = null;
    }

    build(container) {
        this.container = container;
        this.container.innerHTML = '';

        // --- Random All button ---
        const randomAllBtn = document.createElement('button');
        randomAllBtn.textContent = '🎲 Generate Random Character';
        randomAllBtn.style.cssText = 'width:calc(100% - 16px);padding:14px;margin:8px;background:linear-gradient(135deg,#e94560,#ff6b8a);color:white;border:none;border-radius:12px;font-size:1.05rem;font-weight:800;cursor:pointer;letter-spacing:0.5px;box-shadow:0 4px 15px rgba(233,69,96,0.4);transition:transform 0.1s;';
        randomAllBtn.addEventListener('mousedown', () => randomAllBtn.style.transform = 'scale(0.97)');
        randomAllBtn.addEventListener('mouseup', () => randomAllBtn.style.transform = '');
        randomAllBtn.addEventListener('click', () => this._randomizeAll());
        this.container.appendChild(randomAllBtn);

        // --- Sections ---
        this._buildAnimSection();
        this._buildColorSection();
        this._buildPatternSection();
        this._buildEyesSection();
    }

    // ----- Animation Section -----

    _buildAnimSection() {
        const section = this._section('Animation', false);

        // Emotion random
        const emotionRow = this._row('Emotion');
        const emotionBtn = this._randomBtn(() => this._randomizeEmotion());
        emotionRow.appendChild(emotionBtn);
        section.content.appendChild(emotionRow);

        // Teeths random
        const teethRow = this._row('Teeths');
        const teethBtn = this._randomBtn(() => this._randomizeTeeths());
        teethRow.appendChild(teethBtn);
        section.content.appendChild(teethRow);

        this.container.appendChild(section.el);
    }

    // ----- Color Section -----

    _buildColorSection() {
        const section = this._section('Colors', false);

        // Body color
        const bodyRow = this._row('Body Color');
        bodyRow.appendChild(this._randomBtn(() => this._randomizeBodyColor()));
        section.content.appendChild(bodyRow);

        // Body color palette preview (shows which colors are available)
        const paletteRow = document.createElement('div');
        paletteRow.className = 'palette-row';
        paletteRow.style.padding = '4px 14px';
        for (const c of COLOR_PALETTE) {
            const s = document.createElement('div');
            s.style.cssText = `width:16px;height:16px;border-radius:3px;background:${c.hex};`;
            s.title = c.name;
            s.style.cursor = 'pointer';
            s.addEventListener('click', () => this._setBodyColor(c.hex));
            paletteRow.appendChild(s);
        }
        section.content.appendChild(paletteRow);

        // Horns color
        const hornsRow = this._row('Horns Color');
        hornsRow.appendChild(this._randomBtn(() => this._randomizeColor('horns')));
        section.content.appendChild(hornsRow);

        this.container.appendChild(section.el);
    }

    // ----- Pattern Section -----

    _buildPatternSection() {
        const section = this._section('Pattern');

        // Body pattern
        const bodyPatRow = this._row('Body Pattern');
        bodyPatRow.appendChild(this._randomBtn(() => this._randomizePattern('body')));
        section.content.appendChild(bodyPatRow);

        // Body pattern thumbnails
        const matNames = this.sm.getMaterialNames();
        const bodyMat = matNames.find(n => n.toLowerCase().includes('body'));
        if (bodyMat) {
            const entry = this.sm.getEntry(bodyMat);
            if (entry && entry._patternVariants && entry._patternVariants.length > 0) {
                const thumbRow = document.createElement('div');
                thumbRow.className = 'palette-row';
                thumbRow.style.padding = '4px 14px';
                for (const v of entry._patternVariants) {
                    const thumb = document.createElement('canvas');
                    thumb.width = 28; thumb.height = 28;
                    thumb.style.cssText = 'border:2px solid #0f3460;border-radius:3px;cursor:pointer;background:#0a0f1e;';
                    const img = new Image();
                    img.onload = () => thumb.getContext('2d').drawImage(img, 0, 0, 28, 28);
                    img.src = v.path;
                    thumb.addEventListener('click', () => {
                        const fullImg = new Image();
                        fullImg.onload = () => this.sm.setPatternMap(bodyMat, fullImg);
                        fullImg.src = v.path;
                    });
                    thumbRow.appendChild(thumb);
                }
                section.content.appendChild(thumbRow);
            }
        }

        // Horns pattern
        const hornsPatRow = this._row('Horns Pattern');
        hornsPatRow.appendChild(this._randomBtn(() => this._randomizePattern('horns')));
        section.content.appendChild(hornsPatRow);

        // Mode toggle
        const modeRow = this._row('Mode');
        const modeSelect = document.createElement('select');
        modeSelect.className = 'category-select';
        modeSelect.style.flex = '1';
        for (const m of ['casual', 'luxury']) {
            const o = document.createElement('option');
            o.value = m;
            o.textContent = m.charAt(0).toUpperCase() + m.slice(1);
            modeSelect.appendChild(o);
        }
        modeSelect.addEventListener('change', () => {
            for (const name of this.sm.getMaterialNames()) {
                this.sm.setPatternMode(name, modeSelect.value);
            }
        });
        modeRow.appendChild(modeSelect);
        section.content.appendChild(modeRow);

        this.container.appendChild(section.el);
    }

    // ----- Eyes Section -----

    _buildEyesSection() {
        const section = this._section('Eyes');

        const eyeRow = this._row('Eye Style');
        eyeRow.appendChild(this._randomBtn(() => this._randomizeEyes()));
        section.content.appendChild(eyeRow);

        // Eye variant thumbnails
        const matNames = this.sm.getMaterialNames();
        const eyeMat = matNames.find(n => n.toLowerCase().includes('eye') &&
            !n.toLowerCase().includes('glass') && !n.toLowerCase().includes('brow') && !n.toLowerCase().includes('lid'));
        if (eyeMat) {
            const entry = this.sm.getEntry(eyeMat);
            if (entry && entry._diffuseVariants && entry._diffuseVariants.length > 0) {
                const thumbRow = document.createElement('div');
                thumbRow.className = 'palette-row';
                thumbRow.style.padding = '4px 14px';
                for (const v of entry._diffuseVariants) {
                    const thumb = document.createElement('canvas');
                    thumb.width = 32; thumb.height = 32;
                    thumb.style.cssText = 'border:2px solid #0f3460;border-radius:3px;cursor:pointer;background:#0a0f1e;';
                    const img = new Image();
                    img.onload = () => thumb.getContext('2d').drawImage(img, 0, 0, 32, 32);
                    img.src = v.path;
                    thumb.addEventListener('click', () => {
                        const fullImg = new Image();
                        fullImg.onload = () => {
                            this.sm.setRGBTextureA(eyeMat, 0, fullImg, v.path);
                            thumbRow.querySelectorAll('canvas').forEach(t => t.style.borderColor = '#0f3460');
                            thumb.style.borderColor = '#e94560';
                        };
                        fullImg.src = v.path;
                    });
                    thumbRow.appendChild(thumb);
                }
                section.content.appendChild(thumbRow);
            }
        }

        this.container.appendChild(section.el);
    }

    // ----- Randomize Functions -----

    _randomizeAll() {
        this._randomizeEmotion();
        this._randomizeTeeths();
        this._randomizeBodyColor();
        this._randomizeColor('horns');
        this._randomizePattern('body');
        this._randomizePattern('horns');
        this._randomizeEyes();
    }

    _randomizeEmotion() {
        const items = this.character.getCategoryItems('Emotion');
        if (items.length > 0) {
            const pick = items[Math.floor(Math.random() * items.length)];
            this.character.selectItem('Emotion', pick.filename);
        }
    }

    _randomizeTeeths() {
        const items = this.character.getCategoryItems('Teeths');
        if (items.length > 0) {
            const pick = items[Math.floor(Math.random() * items.length)];
            this.character.selectItem('Teeths', pick.filename);
        }
    }

    _randomizeBodyColor() {
        const pick = COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
        const bodyMat = this.sm.getMaterialNames().find(n => n.toLowerCase().includes('body'));
        if (bodyMat) {
            this.sm.setRGBColorA(bodyMat, 0, pick.hex);
        }
    }

    _setBodyColor(hex) {
        const bodyMat = this.sm.getMaterialNames().find(n => n.toLowerCase().includes('body'));
        if (bodyMat) {
            this.sm.setRGBColorA(bodyMat, 0, hex);
        }
    }

    _randomizeColor(meshKeyword) {
        const pick = COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
        const mat = this.sm.getMaterialNames().find(n => n.toLowerCase().includes(meshKeyword));
        if (mat) {
            this.sm.setRGBColorA(mat, 0, pick.hex);
        }
    }

    _randomizePattern(meshKeyword) {
        const mat = this.sm.getMaterialNames().find(n => n.toLowerCase().includes(meshKeyword));
        if (!mat) return;
        const entry = this.sm.getEntry(mat);
        if (!entry || !entry._patternVariants || entry._patternVariants.length === 0) return;

        const pick = entry._patternVariants[Math.floor(Math.random() * entry._patternVariants.length)];
        const img = new Image();
        img.onload = () => this.sm.setPatternMap(mat, img);
        img.src = pick.path;
    }

    _randomizeEyes() {
        const mat = this.sm.getMaterialNames().find(n =>
            n.toLowerCase().includes('eye') && !n.toLowerCase().includes('glass') &&
            !n.toLowerCase().includes('brow') && !n.toLowerCase().includes('lid'));
        if (!mat) return;
        const entry = this.sm.getEntry(mat);
        if (!entry || !entry._diffuseVariants || entry._diffuseVariants.length === 0) return;

        const pick = entry._diffuseVariants[Math.floor(Math.random() * entry._diffuseVariants.length)];
        const img = new Image();
        img.onload = () => this.sm.setRGBTextureA(mat, 0, img, pick.path);
        img.src = pick.path;
    }

    // ----- UI Helpers -----

    _section(title, collapsed = true) {
        const el = document.createElement('div');
        el.className = 'mat-section';

        const header = document.createElement('div');
        header.className = 'mat-section-title mat-section-toggle';

        const label = document.createElement('span');
        label.textContent = title;
        const arrow = document.createElement('span');
        arrow.className = 'section-arrow';
        arrow.textContent = collapsed ? '▶' : '▼';

        header.appendChild(label);
        header.appendChild(arrow);
        el.appendChild(header);

        const content = document.createElement('div');
        content.className = 'section-content';
        if (collapsed) content.style.display = 'none';
        el.appendChild(content);

        header.addEventListener('click', () => {
            const hidden = content.style.display === 'none';
            content.style.display = hidden ? '' : 'none';
            arrow.textContent = hidden ? '▼' : '▶';
        });

        return { el, content };
    }

    _row(label) {
        const row = document.createElement('div');
        row.className = 'mat-row';
        const lbl = document.createElement('span');
        lbl.className = 'mat-label';
        lbl.textContent = label;
        row.appendChild(lbl);
        return row;
    }

    _randomBtn(onClick) {
        const btn = document.createElement('button');
        btn.textContent = '🎲';
        btn.className = 'btn-category-random';
        btn.addEventListener('click', onClick);
        return btn;
    }
}
