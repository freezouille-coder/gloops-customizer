export class PropsControls {
    constructor(propsManager) {
        this.pm = propsManager;
        this.container = null;
    }

    build(container) {
        this.container = container;
        this.container.innerHTML = '';

        const groups = this.pm.getCatalogByCategory();

        // Build catalog sections by category (if any)
        for (const [category, props] of Object.entries(groups)) {
            this.container.appendChild(this._buildCategorySection(category, props));
        }

        // Custom upload — always available
        this.container.appendChild(this._buildUploadSection());

        // Active props controls — always built so it can populate later
        const activeDiv = document.createElement('div');
        activeDiv.id = 'active-props-list';
        this.container.appendChild(activeDiv);
        this._rebuildActiveList();

        // Paired props offset tweaker (auto-attached props from animations)
        const pairedDiv = document.createElement('div');
        pairedDiv.id = 'paired-props-tweaker';
        this.container.appendChild(pairedDiv);
        this._rebuildPairedTweaker();
        this.pm.onPairedChange(() => this._rebuildPairedTweaker());
    }

    _rebuildPairedTweaker() {
        const div = document.getElementById('paired-props-tweaker');
        if (!div) return;
        div.innerHTML = '';

        const active = this.pm.getActivePaired ? this.pm.getActivePaired() : [];
        if (active.length === 0) return;

        const title = document.createElement('div');
        title.className = 'mat-section-title';
        title.textContent = 'Paired Prop Offsets';
        title.style.paddingTop = '12px';
        div.appendChild(title);

        for (const entry of active) {
            div.appendChild(this._buildOffsetCard(entry));
        }
    }

    _buildOffsetCard(entry) {
        const { propId, category, filename, type, offset } = entry;

        const card = document.createElement('div');
        card.className = 'mat-section';
        card.style.padding = '8px';
        card.style.marginTop = '6px';

        const head = document.createElement('div');
        head.className = 'gen-row';
        head.innerHTML = `<span class="gen-label"><b>${category}/${filename.replace(/\.fbx$/i,'')}</b> <small style="color:#888">[Type ${type}]</small></span>`;
        card.appendChild(head);

        // Local mutable state
        const state = {
            rotation: [...(offset.rotation || [0, 0, 0])],
            position: [...(offset.position || [0, 0, 0])],
            scale:    typeof offset.scale === 'number'
                ? offset.scale
                : (Array.isArray(offset.scale) ? offset.scale[0] : 1),
        };

        const apply = () => {
            this.pm.setPairedOffset(propId, {
                rotation: state.rotation,
                position: state.position,
                scale:    state.scale,
            });
        };

        const makeSlider = (label, min, max, step, value, onChange) => {
            const row = document.createElement('div');
            row.className = 'mat-row';
            row.style.gap = '6px';
            const lbl = document.createElement('span');
            lbl.className = 'mat-label';
            lbl.textContent = label;
            lbl.style.minWidth = '24px';
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = min; slider.max = max; slider.step = step; slider.value = value;
            slider.style.flex = '1';
            const num = document.createElement('input');
            num.type = 'number';
            num.value = value; num.step = step; num.min = min; num.max = max;
            num.style.width = '60px';
            slider.addEventListener('input', () => {
                num.value = slider.value;
                onChange(parseFloat(slider.value));
            });
            num.addEventListener('input', () => {
                slider.value = num.value;
                onChange(parseFloat(num.value));
            });
            row.appendChild(lbl);
            row.appendChild(slider);
            row.appendChild(num);
            return row;
        };

        // Rotation X / Y / Z (degrees)
        const rotHead = document.createElement('div');
        rotHead.style.cssText = 'font-size:11px;color:#aaa;margin-top:6px;';
        rotHead.textContent = 'Rotation (deg)';
        card.appendChild(rotHead);
        ['X','Y','Z'].forEach((axis, i) => {
            card.appendChild(makeSlider(axis, -180, 180, 1, state.rotation[i], (v) => {
                state.rotation[i] = v; apply();
            }));
        });

        // Position X / Y / Z
        const posHead = document.createElement('div');
        posHead.style.cssText = 'font-size:11px;color:#aaa;margin-top:6px;';
        posHead.textContent = 'Position';
        card.appendChild(posHead);
        ['X','Y','Z'].forEach((axis, i) => {
            card.appendChild(makeSlider(axis, -2, 2, 0.01, state.position[i], (v) => {
                state.position[i] = v; apply();
            }));
        });

        // Scale
        const scHead = document.createElement('div');
        scHead.style.cssText = 'font-size:11px;color:#aaa;margin-top:6px;';
        scHead.textContent = 'Scale';
        card.appendChild(scHead);
        card.appendChild(makeSlider('S', 0.1, 3, 0.01, state.scale, (v) => {
            state.scale = v; apply();
        }));

        // Copy JSON button — outputs the line ready to paste in paired-offsets.json
        const copyBtn = document.createElement('button');
        copyBtn.className = 'prop-select-btn';
        copyBtn.style.marginTop = '8px';
        copyBtn.textContent = '📋 Copy JSON for paired-offsets.json';
        copyBtn.addEventListener('click', () => {
            const obj = {
                rotation: state.rotation.map((v) => +v.toFixed(2)),
                position: state.position.map((v) => +v.toFixed(3)),
                scale:    +state.scale.toFixed(3),
            };
            const line = `"${category}/${filename}": ${JSON.stringify(obj)}`;
            navigator.clipboard.writeText(line).then(() => {
                copyBtn.textContent = '✓ Copied!';
                setTimeout(() => copyBtn.textContent = '📋 Copy JSON for paired-offsets.json', 1200);
            });
            console.log('[paired-offset]', line);
        });
        card.appendChild(copyBtn);

        return card;
    }

    _buildCategorySection(category, props) {
        const section = document.createElement('div');
        section.className = 'mat-section';

        const header = document.createElement('div');
        header.className = 'mat-section-title mat-section-toggle';
        const label = document.createElement('span');
        label.textContent = category;
        const arrow = document.createElement('span');
        arrow.className = 'section-arrow';
        arrow.textContent = '▼';
        header.appendChild(label);
        header.appendChild(arrow);
        section.appendChild(header);

        const content = document.createElement('div');
        content.className = 'section-content';

        // None option
        const noneRow = document.createElement('div');
        noneRow.className = 'gen-row';
        const noneBtn = document.createElement('button');
        noneBtn.className = 'prop-select-btn';
        noneBtn.textContent = '✕ None';
        noneBtn.addEventListener('click', () => {
            // Deactivate all props in this category
            for (const p of props) {
                const id = 'prop_' + p.name;
                if (this.pm.props.has(id)) {
                    this.pm.deactivateProp(id);
                }
            }
            this._updateCategoryHighlight(content, null);
            this._rebuildActiveList();
        });
        noneRow.appendChild(noneBtn);
        content.appendChild(noneRow);

        // Prop buttons
        for (const prop of props) {
            const row = document.createElement('div');
            row.className = 'gen-row';

            const btn = document.createElement('button');
            btn.className = 'prop-select-btn';
            btn.dataset.propName = prop.name;
            btn.textContent = prop.name.replace(/[_-]/g, ' ');
            if (prop.animation) {
                btn.textContent += ' 🎬'; // has animation indicator
            }

            btn.addEventListener('click', async () => {
                btn.textContent = 'Loading...';
                await this.pm.activateProp(prop.name);
                btn.textContent = prop.name.replace(/[_-]/g, ' ') + (prop.animation ? ' 🎬' : '');
                this._updateCategoryHighlight(content, prop.name);
                this._rebuildActiveList();
            });

            row.appendChild(btn);
            content.appendChild(row);
        }

        section.appendChild(content);

        header.addEventListener('click', () => {
            const hidden = content.style.display === 'none';
            content.style.display = hidden ? '' : 'none';
            arrow.textContent = hidden ? '▼' : '▶';
        });

        return section;
    }

    _updateCategoryHighlight(content, activeName) {
        content.querySelectorAll('.prop-select-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.propName === activeName);
        });
    }

    _buildUploadSection() {
        const section = document.createElement('div');
        section.className = 'mat-section';

        const header = document.createElement('div');
        header.className = 'mat-section-title mat-section-toggle';
        const label = document.createElement('span');
        label.textContent = 'Custom Upload';
        const arrow = document.createElement('span');
        arrow.className = 'section-arrow';
        arrow.textContent = '▶';
        header.appendChild(label);
        header.appendChild(arrow);
        section.appendChild(header);

        const content = document.createElement('div');
        content.className = 'section-content';
        content.style.display = 'none';

        // Bone selector
        const boneRow = document.createElement('div');
        boneRow.className = 'mat-row';
        const boneLbl = document.createElement('span');
        boneLbl.className = 'mat-label';
        boneLbl.textContent = 'Bone';
        const boneSelect = document.createElement('select');
        boneSelect.className = 'category-select';
        boneSelect.style.flex = '1';
        for (const name of this.pm.getBoneNames()) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            boneSelect.appendChild(opt);
        }
        boneRow.appendChild(boneLbl);
        boneRow.appendChild(boneSelect);
        content.appendChild(boneRow);

        // Upload
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.fbx';
        fileInput.style.display = 'none';

        const uploadBtn = document.createElement('button');
        uploadBtn.className = 'prop-select-btn';
        uploadBtn.textContent = '+ Upload FBX';
        uploadBtn.style.width = '100%';

        fileInput.addEventListener('change', async () => {
            if (!fileInput.files[0]) return;
            // Manual upload logic (simplified)
            uploadBtn.textContent = 'Loading...';
            try {
                await this.pm.loadPropFromFile(fileInput.files[0], boneSelect.value);
                this._rebuildActiveList();
            } catch (e) {
                console.error(e);
            }
            uploadBtn.textContent = '+ Upload FBX';
            fileInput.value = '';
        });
        uploadBtn.addEventListener('click', () => fileInput.click());

        const uploadRow = document.createElement('div');
        uploadRow.className = 'mat-row';
        uploadRow.appendChild(uploadBtn);
        uploadRow.appendChild(fileInput);
        content.appendChild(uploadRow);

        section.appendChild(content);

        header.addEventListener('click', () => {
            const hidden = content.style.display === 'none';
            content.style.display = hidden ? '' : 'none';
            arrow.textContent = hidden ? '▼' : '▶';
        });

        return section;
    }

    _rebuildActiveList() {
        const listDiv = document.getElementById('active-props-list');
        if (!listDiv) return;
        listDiv.innerHTML = '';

        const active = this.pm.getActiveProps();
        if (active.length === 0) return;

        const title = document.createElement('div');
        title.className = 'mat-section-title';
        title.textContent = 'Active Props';
        title.style.paddingTop = '12px';
        listDiv.appendChild(title);

        for (const { id, name, boneName } of active) {
            const row = document.createElement('div');
            row.className = 'gen-row';

            const lbl = document.createElement('span');
            lbl.className = 'gen-label';
            lbl.textContent = `${name.replace(/[_-]/g, ' ')} → ${boneName}`;

            const removeBtn = document.createElement('button');
            removeBtn.textContent = '✕';
            removeBtn.className = 'mat-btn mat-btn-clear';
            removeBtn.addEventListener('click', () => {
                this.pm.deactivateProp(id);
                this._rebuildActiveList();
            });

            row.appendChild(lbl);
            row.appendChild(removeBtn);
            listDiv.appendChild(row);
        }
    }
}
