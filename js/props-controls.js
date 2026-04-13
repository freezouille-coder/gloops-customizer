export class PropsControls {
    constructor(propsManager) {
        this.pm = propsManager;
        this.container = null;
    }

    build(container) {
        this.container = container;
        this.container.innerHTML = '';

        const groups = this.pm.getCatalogByCategory();
        const hasProps = Object.keys(groups).length > 0;

        if (!hasProps) {
            // Show file upload for custom props
            this.container.appendChild(this._buildUploadSection());
            return;
        }

        // Build catalog sections by category
        for (const [category, props] of Object.entries(groups)) {
            this.container.appendChild(this._buildCategorySection(category, props));
        }

        // Custom upload at the end
        this.container.appendChild(this._buildUploadSection());

        // Active props controls
        const activeDiv = document.createElement('div');
        activeDiv.id = 'active-props-list';
        this.container.appendChild(activeDiv);
        this._rebuildActiveList();
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
