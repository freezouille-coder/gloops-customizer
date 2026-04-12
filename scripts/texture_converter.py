"""
Gloops - Texture Converter UI
Standalone Python tool for converting textures:
  - ACES (ACEScg) EXR -> sRGB PNG
  - RAW EXR/HDR -> sRGB PNG
  - RGBA channel split (decompile packed textures)

Run:  python texture_converter.py
Requires: pip install OpenEXR numpy Pillow
"""

import os
import sys
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import threading
import numpy as np
from PIL import Image

try:
    import OpenEXR
    import Imath
    HAS_EXR = True
except ImportError:
    HAS_EXR = False

# ============================================================
# Conversion matrices
# ============================================================

# ACEScg (AP1) to linear sRGB
ACES_AP1_TO_SRGB = np.array([
    [ 1.7050509, -0.6217921, -0.0832588],
    [-0.1302564,  1.1408052, -0.0105488],
    [-0.0240033, -0.1289690,  1.1529723]
], dtype=np.float32)

# ACES AP0 to linear sRGB
ACES_AP0_TO_SRGB = np.array([
    [ 2.5216494, -1.1368885, -0.3849610],
    [-0.2752164,  1.3697584, -0.0945420],
    [-0.0159270, -0.1478048,  1.1637318]
], dtype=np.float32)


def linear_to_srgb(linear):
    """Apply sRGB gamma curve."""
    return np.where(
        linear <= 0.0031308,
        linear * 12.92,
        1.055 * np.power(np.maximum(linear, 0.0031308), 1.0 / 2.4) - 0.055
    )


def read_exr(path):
    """Read EXR file, return (pixels_float32 HxWx3or4, has_alpha)."""
    if not HAS_EXR:
        raise ImportError("OpenEXR not installed. Run: pip install OpenEXR")

    exr = OpenEXR.InputFile(path)
    header = exr.header()
    dw = header['dataWindow']
    w = dw.max.x - dw.min.x + 1
    h = dw.max.y - dw.min.y + 1
    pt = Imath.PixelType(Imath.PixelType.FLOAT)

    available = list(header['channels'].keys())

    def read_ch(name):
        raw = exr.channel(name, pt)
        return np.frombuffer(raw, dtype=np.float32).reshape(h, w)

    # Try to read RGB channels with various naming conventions
    r_ch = g_ch = b_ch = a_ch = None

    # Standard RGB
    if 'R' in available: r_ch = read_ch('R')
    if 'G' in available: g_ch = read_ch('G')
    if 'B' in available: b_ch = read_ch('B')
    if 'A' in available: a_ch = read_ch('A')

    # Fallback: Y (luminance), or first available channel
    if r_ch is None:
        if 'Y' in available:
            r_ch = read_ch('Y')
        elif len(available) > 0:
            # Use whatever channel exists
            first = [c for c in available if c != 'A']
            if first:
                r_ch = read_ch(first[0])

    exr.close()

    if r_ch is None:
        raise ValueError("No readable channels in EXR: {}".format(available))

    # Build RGB from available channels
    if g_ch is None: g_ch = r_ch
    if b_ch is None: b_ch = r_ch

    rgb = np.stack([r_ch, g_ch, b_ch], axis=-1)
    has_alpha = a_ch is not None

    if has_alpha:
        return np.dstack([rgb, a_ch[:, :, None]]), True
    return rgb, False


def read_image(path):
    """Read any image file (PNG, JPG, TIF, EXR) as float32 HxWxC."""
    ext = os.path.splitext(path)[1].lower()
    if ext in ['.exr']:
        return read_exr(path)
    else:
        img = Image.open(path)
        # Convert palette/1-bit/etc to RGBA
        if img.mode in ('P', '1', 'L', 'LA'):
            img = img.convert('RGBA')
        elif img.mode == 'RGB':
            pass
        elif img.mode == 'RGBA':
            pass
        elif img.mode == 'I' or img.mode == 'I;16':
            # 16/32 bit int images
            arr = np.array(img).astype(np.float32)
            arr = arr / arr.max() if arr.max() > 0 else arr
            arr = np.stack([arr, arr, arr], axis=-1)
            return arr, False
        elif img.mode == 'F':
            # 32 bit float images
            arr = np.array(img).astype(np.float32)
            arr = np.stack([arr, arr, arr], axis=-1)
            return arr, False
        else:
            img = img.convert('RGBA')

        arr = np.array(img).astype(np.float32) / 255.0
        has_alpha = len(arr.shape) == 3 and arr.shape[2] == 4
        if len(arr.shape) == 2:
            arr = np.stack([arr, arr, arr], axis=-1)
        return arr, has_alpha


