import * as THREE from 'three';

export class PropsControls {
    constructor(propsManager) {
        this.pm = propsManager;
        this.container = null;
    }

    build(container) {
        this.container = container;
        this.container.innerHTML = '';

        // --- Add Prop section ---
        const addSection = document.createElement('div');
        addSection.className = 'mat-section';

        const addTitle = document.createElement('div');
        addTitle.className = 'mat-section-title';
        addTitle.textContent = 'Add Prop';
        addSection.appendChild(addTitle);

        // Bone selector
        const boneRow = document.createElement('div');
        boneRow.className = 'mat-row';
        const boneLbl = document.createElement('span');
        boneLbl.className = 'mat-label';
        boneLbl.textContent = 'Bone';
        const boneSelect = document.createElement('select');
        boneSelect.className = 'category-select';
        boneSelect.id = 'prop-bone-select';
        boneSelect.style.flex = '1';

        // Group bones by category for easier navigation
        const boneNames = this.pm.getBoneNames();
        const groups = { head: [], hand: [], spine: [], other: [] };
        for (const name of boneNames) {
            const n = name.toLowerCase();
            if (n.includes('head') || n.includes('eye') || n.includes('jaw') || n.includes('ear')) {
                groups.head.push(name);
            } else if (n.includes('hand') || n.includes('finger') || n.includes('index') || n.includes('thumb')) {
                groups.hand.push(name);
            } else if (n.includes('spine') || n.includes('pelvis') || n.includes('chest')) {
                groups.spine.push(name);
            } else {
                groups.other.push(name);
            }
        }

        for (const [groupName, bones] of Object.entries(groups)) {
            if (bones.length === 0) continue;
            const optgroup = document.createElement('optgroup');
            optgroup.label = groupName.charAt(0).toUpperCase() + groupName.slice(1);
            for (const bone of bones) {
                const opt = document.createElement('option');
                opt.value = bone;
                opt.textContent = bone;
                optgroup.appendChild(opt);
            }
            boneSelect.appendChild(optgroup);
        }

        boneRow.appendChild(boneLbl);
        boneRow.appendChild(boneSelect);
        addSection.appendChild(boneRow);

        // Maintain offset checkbox
        const offsetRow = document.createElement('div');
        offsetRow.className = 'mat-row';
        const offsetLbl = document.createElement('span');
        offsetLbl.className = 'mat-label';
        offsetLbl.textContent = 'Maintain Offset';
        const offsetCb = document.createElement('input');
        offsetCb.type = 'checkbox';
        offsetCb.className = 'mat-checkbox';
        offsetCb.id = 'prop-maintain-offset';
        offsetCb.checked = false;
        offsetRow.appendChild(offsetLbl);
        offsetRow.appendChild(offsetCb);
        addSection.appendChild(offsetRow);

        // Upload button
        const uploadRow = document.createElement('div');
        uploadRow.className = 'mat-row';
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.fbx';
        fileInput.style.display = 'none';

        const uploadBtn = document.createElement('button');
        uploadBtn.textContent = '+ Add Prop (FBX)';
        uploadBtn.className = 'mat-btn';
        uploadBtn.style.flex = '1';
        uploadBtn.style.padding = '8px';
        uploadBtn.style.width = '100%';
        uploadBtn.style.fontSize = '0.85rem';
        uploadBtn.style.background = '#0f3460';

        fileInput.addEventListener('change', async () => {
            if (!fileInput.files[0]) return;
            const boneName = boneSelect.value;
            const maintain = offsetCb.checked;
            uploadBtn.textContent = 'Loading...';
            try {
                await this.pm.loadProp(fileInput.files[0], boneName, maintain);
                this._rebuildPropsList();
                uploadBtn.textContent = '+ Add Prop (FBX)';
            } catch (e) {
                console.error('Failed to load prop:', e);
                uploadBtn.textContent = 'Error! Try again';
                setTimeout(() => { uploadBtn.textContent = '+ Add Prop (FBX)'; }, 2000);
            }
            fileInput.value = '';
        });

        uploadBtn.addEventListener('click', () => fileInput.click());
        uploadRow.appendChild(uploadBtn);
        uploadRow.appendChild(fileInput);
        addSection.appendChild(uploadRow);

        this.container.appendChild(addSection);

        // --- Props List ---
        const listDiv = document.createElement('div');
        listDiv.id = 'props-list';
        this.container.appendChild(listDiv);

        this._rebuildPropsList();
    }

