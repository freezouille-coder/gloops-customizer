/**
 * Gloops breeds & factions system — aligned with the GDD.
 *
 * Each Gloop identity has:
 *   1. breed    — the archetype (bobo, mush, sugarhead, ...)
 *   2. faction  — aveggies / sugar_demons / neutral (derived from the breed)
 *   3. rarity   — common / uncommon / rare / epic / legendary
 *   4. tools    — list of tool tags the Gloop can use in buildings
 *
 * Legendary Gloops are separate: they are pre-authored "Demons" with
 * fixed assets (not procedural), and participate in synergy chains
 * (demon_network) that double production when two demons of the same
 * chain work in the same building.
 *
 * This module loads the config from `config/gloops-classes.json` and
 * exposes helpers to:
 *   - roll a random breed (weighted by rarity)
 *   - roll a random legendary (1% total chance)
 *   - apply a breed to a ShadingManager (colors, teeth, horns, scale)
 *   - query faction/tool/synergy metadata
 */

let _config = null;

/** Load and cache the config. */
export async function loadClasses() {
    if (_config) return _config;
    const res = await fetch('config/gloops-classes.json');
    _config = await res.json();
    return _config;
}

/* ------------------------------------------------------------------ */
/*  Random helpers                                                     */
/* ------------------------------------------------------------------ */

function pickRand(arr) {
    if (!arr || arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
}

/** Weighted random pick from an object of { key: { weight } }. */
function weightedPick(table, weightKey = 'weight') {
    const entries = Object.entries(table).filter(([, v]) => (v[weightKey] || 0) > 0);
    const total = entries.reduce((s, [, v]) => s + (v[weightKey] || 0), 0);
    if (total <= 0) return entries[0]?.[0] ?? null;
    let r = Math.random() * total;
    for (const [k, v] of entries) {
        r -= v[weightKey] || 0;
        if (r <= 0) return k;
    }
    return entries[entries.length - 1][0];
}

/* ------------------------------------------------------------------ */
/*  Breeds & rarity rolling                                            */
/* ------------------------------------------------------------------ */

/** Pick a rarity tier (common 60%, ..., legendary 1%). */
export function pickRandomRarity(cfg) {
    return weightedPick(cfg.rarity_tiers, 'weight');
}

/** Pick a breed whose rarity matches the given tier. Falls back to any breed. */
export function pickBreedForRarity(cfg, rarity) {
    const candidates = Object.entries(cfg.breeds).filter(([, b]) => b.rarity === rarity);
    if (candidates.length === 0) {
        // fallback: random breed
        const all = Object.keys(cfg.breeds);
        return all[Math.floor(Math.random() * all.length)];
    }
    return candidates[Math.floor(Math.random() * candidates.length)][0];
}

/** Pick a random legendary demon. */
export function pickRandomLegendary(cfg) {
    const keys = Object.keys(cfg.legendaries || {}).filter(k => !k.startsWith('_'));
    return keys[Math.floor(Math.random() * keys.length)] || null;
}

/**
 * Roll a full Gloop identity.
 * Returns: { kind: 'breed'|'legendary', key, def, rarity, faction }
 */
export function rollIdentity(cfg) {
    const rarity = pickRandomRarity(cfg);
    if (rarity === 'legendary') {
        const key = pickRandomLegendary(cfg);
        const def = cfg.legendaries[key];
        return { kind: 'legendary', key, def, rarity, faction: def.faction };
    }
    const key = pickBreedForRarity(cfg, rarity);
    const def = cfg.breeds[key];
    return { kind: 'breed', key, def, rarity, faction: def.faction };
}

/* ------------------------------------------------------------------ */
/*  Apply to ShadingManager                                            */
/* ------------------------------------------------------------------ */

/**
 * Apply a breed identity to a ShadingManager and return the variant
 * choices so the caller can drive the character mixer.
 *
 * Returns: { horns, teeth, eyeStyle, scale, identity }
 */
export function applyIdentityToShading(sm, identity) {
    const def = identity.def;
    const findMat = (kw) => sm.getMaterialNames().find(n => n.toLowerCase().includes(kw));

    // --- Color palette ---
    const palette = def.color_palette || {};
    const applyColor = (side, channel, hex) => {
        const mat = findMat('body');
        if (!mat || !hex) return;
        if (side === 'A') sm.setRGBColorA(mat, channel, hex);
        else sm.setRGBColorB(mat, channel, hex);
    };
    // body root (channel 0)
    applyColor('A', 0, pickRand(palette.body_root_A));
    applyColor('B', 0, pickRand(palette.body_root_B) || pickRand(palette.body_root_A));
    // tongue (channel 1)
    if (palette.tongue_root_A) {
        applyColor('A', 1, pickRand(palette.tongue_root_A));
    }
    // eyelid (channel 2)
    if (palette.eyelid_A) {
        applyColor('A', 2, pickRand(palette.eyelid_A));
    }

    // --- Variant choices (only for procedural breeds) ---
    const horns = pickRand(def.horns_variants);
    const teeth = pickRand(def.teeth_variants);
    const eyeStyle = def.eye_style_override ?? null;
    const scale = def.scale_range
        ? def.scale_range[0] + Math.random() * (def.scale_range[1] - def.scale_range[0])
        : 1.0;

    return { horns, teeth, eyeStyle, scale, identity };
}

/** One-shot: load, roll, apply. */
export async function randomizeWithClass(sm) {
    const cfg = await loadClasses();
    const identity = rollIdentity(cfg);
    // Legendaries are pre-rendered assets — skip procedural shading.
    if (identity.kind === 'legendary') {
        return { horns: null, teeth: null, eyeStyle: null, scale: 1.0, identity };
    }
    return applyIdentityToShading(sm, identity);
}

/* ------------------------------------------------------------------ */
/*  Query helpers                                                      */
/* ------------------------------------------------------------------ */

/** Get the faction def for a breed or legendary. */
export function getFaction(cfg, identity) {
    return cfg.factions[identity.faction] || null;
}

/** Return all tool tags owned by a breed/legendary. */
export function getTools(cfg, identity) {
    return identity.def.tools || [];
}

/** Check if two demons belong to the same synergy chain. Returns the chain or null. */
export function findSynergy(cfg, demonKeyA, demonKeyB) {
    const chains = cfg.demon_network?.chains || [];
    return chains.find(c =>
        c.demons.includes(demonKeyA) && c.demons.includes(demonKeyB)
    ) || null;
}

/** List all legendaries that synergize with the given one. */
export function getSynergies(cfg, demonKey) {
    const def = cfg.legendaries?.[demonKey];
    return def?.synergies || [];
}
