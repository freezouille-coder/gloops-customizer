import { formatTraitName } from './utils.js';
import { COLOR_PALETTE, getTexturePath } from './palette.js';
import * as THREE from 'three';

export class ShaderControls {
    constructor(shadingManager) {
        this.sm = shadingManager;
        this.container = null;
        this.currentMat = null;
    }

    build(container) {
        this.container = container;
        this.container.innerHTML = '';

        const names = this.sm.getMaterialNames();
        if (names.length === 0) {
            this.container.innerHTML = '<p style="padding:16px;color:#888;">Aucun materiau detecte.</p>';
            return;
        }

        // Material selector
        const selectorDiv = document.createElement('div');
        selectorDiv.className = 'mat-selector';
        const select = document.createElement('select');
        select.className = 'category-select';
        select.id = 'mat-select';
        for (const name of names) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = formatTraitName(name);
            select.appendChild(opt);
        }
        select.addEventListener('change', () => this._selectMaterial(select.value));
        selectorDiv.appendChild(select);
        this.container.appendChild(selectorDiv);

        // Detail panel
        const detail = document.createElement('div');
        detail.id = 'mat-detail';
        this.container.appendChild(detail);

        this._selectMaterial(names[0]);
    }

    _selectMaterial(name) {
        this.currentMat = name;
        const detail = document.getElementById('mat-detail');
        detail.innerHTML = '';

        const entry = this.sm.getEntry(name);
        if (!entry) return;

        // === SHADING MODE ===
        detail.appendChild(this._buildSection('Shading Mode', [
            this._buildCheckbox('Flat / Unlit', entry._isFlat || false,
                (v) => this.sm.setFlat(name, v)),
            this._buildCheckbox('Double Sided',
                entry.material.side === THREE.DoubleSide,
                (v) => this.sm.setDoubleSided(name, v)),
        ], false));

        // === DIFFUSE ===

        // --- RGB Mask ---
        detail.appendChild(this._buildSection('RGB Mask', [
            this._buildTextureOnly('RGBA Mask', entry.rgbMask,
                (t) => this.sm.setRGBMask(name, t),
                () => this.sm.setRGBMask(name, null)
            ),
        ]));

        // --- Blend Mask (B&W — controls A/B blend for all channels) ---
        detail.appendChild(this._buildSection('Blend Mask (A/B)', [
            this._buildTextureOnly('Mask', entry.mask,
                (t) => this.sm.setMask(name, t),
                () => this.sm.setMask(name, null)
            ),
        ]));

        // --- R Channel (Diffuse) ---
        const rChildren = [];
        // Show diffuse variants as thumbnails if available
        if (entry._diffuseVariants && entry._diffuseVariants.length > 1) {
            rChildren.push(this._buildDiffuseVariants(name, entry._diffuseVariants));
        }
        rChildren.push(this._buildChannelPalette(name, 0, 'A'));
        rChildren.push(this._buildChannelPalette(name, 0, 'B'));
        detail.appendChild(this._buildSection('R Channel', rChildren, false));

        // --- G Channel ---
        detail.appendChild(this._buildSection('G Channel', [
            this._buildChannelPalette(name, 1, 'A'),
            this._buildChannelPalette(name, 1, 'B'),
        ]));

        // --- B Channel ---
        detail.appendChild(this._buildSection('B Channel', [
            this._buildChannelPalette(name, 2, 'A'),
            this._buildChannelPalette(name, 2, 'B'),
        ]));

        // --- Diffuse Weight ---
        detail.appendChild(this._buildSection('Diffuse / Specular', [
            this._buildSlider('Diffuse Weight', 1.0, 0, 2, 0.01,
                (v) => this.sm.setDiffuseWeight(name, v)),
            this._buildTextureOnly('Diffuse Weight Map', entry.diffuseWeightMap,
                (t) => this.sm.setDiffuseWeightMap(name, t),
                () => this.sm.setDiffuseWeightMap(name, null)
            ),
            this._buildSlider('Specular Intensity', 1.0, 0, 2, 0.01,
                (v) => this.sm.setSpecularIntensity(name, v)),
            this._buildColorPicker('Specular Color', new THREE.Color(1, 1, 1),
                (c) => this.sm.setSpecularColor(name, c)),
            this._buildSlider('Fresnel (IOR)', 1.5, 1.0, 3.0, 0.01,
                (v) => this.sm.setIOR(name, v)),
        ]));

        // --- Pattern ---
        const patternChildren = [];

        // Pattern variants (thumbnails)
        if (entry._patternVariants && entry._patternVariants.length > 0) {
            patternChildren.push(this._buildPatternVariants(name, entry._patternVariants));
        }

        // Mode selector
        const modeRow = document.createElement('div');
        modeRow.className = 'mat-row';
        const modeLbl = document.createElement('span');
        modeLbl.className = 'mat-label';
        modeLbl.textContent = 'Mode';
        const modeSelect = document.createElement('select');
        modeSelect.className = 'category-select';
        modeSelect.style.flex = '1';
        for (const opt of ['casual', 'luxury']) {
            const o = document.createElement('option');
            o.value = opt;
            o.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
            if (opt === (entry.patternMode || 'off')) o.selected = true;
            modeSelect.appendChild(o);
        }
        modeSelect.addEventListener('change', () => this.sm.setPatternMode(name, modeSelect.value));
        modeRow.appendChild(modeLbl);
        modeRow.appendChild(modeSelect);
        patternChildren.push(modeRow);

        patternChildren.push(this._buildTextureOnly('Pattern Map', entry.patternMap,
            (t) => this.sm.setPatternMap(name, t),
            () => this.sm.setPatternMap(name, null)));
        patternChildren.push(this._buildSlider('Intensity', entry.patternIntensity || 0.5, 0, 1, 0.01,
            (v) => this.sm.setPatternIntensity(name, v)));
        patternChildren.push(this._buildSlider('Bump Scale', entry.patternBumpScale || 0.15, 0, 1, 0.01,
            (v) => this.sm.setPatternBumpScale(name, v)));
        patternChildren.push(this._buildSlider('Hue Shift', entry.patternHueShift || 0, -180, 180, 1,
            (v) => this.sm.setPatternHueShift(name, v)));
        patternChildren.push(this._buildSlider('Saturation', entry.patternSatShift || 0, -1, 1, 0.01,
            (v) => this.sm.setPatternSatShift(name, v)));

        detail.appendChild(this._buildSection('Pattern', patternChildren));

        // --- PBR section ---
        detail.appendChild(this._buildSection('PBR', [
            this._buildSliderWithTexture('Roughness', entry.material.roughness, 0, 1, 0.01,
                (v) => this.sm.setRoughness(name, v),
                (t) => this.sm.setRoughnessMap(name, t),
                () => this.sm.setRoughnessMap(name, null)
            ),
            this._buildSliderWithTexture('Metalness', entry.material.metalness, 0, 1, 0.01,
                (v) => this.sm.setMetalness(name, v),
                (t) => this.sm.setMetalnessMap(name, t),
                () => this.sm.setMetalnessMap(name, null)
            ),
            this._buildTextureOnly('Normal Map', entry.material.normalMap,
                (t) => this.sm.setNormalMap(name, t),
                () => this.sm.setNormalMap(name, null)
            ),
            this._buildTextureOnly('Bump Map', entry.material.bumpMap,
                (t) => this.sm.setBumpMap(name, t),
                () => this.sm.setBumpMap(name, null)
            ),
            this._buildSlider('Bump Scale', entry._bumpScale || 0.05, 0, 0.5, 0.005,
                (v) => this.sm.setBumpScale(name, v)),
            this._buildTextureOnly('Occlusion', entry.material.aoMap,
                (t) => this.sm.setAOMap(name, t),
                () => this.sm.setAOMap(name, null)
            ),
        ]));

        // --- Displacement ---
        const hasDisp = entry.material.displacementMap !== null;
        detail.appendChild(this._buildSection('Displacement', [
            this._buildCheckbox('Enable', hasDisp, (v) => {
                if (!v) {
                    this.sm.setDisplacementMap(name, null);
                } else if (entry._displacementAvailable) {
                    // Reload from stored path
                    const img = new Image();
                    img.onload = () => this.sm.setDisplacementMap(name, img);
                    img.src = entry._displacementAvailable;
                }
            }),
            this._buildTextureOnly('Map', entry.material.displacementMap,
                (t) => this.sm.setDisplacementMap(name, t),
                () => this.sm.setDisplacementMap(name, null)
            ),
            this._buildSlider('Scale', 0.1, 0, 1, 0.01,
                (v) => this.sm.setDisplacementScale(name, v)),
            this._buildSlider('Bias', 0, -0.5, 0.5, 0.01,
                (v) => this.sm.setDisplacementBias(name, v)),
        ]));

        // --- SSS ---
        detail.appendChild(this._buildSection('Subsurface (SSS)', [
            this._buildSlider('Transmission', 0, 0, 1, 0.01,
                (v) => this.sm.setTransmission(name, v)),
            this._buildSlider('Thickness', 0, 0, 5, 0.1,
                (v) => this.sm.setThickness(name, v)),
            this._buildSlider('IOR', 1.5, 1, 2.5, 0.01,
                (v) => this.sm.setIOR(name, v)),
            this._buildColorPicker('Attenuation Color', new THREE.Color(0.8, 0.3, 0.2),
                (c) => this.sm.setAttenuationColor(name, c)),
            this._buildSlider('Attenuation Dist.', 0.5, 0.01, 5, 0.05,
                (v) => this.sm.setAttenuationDistance(name, v)),
        ]));

        // --- Sheen ---
        detail.appendChild(this._buildSection('Sheen', [
            this._buildSlider('Intensity', 0, 0, 1, 0.01,
                (v) => this.sm.setSheen(name, v)),
            this._buildSlider('Roughness', 0.5, 0, 1, 0.01,
                (v) => this.sm.setSheenRoughness(name, v)),
            this._buildColorPicker('Color', new THREE.Color(1, 1, 1),
                (c) => this.sm.setSheenColor(name, c)),
        ]));

        // --- Clearcoat ---
        detail.appendChild(this._buildSection('Clearcoat', [
            this._buildSlider('Intensity', 0, 0, 1, 0.01,
                (v) => this.sm.setClearcoat(name, v)),
            this._buildSlider('Roughness', 0, 0, 1, 0.01,
                (v) => this.sm.setClearcoatRoughness(name, v)),
        ]));

        // --- Alpha ---
        detail.appendChild(this._buildSection('Alpha', [
            this._buildSlider('Opacity', 1, 0, 1, 0.01,
                (v) => this.sm.setOpacity(name, v)),
            this._buildTextureOnly('Alpha Map', null,
                (t) => this.sm.setAlphaMap(name, t),
                () => this.sm.setAlphaMap(name, null)
            ),
        ]));

        // --- Emissive section ---
        const emCol = entry.material.emissive || { r: 0, g: 0, b: 0 };
        detail.appendChild(this._buildSection('Emissive', [
            this._buildCheckbox('Use Base Color', false,
                (v) => this.sm.setEmissiveUseBaseColor(name, v)),
            this._buildColorPicker('Color', emCol,
                (c) => this.sm.setEmissive(name, c, entry.material.emissiveIntensity)),
            this._buildSlider('Intensity', entry.material.emissiveIntensity || 0, 0, 5, 0.1,
                (v) => this.sm.setEmissive(name, entry.material.emissive, v)),
            this._buildTextureOnly('Weight Map', null,
                (t) => this.sm.setEmissiveMap(name, t),
                () => this.sm.setEmissiveMap(name, null)
            ),
        ]));
    }

    // ----- Palette -----

    _buildPaletteSwatches(matName, target) {
        const wrapper = document.createElement('div');
        wrapper.className = 'palette-row';

        const setActive = (el) => {
            wrapper.querySelectorAll('.palette-swatch').forEach(s => s.classList.remove('active'));
            el.classList.add('active');
        };

        for (const entry of COLOR_PALETTE) {
            const swatch = document.createElement('button');
            swatch.className = 'palette-swatch';
            swatch.style.backgroundColor = entry.hex;
            swatch.title = entry.name;

            swatch.addEventListener('click', () => {
                const texPath = getTexturePath(entry);
                const img = new Image();
                img.onload = () => {
                    if (target === 'A') this.sm.setTextureA(matName, img);
                    else this.sm.setTextureB(matName, img);
                };
                img.onerror = () => {
                    if (target === 'A') this.sm.setColorA(matName, entry.hex);
                    else this.sm.setColorB(matName, entry.hex);
                };
                img.src = texPath;
                setActive(swatch);
            });

            wrapper.appendChild(swatch);
        }

        // + button: add custom texture
        const addBtn = document.createElement('button');
        addBtn.className = 'palette-swatch palette-swatch-custom';
        addBtn.title = 'Add custom texture';
        addBtn.textContent = '+';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';

        fileInput.addEventListener('change', () => {
            if (!fileInput.files[0]) return;
            this._loadFileAsImage(fileInput.files[0], (img) => {
                if (target === 'A') this.sm.setTextureA(matName, img);
                else this.sm.setTextureB(matName, img);
                setActive(addBtn);
            });
        });

        addBtn.addEventListener('click', () => fileInput.click());

        // x button: clear texture
        const clearBtn = document.createElement('button');
        clearBtn.className = 'palette-swatch palette-swatch-clear';
        clearBtn.title = 'Clear texture';
        clearBtn.textContent = '✕';

        clearBtn.addEventListener('click', () => {
            if (target === 'A') this.sm.setTextureA(matName, null);
            else this.sm.setTextureB(matName, null);
            wrapper.querySelectorAll('.palette-swatch').forEach(s => s.classList.remove('active'));
        });

        wrapper.appendChild(addBtn);
        wrapper.appendChild(clearBtn);
        wrapper.appendChild(fileInput);

        return wrapper;
    }

    /**
     * Build a palette row for a specific RGB channel (0=R, 1=G, 2=B) and side (A or B).
     * Includes 22 presets + dynamic texture slots (+ to add, ✕ to remove last).
     */
    _buildChannelPalette(matName, channelIndex, side) {
        const channelNames = ['R', 'G', 'B', 'A'];

        const container = document.createElement('div');

        const label = document.createElement('div');
        label.className = 'palette-sublabel';
        label.textContent = `${channelNames[channelIndex]} - Color ${side}:`;
        container.appendChild(label);

        // Preset swatches row
        const presetRow = document.createElement('div');
        presetRow.className = 'palette-row';

        const applyColor = (color) => {
            // Clear texture when applying flat color
            if (side === 'A') {
                this.sm.setRGBTextureA(matName, channelIndex, null);
                this.sm.setRGBColorA(matName, channelIndex, color);
            } else {
                this.sm.setRGBTextureB(matName, channelIndex, null);
                this.sm.setRGBColorB(matName, channelIndex, color);
            }
        };

        const applyTexture = (img, path) => {
            if (side === 'A') this.sm.setRGBTextureA(matName, channelIndex, img, path);
            else this.sm.setRGBTextureB(matName, channelIndex, img, path);
        };

        const setActive = (el) => {
            presetRow.querySelectorAll('.palette-swatch').forEach(s => s.classList.remove('active'));
            // Also deactivate custom texture swatches
            texRow.querySelectorAll('.tex-swatch').forEach(s => s.classList.remove('active'));
            el.classList.add('active');
        };

        for (const entry of COLOR_PALETTE) {
            const swatch = document.createElement('button');
            swatch.className = 'palette-swatch';
            swatch.style.backgroundColor = entry.hex;
            swatch.title = entry.name;
            swatch.addEventListener('click', () => {
                // Apply flat color directly (no texture needed)
                applyColor(entry.hex);
                setActive(swatch);
            });
            presetRow.appendChild(swatch);
        }
        container.appendChild(presetRow);

        // Dynamic texture slots row
        const texRow = document.createElement('div');
        texRow.className = 'palette-row';
        const texSlots = []; // track added texture thumbnails

        const addTexSlot = () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.style.display = 'none';

            const thumb = document.createElement('canvas');
            thumb.className = 'palette-swatch tex-swatch';
            thumb.width = 24;
            thumb.height = 24;
            thumb.title = 'Click to select';
            thumb.style.border = '2px solid #0f3460';
            thumb.style.cursor = 'pointer';
            thumb._img = null;

            fileInput.addEventListener('change', () => {
                if (!fileInput.files[0]) return;
                this._loadFileAsImage(fileInput.files[0], (img) => {
                    thumb._img = img;
                    // Draw thumbnail
                    const tctx = thumb.getContext('2d');
                    tctx.clearRect(0, 0, 24, 24);
                    tctx.drawImage(img, 0, 0, 24, 24);
                    // Sample average color and apply
                    applyTexture(img);
                    setActive(thumb);
                });
                fileInput.value = '';
            });

            thumb.addEventListener('click', () => {
                if (thumb._img) {
                    // Re-select this texture
                    applyColor(this._sampleAverageColor(thumb._img));
                    setActive(thumb);
                } else {
                    // No image loaded yet, open file picker
                    fileInput.click();
                }
            });

            texSlots.push({ thumb, fileInput });

            // Insert before + and ✕ buttons
            texRow.insertBefore(thumb, addBtn);
            texRow.insertBefore(fileInput, addBtn);

            // Open file picker immediately
            fileInput.click();
        };

        // + button
        const addBtn = document.createElement('button');
        addBtn.className = 'palette-swatch palette-swatch-custom';
        addBtn.title = 'Add texture';
        addBtn.textContent = '+';
        addBtn.addEventListener('click', addTexSlot);

        // ✕ button: remove last texture slot
        const removeBtn = document.createElement('button');
        removeBtn.className = 'palette-swatch palette-swatch-clear';
        removeBtn.title = 'Remove last texture';
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', () => {
            if (texSlots.length === 0) return;
            const last = texSlots.pop();
            last.thumb.remove();
            last.fileInput.remove();
        });

        texRow.appendChild(addBtn);
        texRow.appendChild(removeBtn);
        container.appendChild(texRow);

        return container;
    }

    /**
     * Sample average color from an image.
     */
    _sampleAverageColor(img) {
        const c = document.createElement('canvas');
        c.width = 32; c.height = 32;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 32, 32);
        const data = ctx.getImageData(0, 0, 32, 32).data;
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
            r += data[i]; g += data[i+1]; b += data[i+2]; count++;
        }
        r = Math.round(r/count); g = Math.round(g/count); b = Math.round(b/count);
        return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    }

    // ----- UI Builders -----

    _buildSection(title, children, collapsed = true) {
        const section = document.createElement('div');
        section.className = 'mat-section';

        const header = document.createElement('div');
        header.className = 'mat-section-title mat-section-toggle';

        const arrow = document.createElement('span');
        arrow.className = 'section-arrow';
        arrow.textContent = collapsed ? '▶' : '▼';

        const label = document.createElement('span');
        label.textContent = title;

        header.appendChild(label);
        header.appendChild(arrow);
        section.appendChild(header);

        const content = document.createElement('div');
        content.className = 'section-content';
        if (collapsed) content.style.display = 'none';
        for (const child of children) content.appendChild(child);
        section.appendChild(content);

        header.addEventListener('click', () => {
            const isHidden = content.style.display === 'none';
            content.style.display = isHidden ? '' : 'none';
            arrow.textContent = isHidden ? '▼' : '▶';
        });

        return section;
    }

    _buildTextureOnly(label, currentTex, onTexture, onClear) {
        const row = document.createElement('div');
        row.className = 'mat-row';

        const lbl = document.createElement('span');
        lbl.className = 'mat-label';
        lbl.textContent = label;

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';

        const thumb = document.createElement('canvas');
        thumb.className = 'mat-thumbnail';
        thumb.width = 36;
        thumb.height = 36;
        thumb.title = 'Drag & drop or click 📁';

        // Show current texture thumbnail if connected
        if (currentTex) {
            try {
                const src = currentTex.image || currentTex;
                if (src && (src.width || src.naturalWidth)) {
                    const tctx = thumb.getContext('2d');
                    tctx.drawImage(src, 0, 0, 36, 36);
                }
            } catch(e) {}
        }

        fileInput.addEventListener('change', () => {
            if (fileInput.files[0]) this._loadFileAsImage(fileInput.files[0], onTexture, thumb);
            fileInput.value = ''; // reset so same file can be re-selected
        });

        const loadBtn = document.createElement('button');
        loadBtn.className = 'mat-btn';
        loadBtn.textContent = '📁';
        loadBtn.title = 'Load texture';
        loadBtn.addEventListener('click', () => fileInput.click());

        const clearBtn = document.createElement('button');
        clearBtn.className = 'mat-btn mat-btn-clear';
        clearBtn.textContent = '✕';
        clearBtn.addEventListener('click', () => {
            onClear();
            const ctx = thumb.getContext('2d');
            ctx.clearRect(0, 0, thumb.width, thumb.height);
        });

        thumb.addEventListener('dragover', (e) => { e.preventDefault(); thumb.classList.add('drag-over'); });
        thumb.addEventListener('dragleave', () => thumb.classList.remove('drag-over'));
        thumb.addEventListener('drop', (e) => {
            e.preventDefault();
            thumb.classList.remove('drag-over');
            if (e.dataTransfer.files[0]) this._loadFileAsImage(e.dataTransfer.files[0], onTexture, thumb);
        });

        row.appendChild(lbl);
        row.appendChild(loadBtn);
        row.appendChild(clearBtn);
        row.appendChild(thumb);
        row.appendChild(fileInput);
        return row;
    }

    _buildSliderWithTexture(label, value, min, max, step, onSlider, onTexture, onClear) {
        const container = document.createElement('div');

        // Slider row
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
            onSlider(parseFloat(slider.value));
        });
        row.appendChild(lbl);
        row.appendChild(slider);
        row.appendChild(val);
        container.appendChild(row);

        // Texture row (indented)
        const texRow = document.createElement('div');
        texRow.className = 'mat-row';
        const texLbl = document.createElement('span');
        texLbl.className = 'mat-label';
        texLbl.textContent = 'Map';
        texLbl.style.fontSize = '0.65rem';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';

        const thumb = document.createElement('canvas');
        thumb.className = 'mat-thumbnail';
        thumb.width = 36;
        thumb.height = 36;

        fileInput.addEventListener('change', () => {
            if (fileInput.files[0]) this._loadFileAsImage(fileInput.files[0], onTexture, thumb);
            fileInput.value = '';
        });

        const loadBtn = document.createElement('button');
        loadBtn.className = 'mat-btn';
        loadBtn.textContent = '📁';
        loadBtn.addEventListener('click', () => fileInput.click());

        const clearBtn = document.createElement('button');
        clearBtn.className = 'mat-btn mat-btn-clear';
        clearBtn.textContent = '✕';
        clearBtn.addEventListener('click', () => {
            onClear();
            thumb.getContext('2d').clearRect(0, 0, thumb.width, thumb.height);
        });

        texRow.appendChild(texLbl);
        texRow.appendChild(loadBtn);
        texRow.appendChild(clearBtn);
        texRow.appendChild(thumb);
        texRow.appendChild(fileInput);
        container.appendChild(texRow);

        return container;
    }

    _buildColorPicker(label, colorValue, onChange) {
        const row = document.createElement('div');
        row.className = 'mat-row';
        const lbl = document.createElement('span');
        lbl.className = 'mat-label';
        lbl.textContent = label;
        const picker = document.createElement('input');
        picker.type = 'color';
        picker.className = 'mat-color-picker';
        picker.value = '#' + new THREE.Color(colorValue.r, colorValue.g, colorValue.b).getHexString();
        picker.addEventListener('input', () => onChange(picker.value));
        row.appendChild(lbl);
        row.appendChild(picker);
        return row;
    }

    _buildSlider(label, value, min, max, step, onChange) {
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
        row.appendChild(lbl);
        row.appendChild(slider);
        row.appendChild(val);
        return row;
    }

    // ----- Texture loading -----

    /**
     * Build clickable thumbnail grid for pattern variants.
     */
    _buildPatternVariants(matName, variants) {
        const container = document.createElement('div');
        const label = document.createElement('div');
        label.className = 'palette-sublabel';
        label.textContent = `Patterns (${variants.length}):`;
        container.appendChild(label);

        const row = document.createElement('div');
        row.className = 'palette-row';
        row.style.gap = '4px';

        for (const v of variants) {
            const thumb = document.createElement('canvas');
            thumb.className = 'palette-swatch variant-thumb';
            thumb.width = 36; thumb.height = 36;
            thumb.title = v.variant !== null ? `Pattern ${v.variant}` : 'Default (none)';
            thumb.style.cursor = 'pointer';
            thumb.style.border = '2px solid #0f3460';
            thumb.style.borderRadius = '4px';
            thumb.style.background = '#0a0f1e';

            const img = new Image();
            img.onload = () => thumb.getContext('2d').drawImage(img, 0, 0, 36, 36);
            img.src = v.path;

            thumb.addEventListener('click', () => {
                const fullImg = new Image();
                fullImg.onload = () => {
                    this.sm.setPatternMap(matName, fullImg);
                    row.querySelectorAll('.variant-thumb').forEach(t => t.style.borderColor = '#0f3460');
                    thumb.style.borderColor = '#e94560';
                };
                fullImg.src = v.path;
            });
            row.appendChild(thumb);
        }
        container.appendChild(row);
        return container;
    }

    /**
     * Build clickable thumbnail grid for diffuse variants.
     */
    _buildDiffuseVariants(matName, variants) {
        const container = document.createElement('div');

        const label = document.createElement('div');
        label.className = 'palette-sublabel';
        label.textContent = `Diffuse Variants (${variants.length}):`;
        container.appendChild(label);

        const row = document.createElement('div');
        row.className = 'palette-row';
        row.style.gap = '4px';

        for (const v of variants) {
            const thumb = document.createElement('canvas');
            thumb.className = 'palette-swatch variant-thumb';
            thumb.width = 36;
            thumb.height = 36;
            thumb.title = v.variant !== null ? `Variant ${v.variant}` : 'Default';
            thumb.style.cursor = 'pointer';
            thumb.style.border = '2px solid #0f3460';
            thumb.style.borderRadius = '4px';
            thumb.style.background = '#0a0f1e';

            // Load and draw thumbnail
            const img = new Image();
            img.onload = () => {
                const ctx = thumb.getContext('2d');
                ctx.drawImage(img, 0, 0, 36, 36);
            };
            img.src = v.path;

            thumb.addEventListener('click', () => {
                // Load full image and apply as diffuse
                const fullImg = new Image();
                fullImg.onload = () => {
                    this.sm.setRGBTextureA(matName, 0, fullImg, v.path);
                    // Highlight active
                    row.querySelectorAll('.variant-thumb').forEach(t => t.style.borderColor = '#0f3460');
                    thumb.style.borderColor = '#e94560';
                };
                fullImg.src = v.path;
            });

            row.appendChild(thumb);
        }

        container.appendChild(row);
        return container;
    }

    _buildCheckbox(label, checked, onChange) {
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
        row.appendChild(lbl);
        row.appendChild(cb);
        return row;
    }

    _loadFileAsImage(file, callback, thumbCanvas) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                callback(img);
                if (thumbCanvas) this._drawThumbnail(thumbCanvas, img);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    _drawThumbnail(canvas, img) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
}