# ============================================================
# Conversion operations
# ============================================================

def convert_aces_to_srgb(pixels, colorspace='AP1'):
    """ACES -> linear sRGB -> sRGB gamma."""
    mat = ACES_AP1_TO_SRGB if colorspace == 'AP1' else ACES_AP0_TO_SRGB
    rgb = pixels[:, :, :3]
    shape = rgb.shape
    linear = rgb.reshape(-1, 3) @ mat.T
    linear = linear.reshape(shape)
    linear = np.clip(linear, 0.0, None)
    linear = np.clip(linear, 0.0, 1.0)  # simple clamp tonemapping
    srgb = linear_to_srgb(linear)
    return np.clip(srgb, 0.0, 1.0)


def convert_raw_to_srgb(pixels):
    """Linear raw -> sRGB gamma (no color matrix, just gamma)."""
    rgb = pixels[:, :, :3]
    rgb = np.clip(rgb, 0.0, 1.0)
    srgb = linear_to_srgb(rgb)
    return np.clip(srgb, 0.0, 1.0)


def split_channels(pixels):
    """Split RGBA into individual grayscale images."""
    result = {}
    names = ['R', 'G', 'B', 'A']
    for i, name in enumerate(names):
        if i < pixels.shape[2]:
            ch = pixels[:, :, i]
            result[name] = ch
    return result


def save_png(arr_float, path, is_gray=False, target_res=None):
    """Save float32 array as PNG, optionally resized."""
    arr = (np.clip(arr_float, 0.0, 1.0) * 255).astype(np.uint8)
    if is_gray:
        if len(arr.shape) == 3:
            arr = arr[:, :, 0]
        img = Image.fromarray(arr, 'L')
    elif len(arr.shape) == 3 and arr.shape[2] == 4:
        img = Image.fromarray(arr, 'RGBA')
    elif len(arr.shape) == 3 and arr.shape[2] == 3:
        img = Image.fromarray(arr, 'RGB')
    else:
        if len(arr.shape) == 3:
            arr = arr[:, :, 0]
        img = Image.fromarray(arr, 'L')

    # Resize if target resolution specified
    if target_res and target_res > 0:
        img = img.resize((target_res, target_res), Image.LANCZOS)

    os.makedirs(os.path.dirname(path), exist_ok=True) if os.path.dirname(path) else None
    img.save(path, 'PNG')

    if not os.path.exists(path):
        raise IOError(f"File was not created: {path}")
    size_kb = os.path.getsize(path) / 1024
    return size_kb


# ============================================================
# UI
# ============================================================

class TextureConverterApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Gloops - Texture Converter")
        self.root.geometry("650x720")
        self.root.configure(bg='#1a1a2e')

        style = ttk.Style()
        style.theme_use('clam')
        style.configure('TFrame', background='#1a1a2e')
        style.configure('TLabel', background='#1a1a2e', foreground='#e0e0e0',
                         font=('Segoe UI', 10))
        style.configure('Header.TLabel', background='#1a1a2e', foreground='#e94560',
                         font=('Segoe UI', 14, 'bold'))
        style.configure('TButton', font=('Segoe UI', 10))
        style.configure('TRadiobutton', background='#1a1a2e', foreground='#e0e0e0',
                         font=('Segoe UI', 10))
        style.configure('TCheckbutton', background='#1a1a2e', foreground='#e0e0e0',
                         font=('Segoe UI', 10))

        self._build_ui()

    def _build_ui(self):
        main = ttk.Frame(self.root, padding=20)
        main.pack(fill='both', expand=True)

        ttk.Label(main, text="GLOOPS Texture Converter", style='Header.TLabel').pack(pady=(0, 15))

        # --- Mode ---
        mode_frame = ttk.LabelFrame(main, text="Mode", padding=10)
        mode_frame.pack(fill='x', pady=5)

        self.mode = tk.StringVar(value='aces')
        modes = [
            ('ACES (ACEScg) → sRGB PNG', 'aces'),
            ('RAW Linear → sRGB PNG', 'raw'),
            ('RGBA Channel Split', 'split'),
        ]
        for text, val in modes:
            ttk.Radiobutton(mode_frame, text=text, variable=self.mode, value=val).pack(anchor='w')

        # --- ACES colorspace sub-option ---
        aces_frame = ttk.Frame(mode_frame)
        aces_frame.pack(fill='x', pady=(5, 0))
        ttk.Label(aces_frame, text="  ACES:").pack(side='left')
        self.aces_cs = tk.StringVar(value='AP1')
        ttk.Radiobutton(aces_frame, text='ACEScg (AP1)', variable=self.aces_cs, value='AP1').pack(side='left', padx=5)
        ttk.Radiobutton(aces_frame, text='ACES (AP0)', variable=self.aces_cs, value='AP0').pack(side='left', padx=5)

        # --- Channel names for split ---
        split_frame = ttk.LabelFrame(main, text="Channel Split Labels (for filenames)", padding=10)
        split_frame.pack(fill='x', pady=5)

        self.ch_labels = {}
        for i, (ch, default) in enumerate([('R', 'Roughness'), ('G', 'Metalness'),
                                             ('B', 'AO'), ('A', 'Alpha')]):
            f = ttk.Frame(split_frame)
            f.pack(fill='x')
            ttk.Label(f, text=f"{ch} channel:", width=12).pack(side='left')
            var = tk.StringVar(value=default)
            ttk.Entry(f, textvariable=var, width=20).pack(side='left', padx=5)
            self.ch_labels[ch] = var

        # --- Source ---
        src_frame = ttk.LabelFrame(main, text="Source", padding=10)
        src_frame.pack(fill='x', pady=5)

        self.src_mode = tk.StringVar(value='folder')
        ttk.Radiobutton(src_frame, text='Folder (batch)', variable=self.src_mode, value='folder').pack(anchor='w')
        ttk.Radiobutton(src_frame, text='Single file', variable=self.src_mode, value='file').pack(anchor='w')

        src_path_frame = ttk.Frame(src_frame)
        src_path_frame.pack(fill='x', pady=(5, 0))
        self.src_path = tk.StringVar()
        ttk.Entry(src_path_frame, textvariable=self.src_path).pack(side='left', fill='x', expand=True)
        ttk.Button(src_path_frame, text="Browse...", command=self._browse_source).pack(side='left', padx=(5, 0))

        # --- Target ---
        tgt_frame = ttk.LabelFrame(main, text="Target Folder", padding=10)
        tgt_frame.pack(fill='x', pady=5)

        tgt_path_frame = ttk.Frame(tgt_frame)
        tgt_path_frame.pack(fill='x')
        self.tgt_path = tk.StringVar()
        ttk.Entry(tgt_path_frame, textvariable=self.tgt_path).pack(side='left', fill='x', expand=True)
        ttk.Button(tgt_path_frame, text="Browse...", command=self._browse_target).pack(side='left', padx=(5, 0))

        # --- Resolution ---
        res_frame = ttk.LabelFrame(main, text="Output Resolution", padding=10)
        res_frame.pack(fill='x', pady=5)

        res_row = ttk.Frame(res_frame)
        res_row.pack(fill='x')

        self.resolution = tk.StringVar(value='original')
        resolutions = [
            ('Original', 'original'),
            ('4096', '4096'),
            ('2048', '2048'),
            ('1024', '1024'),
            ('512', '512'),
            ('256', '256'),
        ]
        for text, val in resolutions:
            ttk.Radiobutton(res_row, text=text, variable=self.resolution, value=val).pack(side='left', padx=3)

        custom_row = ttk.Frame(res_frame)
        custom_row.pack(fill='x', pady=(5, 0))
        ttk.Radiobutton(custom_row, text='Custom:', variable=self.resolution, value='custom').pack(side='left')
        self.custom_res = tk.IntVar(value=1024)
        ttk.Entry(custom_row, textvariable=self.custom_res, width=6).pack(side='left', padx=5)
        ttk.Label(custom_row, text='px').pack(side='left')

        # --- Convert button ---
        ttk.Button(main, text="CONVERT", command=self._run_convert).pack(pady=15, fill='x', ipady=8)

        # --- Log ---
        self.log_text = tk.Text(main, height=8, bg='#0a0f1e', fg='#e0e0e0',
                                 font=('Consolas', 9), state='disabled')
        self.log_text.pack(fill='both', expand=True)

    def _browse_source(self):
        if self.src_mode.get() == 'folder':
            path = filedialog.askdirectory(initialdir=self.src_path.get() or '')
        else:
            path = filedialog.askopenfilename(
                filetypes=[('Images', '*.exr *.png *.jpg *.tif *.tiff *.hdr'), ('All', '*.*')],
                initialdir=os.path.dirname(self.src_path.get()) if self.src_path.get() else ''
            )
        if path:
            self.src_path.set(path)
            # Auto-set target
            if not self.tgt_path.get():
                if os.path.isdir(path):
                    self.tgt_path.set(os.path.join(path, 'converted'))
                else:
                    self.tgt_path.set(os.path.join(os.path.dirname(path), 'converted'))

    def _browse_target(self):
        path = filedialog.askdirectory(initialdir=self.tgt_path.get() or '')
        if path:
            self.tgt_path.set(path)

    def _log(self, msg):
        self.log_text.configure(state='normal')
        self.log_text.insert('end', msg + '\n')
        self.log_text.see('end')
        self.log_text.configure(state='disabled')
        self.root.update_idletasks()

    def _get_files(self):
        src = self.src_path.get()
        if not src:
            return []
        if self.src_mode.get() == 'file':
            return [src] if os.path.isfile(src) else []
        # Folder: list supported files
        exts = {'.exr', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.hdr'}
        files = []
        for f in sorted(os.listdir(src)):
            if os.path.splitext(f)[1].lower() in exts:
                files.append(os.path.join(src, f))
        return files

    def _run_convert(self):
        files = self._get_files()
        tgt = self.tgt_path.get()
        mode = self.mode.get()

        if not files:
            messagebox.showerror("Error", "No files found in source.")
            return
        if not tgt:
            messagebox.showerror("Error", "Set a target folder.")
            return

        os.makedirs(tgt, exist_ok=True)

        # Get target resolution
        res_str = self.resolution.get()
        if res_str == 'original':
            target_res = None
        elif res_str == 'custom':
            target_res = self.custom_res.get()
        else:
            target_res = int(res_str)

        self._log(f"\n{'='*40}")
        self._log(f"Mode: {mode} | Files: {len(files)}")
        self._log(f"Resolution: {target_res or 'Original'}")
        self._log(f"Target: {tgt}")
        self._log(f"{'='*40}")

        success = 0
        errors = 0

        for i, filepath in enumerate(files):
            name = os.path.splitext(os.path.basename(filepath))[0]
            self._log(f"[{i+1}/{len(files)}] {os.path.basename(filepath)}")

            try:
                pixels, has_alpha = read_image(filepath)
                self._log(f"  Read: {pixels.shape} {'RGBA' if has_alpha else 'RGB'} range=[{pixels.min():.3f}, {pixels.max():.3f}]")

                if mode == 'aces':
                    result = convert_aces_to_srgb(pixels, self.aces_cs.get())
                    if has_alpha:
                        alpha = pixels[:, :, 3:4]
                        result = np.dstack([result, alpha])
                    out_path = os.path.join(tgt, f"{name}.png")
                    save_png(result, out_path, target_res=target_res)
                    self._log(f"  -> SAVED: {out_path}")
                    success += 1

                elif mode == 'raw':
                    result = convert_raw_to_srgb(pixels)
                    if has_alpha:
                        alpha = pixels[:, :, 3:4]
                        result = np.dstack([result, alpha])
                    out_path = os.path.join(tgt, f"{name}.png")
                    save_png(result, out_path, target_res=target_res)
                    self._log(f"  -> SAVED: {out_path}")
                    success += 1

                elif mode == 'split':
                    channels = split_channels(pixels)
                    for ch, data in channels.items():
                        label = self.ch_labels.get(ch, tk.StringVar(value=ch)).get()
                        out_path = os.path.join(tgt, f"{name}_{label}.png")
                        save_png(data, out_path, is_gray=True, target_res=target_res)
                        self._log(f"  -> SAVED: {out_path}")
                    success += 1

            except Exception as e:
                import traceback
                self._log(f"  ERROR: {e}")
                self._log(f"  {traceback.format_exc().strip().split(chr(10))[-1]}")
                errors += 1

        self._log(f"\nDone! {success} OK, {errors} errors out of {len(files)} files.")
        if errors > 0:
            self._log(f"Check the errors above.")

        # Verify output
        if os.path.exists(tgt):
            output_files = [f for f in os.listdir(tgt) if f.endswith('.png')]
            self._log(f"Output folder contains {len(output_files)} PNG files.")

        messagebox.showinfo("Done", f"Conversion complete!\n{success} OK, {errors} errors.")


def main():
    root = tk.Tk()
    app = TextureConverterApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
