/**
 * Texture library: loads texture paths from manifest and provides
 * texture loading by ID for save/load presets.
 */
export class TextureLibrary {
    constructor() {
        this.catalog = {};  // id -> path
        this._cache = {};   // path -> Image (loaded)
    }

    /**
     * Load texture catalog from manifest.
     */
    async loadFromManifest(manifestPath) {
        const resp = await fetch(manifestPath);
        const manifest = await resp.json();
        this.catalog = manifest.textures || {};
        console.log(`TextureLibrary: ${Object.keys(this.catalog).length} textures`);
    }

    /**
     * Get path for a texture ID.
     */
    getPath(id) {
        return this.catalog[id] || null;
    }

    /**
     * Find the texture ID for a given path.
     */
    findId(path) {
        if (!path) return null;
        for (const [id, p] of Object.entries(this.catalog)) {
            if (p === path) return id;
        }
        return null;
    }

    /**
     * Load a texture by ID. Returns Promise<Image>.
     */
    async loadById(id) {
        const path = this.getPath(id);
        if (!path) return null;
        return this.loadByPath(path);
    }

    /**
     * Load a texture by path. Returns Promise<Image>.
     */
    async loadByPath(path) {
        if (this._cache[path]) return this._cache[path];

        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                this._cache[path] = img;
                resolve(img);
            };
            img.onerror = () => resolve(null);
            img.src = path;
        });
    }

    /**
     * Get all texture IDs grouped by folder.
     */
    getGrouped() {
        const groups = {};
        for (const [id, path] of Object.entries(this.catalog)) {
            const parts = path.split('/');
            const folder = parts.length > 2 ? parts[1] : 'other';
            if (!groups[folder]) groups[folder] = [];
            groups[folder].push({ id, path });
        }
        return groups;
    }
}
