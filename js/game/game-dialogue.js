/**
 * Dialogue panel for talking to NPCs.
 * Loaded from config/dialogues.json — lines per mood bracket.
 */
export class GameDialogue {
    constructor() {
        this.brackets = [];
        this.root = null;
        this._currentNpc = null;
        this._onClose = null;
        this._playerName = 'toi';
    }

    async loadConfig(url = 'config/dialogues.json') {
        try {
            const res = await fetch(url);
            const data = await res.json();
            this.brackets = data.brackets || [];
        } catch (e) {
            console.warn('dialogues.json missing, using defaults', e);
            this.brackets = [];
        }
    }

    setPlayerName(name) {
        this._playerName = name || 'toi';
    }

    build() {
        const root = document.createElement('div');
        root.id = 'game-dialogue';
        root.className = 'game-dialogue hidden';
        root.innerHTML = `
            <div class="gd-card">
                <div class="gd-header">
                    <span class="gd-name"></span>
                    <span class="gd-mood"></span>
                </div>
                <div class="gd-line"></div>
                <div class="gd-actions">
                    <button class="gd-btn gd-btn-donut" data-act="donut">🍩 Donner</button>
                    <button class="gd-btn gd-btn-veggie" data-act="veggie">🥕 Donner</button>
                    <button class="gd-btn gd-btn-bye" data-act="bye">👋 Au revoir</button>
                </div>
            </div>
        `;
        document.body.appendChild(root);
        this.root = root;
        this._nameEl = root.querySelector('.gd-name');
        this._moodEl = root.querySelector('.gd-mood');
        this._lineEl = root.querySelector('.gd-line');
        this._actionsEl = root.querySelector('.gd-actions');
    }

    setHandlers({ onDonut, onVeggie, onBye }) {
        this._actionsEl.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn || !this._currentNpc) return;
            const act = btn.dataset.act;
            if (act === 'donut') onDonut(this._currentNpc);
            else if (act === 'veggie') onVeggie(this._currentNpc);
            else if (act === 'bye') { onBye(this._currentNpc); this.close(); }
        });
    }

    open(npc) {
        this._currentNpc = npc;
        this.root.classList.remove('hidden');
        this._render('greet');
    }

    refresh(kind) { this._render(kind); }

    close() {
        this.root.classList.add('hidden');
        this._currentNpc = null;
    }

    isOpen() { return !this.root.classList.contains('hidden'); }
    currentNpc() { return this._currentNpc; }

    _render(kind = 'greet') {
        if (!this._currentNpc) return;
        const npc = this._currentNpc;
        const bracket = this._bracketFor(npc.mood);
        this._nameEl.textContent = npc.name;
        this._moodEl.textContent = bracket
            ? `${bracket.label} (${npc.mood}/16)`
            : `${npc.mood}/16`;

        let pool = bracket && bracket[kind];
        if (!pool || pool.length === 0) pool = ['...'];
        const line = pool[Math.floor(Math.random() * pool.length)];
        this._lineEl.textContent = line.replaceAll('{player}', this._playerName);
    }

    _bracketFor(mood) {
        for (const b of this.brackets) {
            const [lo, hi] = b.range;
            if (mood >= lo && mood <= hi) return b;
        }
        return null;
    }

    show() { /* no-op, controlled by open/close */ }
    hide() { this.close(); }
}
