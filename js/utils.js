/**
 * Clamp a value between min and max.
 */
export function clamp(value, min = 0, max = 1) {
    return Math.min(max, Math.max(min, value));
}

/**
 * Random float between min and max.
 */
export function randomRange(min = 0, max = 1) {
    return min + Math.random() * (max - min);
}

/**
 * Weighted random value for a single trait.
 * weight: 0 = always returns 0, 1 = uniform random, higher = biased toward extremes.
 * Returns a value in [0, 1].
 */
export function weightedRandom(weight = 1) {
    if (weight <= 0) return 0;
    const raw = Math.random();
    // Apply power curve: weight < 1 clusters near 0, weight > 1 spreads more evenly
    return Math.pow(raw, 1 / weight);
}

/**
 * Lerp between two values.
 */
export function lerp(a, b, t) {
    return a + (b - a) * clamp(t);
}

/**
 * Format a blendshape name for display.
 * e.g. "mouthSmile_L" -> "Mouth Smile L"
 */
export function formatTraitName(name) {
    return name
        .replace(/([A-Z])/g, ' $1')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
}
