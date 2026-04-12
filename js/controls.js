import { formatTraitName } from './utils.js';

export class Controls {
    constructor(character) {
        this.character = character;
        this.container = document.getElementById('controls-container');
        this.selectors = new Map(); // categoryName -> <select> element
    }

    /**
     * Build the UI: one dropdown per category.
     */
    build() {
        this.container.innerHTML = '';
        const categories = this.character.getCategoryNames();

        if (categories.length === 0) {
            this.container.innerHTML = `
                <p style="padding:16px;color:#888;">
                    Aucune animation trouvee.<br>
                    Ajouter des sous-dossiers dans FBX/ANIM/ ou FBX/POSE/<br>
                    puis lancer <code>build_manifest.py</code>
                </p>`;
            return;
        }

        for (const catName of categories) {
            this._createCategoryControl(catName);
        }

        this._bindGlobalButtons();
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
