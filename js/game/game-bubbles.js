import * as THREE from 'three';

/**
 * Emoji bubble sprites that float above NPC heads. Uses a CanvasTexture
 * to draw an emoji into a transparent square, wrapped in a Sprite so it
 * always faces the camera. Textures are cached per emoji.
 */

const _textureCache = new Map();

function makeEmojiTexture(emoji) {
    if (_textureCache.has(emoji)) return _textureCache.get(emoji);
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // No background bubble — just the raw emoji on transparent canvas.
    ctx.clearRect(0, 0, size, size);
    ctx.font = '96px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, size / 2, size / 2 + 4);

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    _textureCache.set(emoji, tex);
    return tex;
}

/**
 * A single bubble sprite attached above a target model.
 */
export class NpcBubble {
    constructor() {
        this.material = new THREE.SpriteMaterial({
            map: makeEmojiTexture('💬'),
            transparent: true,
            depthTest: false,
            depthWrite: false,
        });
        this.sprite = new THREE.Sprite(this.material);
        this.sprite.scale.set(0.85, 0.85, 1);
        this.sprite.position.set(0, 3.1, 0);
        this.sprite.renderOrder = 999;
        this.sprite.visible = false;   // hidden by default — only shows on set()
        this._currentEmoji = '💬';
        this._holdUntil = 0;
    }

    get object() { return this.sprite; }

    /**
     * Show an emoji above the head. If `durationMs` is > 0, auto-hide
     * after that duration (holds the icon for that long).
     */
    set(emoji, durationMs = 0) {
        if (emoji !== this._currentEmoji) {
            this.material.map = makeEmojiTexture(emoji);
            this.material.needsUpdate = true;
            this._currentEmoji = emoji;
        }
        this._holdUntil = durationMs > 0 ? performance.now() + durationMs : 0;
        this.sprite.visible = true;
    }

    /** Returns true if the held emoji is still locked. */
    isHolding() { return this._holdUntil > 0 && performance.now() < this._holdUntil; }

    /** Hide the bubble if it's not currently holding a timed emoji. */
    hideIfNotHolding() {
        if (!this.isHolding()) this.sprite.visible = false;
    }

    hide() {
        this.sprite.visible = false;
        this._holdUntil = 0;
    }
}

export const BUBBLE_EMOJIS = {
    CHAT: '💬',
    WALK: '☁️',
    DONUT: '❤️',
    CARROT: '💀',
    PANIC: '😱',
    DEPRESSED: '😵',
};