    _rebuildPropsList() {
        const listDiv = document.getElementById('props-list');
        if (!listDiv) return;
        listDiv.innerHTML = '';

        const props = this.pm.getProps();
        if (props.length === 0) {
            const empty = document.createElement('p');
            empty.style.padding = '16px';
            empty.style.color = '#666';
            empty.style.textAlign = 'center';
            empty.textContent = 'No props attached.';
            listDiv.appendChild(empty);
            return;
        }

        for (const { id, name, boneName, materials } of props) {
            const section = document.createElement('div');
            section.className = 'mat-section';

            // Header with name + delete
            const header = document.createElement('div');
            header.className = 'mat-section-title';
            header.style.display = 'flex';
            header.style.justifyContent = 'space-between';
            header.style.alignItems = 'center';

            const title = document.createElement('span');
            title.textContent = `${name}`;

            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = '✕';
            deleteBtn.className = 'mat-btn mat-btn-clear';
            deleteBtn.title = 'Remove prop';
            deleteBtn.addEventListener('click', () => {
                this.pm.removeProp(id);
                this._rebuildPropsList();
            });

            header.appendChild(title);
            header.appendChild(deleteBtn);
            section.appendChild(header);

            // Bone selector (reparent)
            section.appendChild(this._row('Bone', this._boneDropdown(id, boneName)));

            // Position
            section.appendChild(this._sliderRow('Pos X', 0, -2, 2, 0.01,
                (v) => { const p = this.pm.getProp(id); this.pm.setPosition(id, v, p.model.position.y, p.model.position.z); }));
            section.appendChild(this._sliderRow('Pos Y', 0, -2, 2, 0.01,
                (v) => { const p = this.pm.getProp(id); this.pm.setPosition(id, p.model.position.x, v, p.model.position.z); }));
            section.appendChild(this._sliderRow('Pos Z', 0, -2, 2, 0.01,
                (v) => { const p = this.pm.getProp(id); this.pm.setPosition(id, p.model.position.x, p.model.position.y, v); }));

            // Rotation
            section.appendChild(this._sliderRow('Rot X', 0, -180, 180, 1,
                (v) => this.pm.setRotation(id, v, 0, 0)));
            section.appendChild(this._sliderRow('Rot Y', 0, -180, 180, 1,
                (v) => this.pm.setRotation(id, 0, v, 0)));
            section.appendChild(this._sliderRow('Rot Z', 0, -180, 180, 1,
                (v) => this.pm.setRotation(id, 0, 0, v)));

            // Scale
            section.appendChild(this._sliderRow('Scale', 1, 0.01, 5, 0.01,
                (v) => this.pm.setScale(id, v)));

            // Materials list
            if (materials.length > 0) {
                const matTitle = document.createElement('div');
                matTitle.className = 'palette-sublabel';
                matTitle.textContent = `Materials: ${materials.join(', ')}`;
                matTitle.style.fontSize = '0.6rem';
                section.appendChild(matTitle);
            }

            listDiv.appendChild(section);
        }
    }

    _boneDropdown(propId, currentBone) {
        const select = document.createElement('select');
        select.className = 'category-select';
        select.style.flex = '1';
        for (const name of this.pm.getBoneNames()) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === currentBone) opt.selected = true;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => {
            this.pm.reparent(propId, select.value);
        });
        return select;
    }

    _row(label, element) {
        const row = document.createElement('div');
        row.className = 'mat-row';
        const lbl = document.createElement('span');
        lbl.className = 'mat-label';
        lbl.textContent = label;
        row.appendChild(lbl);
        row.appendChild(element);
        return row;
    }

    _sliderRow(label, value, min, max, step, onChange) {
        const row = document.createElement('div');
        row.className = 'mat-row';
        const lbl = document.createElement('span');
        lbl.className = 'mat-label';
        lbl.textContent = label;
        lbl.style.minWidth = '40px';
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
}
