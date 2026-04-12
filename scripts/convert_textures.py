"""
Convert EXR textures (ACES ACEScg) to PNG (sRGB).
Run: python scripts/convert_textures.py

Requires: pip install OpenEXR numpy Pillow
"""

import os
import sys
import numpy as np

try:
    import OpenEXR
    import Imath
except ImportError:
    print("ERROR: OpenEXR not installed. Run: pip install OpenEXR")
    sys.exit(1)

from PIL import Image

# ACEScg (AP1) to linear sRGB matrix
ACES_AP1_TO_SRGB = np.array([
    [ 1.7050509, -0.6217921, -0.0832588],
    [-0.1302564,  1.1408052, -0.0105488],
    [-0.0240033, -0.1289690,  1.1529723]
], dtype=np.float32)

INPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "TEXTURES", "colors")
OUTPUT_DIR = os.path.join(INPUT_DIR, "png")


def linear_to_srgb(linear):
    """Apply sRGB gamma curve."""
    srgb = np.where(
        linear <= 0.0031308,
        linear * 12.92,
        1.055 * np.power(np.maximum(linear, 0.0031308), 1.0 / 2.4) - 0.055
    )
    return srgb


def convert_exr_to_png(input_path, output_path):
    """Convert a single ACES EXR to sRGB PNG."""
    exr_file = OpenEXR.InputFile(input_path)
    header = exr_file.header()

    dw = header['dataWindow']
    width = dw.max.x - dw.min.x + 1
    height = dw.max.y - dw.min.y + 1

    # Read channels
    pt = Imath.PixelType(Imath.PixelType.FLOAT)
    channels = {}
    for ch in ['R', 'G', 'B']:
        raw = exr_file.channel(ch, pt)
        channels[ch] = np.frombuffer(raw, dtype=np.float32).reshape(height, width)

    # Stack into (H, W, 3)
    aces = np.stack([channels['R'], channels['G'], channels['B']], axis=-1)

    # ACEScg to linear sRGB
    shape = aces.shape
    linear_srgb = aces.reshape(-1, 3) @ ACES_AP1_TO_SRGB.T
    linear_srgb = linear_srgb.reshape(shape)

    # Clamp negatives
    linear_srgb = np.clip(linear_srgb, 0.0, None)

    # Tone map: simple clamp (for base colors this is usually fine)
    linear_srgb = np.clip(linear_srgb, 0.0, 1.0)

    # Linear to sRGB gamma
    srgb = linear_to_srgb(linear_srgb)

    # To 8-bit
    srgb_8bit = (np.clip(srgb, 0.0, 1.0) * 255).astype(np.uint8)

    # Check for alpha
    exr_channels = header['channels'].keys()
    if 'A' in exr_channels:
        raw_a = exr_file.channel('A', pt)
        alpha = np.frombuffer(raw_a, dtype=np.float32).reshape(height, width)
        alpha_8bit = (np.clip(alpha, 0.0, 1.0) * 255).astype(np.uint8)
        rgba = np.dstack([srgb_8bit, alpha_8bit])
        img = Image.fromarray(rgba, 'RGBA')
    else:
        img = Image.fromarray(srgb_8bit, 'RGB')

    img.save(output_path, 'PNG')
    exr_file.close()


def batch_convert():
    if not os.path.exists(INPUT_DIR):
        print("Input directory not found: {}".format(INPUT_DIR))
        return

    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)

    exr_files = sorted([f for f in os.listdir(INPUT_DIR) if f.lower().endswith('.exr')])

    if not exr_files:
        print("No EXR files found in {}".format(INPUT_DIR))
        return

    print("Converting {} EXR files...".format(len(exr_files)))
    print("Input:  {}".format(INPUT_DIR))
    print("Output: {}".format(OUTPUT_DIR))
    print()

    for i, filename in enumerate(exr_files):
        input_path = os.path.join(INPUT_DIR, filename)
        # Normalize name: baseCO_N.png (fix inconsistent casing)
        base = os.path.splitext(filename)[0]
        output_name = base.replace("baseCo_", "baseCO_") + ".png"
        output_path = os.path.join(OUTPUT_DIR, output_name)

        print("[{}/{}] {} -> {}".format(i + 1, len(exr_files), filename, output_name))

        try:
            convert_exr_to_png(input_path, output_path)
        except Exception as e:
            print("  ERROR: {}".format(e))

    print("\nDone!")


if __name__ == "__main__":
    batch_convert()
