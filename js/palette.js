/**
 * Color palette: 22 named colors.
 * Extracted from baseCO textures and refined for visual harmony.
 */

export const COLOR_PALETTE = [
    { name: 'Red',       hex: '#ee3025', index: 0  },
    { name: 'Tomato',    hex: '#f06830', index: 1  },
    { name: 'Orange',    hex: '#f59a00', index: 2  },
    { name: 'Ambre',     hex: '#f5c000', index: 3  },
    { name: 'Yellow',    hex: '#f5e000', index: 4  },
    { name: 'Lime',      hex: '#c8e820', index: 5  },
    { name: 'Green',     hex: '#78d030', index: 6  },
    { name: 'Turkoize',  hex: '#40d8a0', index: 7  },
    { name: 'Cyan',      hex: '#20c8e8', index: 8  },
    { name: 'Blue',      hex: '#3878e8', index: 9  },
    { name: 'Purple',    hex: '#7858e0', index: 10 },
    { name: 'Magenta',   hex: '#e870b8', index: 11 },
    { name: 'Black',     hex: '#303030', index: 12 },
    { name: 'White',     hex: '#f0f0f0', index: 13 },
    { name: 'Brown',     hex: '#8b6530', index: 14 },
    { name: 'Peach',     hex: '#f5c898', index: 15 },
    { name: 'Mint',      hex: '#58d8c8', index: 16 },
    { name: 'Salmon',    hex: '#f08068', index: 17 },
    { name: 'Lavande',   hex: '#c8b8e0', index: 18 },
    { name: 'Grey',      hex: '#909090', index: 19 },
    { name: 'Olive',     hex: '#989870', index: 20 },
    { name: 'Beige',     hex: '#e8d8a8', index: 21 },
];

/**
 * Get the texture path for a palette color (legacy).
 */
export function getTexturePath(paletteEntry) {
    return `TEXTURES/colors/png/baseCO_${paletteEntry.index}.png`;
}
