import * as THREE from 'three';
import { formatTraitName } from './utils.js';

export class Controls {
    constructor(character, scene) {
        this.character = character;
        this.scene = scene;
        this.container = document.getElementById('controls-container');
        this.selectors = new Map();
        this._skeletonHelper = null;
        this._skeletonVisible = false;
        this._originalMatOpacity = new Map();
    }

    /**
     * Build the UI: one dropdown per category.
     */
    build() {
        this.container.innerHTML = '';

        // Skeleton / transparency toggle at the top of the ANIM tab
        this._createSkeletonToggle();

        const categories = this.character.getCategoryNames();

        if (categories.length === 0) {
            const p = document.createElement('p');
            p.style.cssText = 'padding:16px;color:#888;';
            p.innerHTML = `Aucune animation trouvee.<br>Ajouter des sous-dossiers dans FBX/ANIM/ ou FBX/POSE/<br>puis lancer <code>build_manifest.py</code>`;
            this.container.appendChild(p);
            return;
        }

        for (const catName of categories) {
            this._createCategoryControl(catName);
        }

        this._bindGlobalButtons();
    }

    _createSkeletonToggle() {
        const row = document.createElement('div');
        row.style.cssText = 'padding: 10px 14px; display: flex; gap: 8px; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.08); margin-bottom: 8px;';

        const label = document.createElement('label');
        label.style.cssText = 'flex: 1; color: #ccc; font-size: 0.82rem; font-weight: 700; cursor: pointer;';
        label.textContent = '🦴 Skeleton + mesh translucide';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = 'toggle-skeleton';
        checkbox.style.cssText = 'width: 18px; height: 18px; cursor: pointer;';
        checkbox.addEventListener('change', () => this._setSkeletonMode(checkbox.checked));

        label.htmlFor = checkbox.id;
        row.appendChild(checkbox);
        row.appendChild(label);
        this.container.appendChild(row);
    }

    _setSkeletonMode(on) {
        if (!this.character.model || !this.scene) return;
        this._skeletonVisible = on;

        // SkeletonHelper (lines between bones)
        if (on && !this._skeletonHelper) {
            this._skeletonHelper = new THREE.SkeletonHelper(this.character.model);
            this._skeletonHelper.material.linewidth = 2;
            this._skeletonHelper.material.depthTest = false;
            this._skeletonHelper.material.depthWrite = false;
            this._skeletonHelper.renderOrder = 999;
            this.scene.add(this._skeletonHelper);
        } else if (!on && this._skeletonHelper) {
            this.scene.remove(this._skeletonHelper);
            this._skeletonHelper.dispose && this._skeletonHelper.dispose();
            this._skeletonHelper = null;
        }

        // Semi-transparent meshes
        this.character.model.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of mats) {
                if (on) {
                    if (!this._originalMatOpacity.has(mat.uuid)) {
                        this._originalMatOpacity.set(mat.uuid, {
                            opacity: mat.opacity,
                            transparent: mat.transparent,
                            depthWrite: mat.depthWrite,
                        });
                    }
                    mat.transparent = true;
                    mat.opacity = 0.25;
                    mat.depthWrite = false;
                    mat.needsUpdate = true;
                } else {
                    const orig = this._originalMatOpacity.get(mat.uuid);
                    if (orig) {
                        mat.opacity = orig.opacity;
                        mat.transparent = orig.transparent;
                        mat.depthWrite = orig.depthWrite;
                        mat.needsUpdate = true;
                    }
                }
            }
        });
    }

    /**
     * Create a dropdown selector for one category.
     */
    _createCategoryControl(categoryName) {
        const items = this.character.getCategoryItems(categoryName);
        const type = this.character.getCategoryType(categoryName);
        const icon = type === 'pose' ? '🎭' : '🔄';

        const group = document.createElement('div');
        group.className = 'category-group';

        // Header
        const header = document.createElement('div');
        header.className = 'category-header';

        const title = document.createElement('span');
        title.className = 'category-name';
        title.textContent = `${icon} ${formatTraitName(categoryName)}`;

        const randomBtn = document.createElement('button');
        randomBtn.className = 'btn-category-random';
        randomBtn.textContent = '🎲';
        randomBtn.title = `Random ${categoryName}`;
        randomBtn.addEventListener('click', () => this._randomizeCategory(categoryName));

        header.appendChild(title);
        header.appendChild(randomBtn);
        group.appendChild(header);

        // Dropdown
        const select = document.createElement('select');
        select.className = 'category-select';

        // "None" option
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = '— None —';
        select.appendChild(noneOpt);

        for (const item of items) {
            const opt = document.createElement('option');
            opt.value = item.filename;
            opt.textContent = item.label;
            select.appendChild(opt);
        }

        select.addEventListener('change', () => {
            const val = select.value || null;
            this.character.selectItem(categoryName, val);
        });

        group.appendChild(select);
        this.container.appendChild(group);
        this.selectors.set(categoryName, select);
    }

    /**
     * Pick a random item in a category.
     */
    _randomizeCategory(categoryName) {
        const items = this.character.getCategoryItems(categoryName);
        if (items.length === 0) return;

        const randomIndex = Math.floor(Math.random() * items.length);
        const picked = items[randomIndex];

        this.character.selectItem(categoryName, picked.filename);

        const select = this.selectors.get(categoryName);
        if (select) {
            select.value = picked.filename;
        }
    }

    /**
     * Randomize all categories.
     */
    randomizeAll() {
        for (const catName of this.selectors.keys()) {
            this._randomizeCategory(catName);
        }
    }

    /**
     * Reset all categories to "None".
     */
    resetAll() {
        this.character.resetAll();
        for (const [catName, select] of this.selectors) {
            select.value = '';
        }
    }

    /**
     * Bind global buttons.
     */
    _bindGlobalButtons() {
        document.getElementById('btn-random-all')
            ?.addEventListener('click', () => this.randomizeAll());
        document.getElementById('btn-reset')
            ?.addEventListener('click', () => this.resetAll());
    }
}
