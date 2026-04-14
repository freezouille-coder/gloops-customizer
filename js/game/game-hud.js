/**
 * In-game HUD: inventory counters, interaction prompt, virtual joystick (mobile).
 */
export class GameHud {
    constructor() {
        this.donuts = 5;
        this.veggies = 5;
        this.root = null;
        this._joystickActive = false;
        this._onJoystick = null;
    }

    build({ onExit, onJoystick, onInteract }) {
        this._onJoystick = onJoystick;
        const root = document.createElement('div');
        root.id = 'game-hud';
        root.className = 'game-hud hidden';
        root.innerHTML = `
            <div class="gh-top">
                <div class="gh-inv">
                    <span class="gh-item">🍩 <b class="gh-donut-count">5</b></span>
                    <span class="gh-item">🥕 <b class="gh-veggie-count">5</b></span>
                </div>
                <button class="gh-exit" title="Exit play mode">✕ Exit</button>
            </div>
            <div class="gh-prompt hidden">Approche un Gloop pour parler</div>
            <button class="gh-interact hidden">💬 Parler</button>
            <!-- Crosshair removed -->

            <div class="gh-joy">
                <div class="gh-joy-stick"></div>
            </div>
            <div class="gh-help" data-mode="walk">
                <div class="gh-help-title">CONTROLS <span class="gh-help-toggle">H</span></div>
                <div class="gh-help-body"></div>
            </div>
        `;
        document.body.appendChild(root);
        this.root = root;
        this._donutEl = root.querySelector('.gh-donut-count');
        this._veggieEl = root.querySelector('.gh-veggie-count');
        this._promptEl = root.querySelector('.gh-prompt');
        this._interactEl = root.querySelector('.gh-interact');
        this._joyEl = root.querySelector('.gh-joy');
        this._joyStickEl = root.querySelector('.gh-joy-stick');
        this._helpEl = root.querySelector('.gh-help');
        this._helpBody = root.querySelector('.gh-help-body');
        this._helpCollapsed = false;

        root.querySelector('.gh-exit').addEventListener('click', onExit);
        this._interactEl.addEventListener('click', onInteract);
        this._helpEl.addEventListener('click', () => this.toggleHelp());
        window.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === 'h') this.toggleHelp();
        });

        this._wireJoystick();
        this._refreshInv();
        this.setMode('walk');
    }

    toggleHelp() {
        this._helpCollapsed = !this._helpCollapsed;
        this._helpEl.classList.toggle('collapsed', this._helpCollapsed);
    }

    /** Switch the help panel between walking and driving contexts. */
    setMode(mode) {
        if (this._mode === mode) return;
        this._mode = mode;
        this._helpEl.setAttribute('data-mode', mode);
        const rows = (mode === 'fly') ? [
            ['W / S',     'Accélère / Ralentit'],
            ['A / D',     'Yaw (tourner)'],
            ['Espace',    'Monter'],
            ['Shift',     'Descendre'],
            ['Souris',    'Caméra'],
            ['F',         'Sortir de l\'avion'],
        ] : (mode === 'drive') ? [
            ['W / ↑',     'Accélère'],
            ['S / ↓',     'Freine / Marche arrière'],
            ['A / D',     'Braquer'],
            ['Souris',    'Caméra'],
            ['F',         'Sortir du véhicule'],
        ] : [
            ['W A S D',   'Déplacement'],
            ['Shift',     'Courir'],
            ['Espace',    'Sauter'],
            ['Souris',    'Caméra / Viser'],
            ['F',         'Interagir / Voiture'],
            ['H',         'Cache / Montre ce panneau'],
        ];
        this._helpBody.innerHTML = rows.map(([k, v]) =>
            `<div class="gh-help-row"><span class="gh-key">${k}</span><span class="gh-act">${v}</span></div>`
        ).join('');
    }

    _wireJoystick() {
        const joy = this._joyEl;
        const stick = this._joyStickEl;
        let cx = 0, cy = 0, radius = 0;
        const start = (e) => {
            const t = e.touches ? e.touches[0] : e;
            const rect = joy.getBoundingClientRect();
            cx = rect.left + rect.width / 2;
            cy = rect.top + rect.height / 2;
            radius = rect.width / 2;
            this._joystickActive = true;
            move(e);
        };
        const move = (e) => {
            if (!this._joystickActive) return;
            const t = e.touches ? e.touches[0] : e;
            let dx = t.clientX - cx;
            let dy = t.clientY - cy;
            const m = Math.hypot(dx, dy);
            if (m > radius) { dx = dx / m * radius; dy = dy / m * radius; }
            stick.style.transform = `translate(${dx}px, ${dy}px)`;
            // Convert to -1..1, invert Y because screen Y is down
            const x = dx / radius;
            const y = -dy / radius;
            this._onJoystick && this._onJoystick(x, y);
            e.preventDefault();
        };
        const end = () => {
            this._joystickActive = false;
            stick.style.transform = '';
            this._onJoystick && this._onJoystick(0, 0);
        };
        joy.addEventListener('touchstart', start, { passive: false });
        joy.addEventListener('touchmove', move, { passive: false });
        joy.addEventListener('touchend', end);
        joy.addEventListener('mousedown', start);
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', end);
    }

    setPrompt(text) {
        if (text) {
            this._promptEl.textContent = text;
            this._promptEl.classList.remove('hidden');
        } else {
            this._promptEl.classList.add('hidden');
        }
    }

    setInteractVisible(visible) {
        this._interactEl.classList.toggle('hidden', !visible);
    }

    addItem(type) {
        if (type === 'donut') this.donuts++;
        else if (type === 'veggie') this.veggies++;
        this._refreshInv();
    }

    consumeDonut() {
        if (this.donuts <= 0) return false;
        this.donuts--; this._refreshInv(); return true;
    }
    consumeVeggie() {
        if (this.veggies <= 0) return false;
        this.veggies--; this._refreshInv(); return true;
    }

    _refreshInv() {
        this._donutEl.textContent = this.donuts;
        this._veggieEl.textContent = this.veggies;
    }

    show() { this.root.classList.remove('hidden'); }
    hide() {
        this.root.classList.add('hidden');
        this.setInteractVisible(false);
        this.setPrompt(null);
    }
}
