"""
Gloops — Batch FBX → GLB converter (via headless Blender).

Three ways to run:

  1) GUI (no args):

     python scripts/fbx_to_glb.py

     Opens a Tkinter window with folder pickers, Blender auto-detect,
     options, and a live log. Zero dependency.

  2) Command line (regular shell):

     python scripts/fbx_to_glb.py --input fbx/ANIM/Move --output assets/glb/Move

  3) Inside Blender headless (used internally by modes 1 and 2):

     blender --background --python scripts/fbx_to_glb.py -- \\
         --input fbx/ANIM/Move --output assets/glb/Move

Options:
   --compress           Draco mesh compression (smaller GLB, slower load)
   --no-anim            skip animations (geometry-only GLB)
   --no-morphs          skip blend shapes
   --yup                Y-up (three.js convention, default)
   --scale SCALE        uniform scale multiplier

Override Blender path via BLENDER_EXE env var.
"""

import argparse
import os
import sys
import subprocess


# --------------------------------------------------------------
# Detect Blender executable (regular python run only)
# --------------------------------------------------------------

DEFAULT_BLENDER_PATHS = [
    r"C:\Program Files\Blender Foundation\Blender 4.3\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.1\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.0\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 3.6\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 3.5\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender\blender.exe",
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "/usr/bin/blender",
    "/usr/local/bin/blender",
]


def find_blender():
    """Look for a blender executable in env, PATH, and known install dirs."""
    env = os.environ.get("BLENDER_EXE")
    if env and os.path.exists(env):
        return env

    # Try known fixed paths
    for p in DEFAULT_BLENDER_PATHS:
        if os.path.exists(p):
            return p

    # Glob in Program Files (Windows) for any version
    try:
        import glob
        for base in [r"C:\Program Files\Blender Foundation",
                     r"C:\Program Files (x86)\Blender Foundation"]:
            if os.path.isdir(base):
                for match in sorted(glob.glob(os.path.join(base, "Blender*", "blender.exe")), reverse=True):
                    return match
    except Exception:
        pass

    # PATH lookup
    try:
        import shutil
        which = shutil.which("blender")
        if which:
            return which
    except Exception:
        pass

    return None


# --------------------------------------------------------------
# Blender-side logic (runs INSIDE Blender when --background --python)
# --------------------------------------------------------------

def _run_in_blender(args):
    import bpy

    input_root = os.path.abspath(args.input)
    output_root = os.path.abspath(args.output)
    if not os.path.isdir(input_root):
        print("[fbx_to_glb] input folder not found: {}".format(input_root))
        return 1
    os.makedirs(output_root, exist_ok=True)

    # Walk the input folder for .fbx files
    fbx_files = []
    for dirpath, _, filenames in os.walk(input_root):
        for f in filenames:
            if f.lower().endswith(".fbx"):
                full = os.path.join(dirpath, f)
                rel = os.path.relpath(full, input_root)
                fbx_files.append((full, rel))

    if not fbx_files:
        print("[fbx_to_glb] no .fbx files found in {}".format(input_root))
        return 1

    print("[fbx_to_glb] converting {} files from {} -> {}".format(
        len(fbx_files), input_root, output_root))
    print("[fbx_to_glb] options: compress={}, animations={}, morphs={}, yup={}, scale={}".format(
        args.compress, not args.no_anim, not args.no_morphs, args.yup, args.scale))

    ok = 0
    failed = []
    for i, (fbx_path, rel) in enumerate(fbx_files, 1):
        glb_rel = os.path.splitext(rel)[0] + ".glb"
        glb_path = os.path.join(output_root, glb_rel)
        os.makedirs(os.path.dirname(glb_path), exist_ok=True)

        print("\n[{}/{}] {}".format(i, len(fbx_files), rel))

        # --- Reset scene ---
        bpy.ops.wm.read_factory_settings(use_empty=True)

        try:
            bpy.ops.import_scene.fbx(filepath=fbx_path)
        except Exception as e:
            print("  >> IMPORT FAILED: {}".format(e))
            failed.append(rel)
            continue

        # Optional scale
        if args.scale != 1.0:
            for obj in bpy.context.scene.objects:
                if obj.parent is None:
                    obj.scale = tuple(s * args.scale for s in obj.scale)

        # --- Export ---
        export_kwargs = dict(
            filepath=glb_path,
            export_format='GLB',
            export_yup=args.yup,
            export_animations=not args.no_anim,
            export_morph=not args.no_morphs,
            export_skins=True,
            export_materials='EXPORT',
            export_apply=False,
            export_lights=False,
            export_cameras=False,
        )
        if args.compress:
            export_kwargs['export_draco_mesh_compression_enable'] = True
            export_kwargs['export_draco_mesh_compression_level'] = 6

        try:
            bpy.ops.export_scene.gltf(**export_kwargs)
            fbx_size = os.path.getsize(fbx_path)
            glb_size = os.path.getsize(glb_path)
            ratio = 100.0 * glb_size / fbx_size if fbx_size else 0
            print("  >> exported ({} KB → {} KB, {:.0f}%)".format(
                fbx_size // 1024, glb_size // 1024, ratio))
            ok += 1
        except Exception as e:
            print("  >> EXPORT FAILED: {}".format(e))
            failed.append(rel)

    print("\n========== DONE ==========")
    print("{}/{} files converted".format(ok, len(fbx_files)))
    if failed:
        print("Failed:")
        for f in failed:
            print("  - {}".format(f))
    print("==========================")
    return 0 if ok == len(fbx_files) else 1


# --------------------------------------------------------------
# Arg parsing (shared between wrapper + blender-side)
# --------------------------------------------------------------

def _parse_args(argv):
    p = argparse.ArgumentParser(description="Batch FBX -> GLB via Blender headless")
    p.add_argument("--input", required=True, help="Input folder with .fbx files")
    p.add_argument("--output", required=True, help="Output folder for .glb files")
    p.add_argument("--compress", action="store_true",
                   help="Enable Draco mesh compression")
    p.add_argument("--no-anim", action="store_true", help="Skip animations")
    p.add_argument("--no-morphs", action="store_true", help="Skip blend shapes")
    p.add_argument("--yup", action="store_true", default=True,
                   help="Convert to Y-up (default, three.js convention)")
    p.add_argument("--scale", type=float, default=1.0,
                   help="Uniform scale factor (default 1.0)")
    return p.parse_args(argv)


# --------------------------------------------------------------
# Entry points
# --------------------------------------------------------------

def _run_conversion(blender, cli_args, log_fn=print):
    """Spawn Blender with this script + args, stream stdout line-by-line
    to `log_fn`. Returns the process return code."""
    cmd = [
        blender,
        "--background",
        "--python", os.path.abspath(__file__),
        "--",
    ] + cli_args
    log_fn("[fbx_to_glb] Blender: {}".format(blender))
    log_fn("[fbx_to_glb] cmd: {}".format(" ".join(cmd)))
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        for line in iter(proc.stdout.readline, ''):
            if not line:
                break
            log_fn(line.rstrip())
        proc.wait()
        return proc.returncode
    except Exception as e:
        log_fn("[fbx_to_glb] ERROR: {}".format(e))
        return 1


def main_wrapper():
    """Regular python wrapper: finds Blender, re-invokes this script
    inside Blender in background mode."""
    blender = find_blender()
    if not blender:
        print("[fbx_to_glb] Blender not found. Set BLENDER_EXE env var or install to a default path.")
        sys.exit(1)

    result = _run_conversion(blender, sys.argv[1:])
    sys.exit(result)


# --------------------------------------------------------------
# Tkinter GUI
# --------------------------------------------------------------

def launch_gui():
    import tkinter as tk
    from tkinter import ttk, filedialog, scrolledtext
    import threading

    root = tk.Tk()
    root.title("Gloops — FBX → GLB Converter")
    root.geometry("760x560")
    root.minsize(680, 480)

    # Style
    try:
        style = ttk.Style()
        style.theme_use('clam')
    except Exception:
        pass

    PAD = 10
    frm = ttk.Frame(root, padding=PAD)
    frm.pack(fill='both', expand=True)

    # -----------------------------------------------------------------
    # Row 0: Blender path + auto-detect
    # -----------------------------------------------------------------
    ttk.Label(frm, text="Blender:").grid(row=0, column=0, sticky='w', pady=3)
    blender_var = tk.StringVar(value=find_blender() or "")
    blender_entry = ttk.Entry(frm, textvariable=blender_var)
    blender_entry.grid(row=0, column=1, sticky='ew', padx=4)
    def browse_blender():
        p = filedialog.askopenfilename(
            title="Locate blender.exe",
            filetypes=[("Blender executable", "blender.exe blender"), ("All files", "*.*")]
        )
        if p:
            blender_var.set(p)
    ttk.Button(frm, text="Browse...", command=browse_blender, width=10).grid(row=0, column=2, padx=2)
    def detect_blender():
        b = find_blender()
        if b:
            blender_var.set(b)
            log("[gui] detected Blender at {}".format(b))
        else:
            log("[gui] Blender NOT found. Browse manually or set BLENDER_EXE.")
    ttk.Button(frm, text="🔍 Detect", command=detect_blender, width=10).grid(row=0, column=3, padx=2)

    # -----------------------------------------------------------------
    # Row 1: Input folder
    # -----------------------------------------------------------------
    ttk.Label(frm, text="Input (FBX):").grid(row=1, column=0, sticky='w', pady=3)
    input_var = tk.StringVar()
    default_in = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "fbx", "ANIM", "Move"))
    if os.path.isdir(default_in):
        input_var.set(default_in)
    ttk.Entry(frm, textvariable=input_var).grid(row=1, column=1, sticky='ew', padx=4)
    def browse_in():
        d = filedialog.askdirectory(title="Pick input FBX folder", initialdir=input_var.get() or ".")
        if d:
            input_var.set(d)
    ttk.Button(frm, text="Browse...", command=browse_in, width=10).grid(row=1, column=2, padx=2)

    # -----------------------------------------------------------------
    # Row 2: Output folder
    # -----------------------------------------------------------------
    ttk.Label(frm, text="Output (GLB):").grid(row=2, column=0, sticky='w', pady=3)
    output_var = tk.StringVar()
    default_out = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "assets", "glb", "Move"))
    output_var.set(default_out)
    ttk.Entry(frm, textvariable=output_var).grid(row=2, column=1, sticky='ew', padx=4)
    def browse_out():
        d = filedialog.askdirectory(title="Pick output folder", initialdir=output_var.get() or ".")
        if d:
            output_var.set(d)
    ttk.Button(frm, text="Browse...", command=browse_out, width=10).grid(row=2, column=2, padx=2)

    # -----------------------------------------------------------------
    # Row 3: Options
    # -----------------------------------------------------------------
    opts_frame = ttk.LabelFrame(frm, text="Options", padding=8)
    opts_frame.grid(row=3, column=0, columnspan=4, sticky='ew', pady=8)

    compress_var = tk.BooleanVar(value=True)
    noanim_var = tk.BooleanVar(value=False)
    nomorphs_var = tk.BooleanVar(value=False)
    yup_var = tk.BooleanVar(value=True)
    scale_var = tk.DoubleVar(value=1.0)

    ttk.Checkbutton(opts_frame, text="Draco compression (smaller, slower load)",
                    variable=compress_var).grid(row=0, column=0, sticky='w', padx=2)
    ttk.Checkbutton(opts_frame, text="Skip animations",
                    variable=noanim_var).grid(row=0, column=1, sticky='w', padx=16)

    ttk.Checkbutton(opts_frame, text="Skip blend shapes",
                    variable=nomorphs_var).grid(row=1, column=0, sticky='w', padx=2)
    ttk.Checkbutton(opts_frame, text="Y-up (three.js convention)",
                    variable=yup_var).grid(row=1, column=1, sticky='w', padx=16)

    ttk.Label(opts_frame, text="Scale:").grid(row=2, column=0, sticky='w', pady=4)
    scale_spin = ttk.Spinbox(opts_frame, from_=0.001, to=100, increment=0.1,
                              textvariable=scale_var, width=10)
    scale_spin.grid(row=2, column=0, sticky='w', padx=(55, 0), pady=4)

    # -----------------------------------------------------------------
    # Row 4: Log area
    # -----------------------------------------------------------------
    ttk.Label(frm, text="Log:").grid(row=4, column=0, sticky='nw', pady=(8, 3))
    log_area = scrolledtext.ScrolledText(frm, height=14, font=('Consolas', 9),
                                          wrap='word', bg='#1e1e2e', fg='#cdd6f4',
                                          insertbackground='#cdd6f4')
    log_area.grid(row=4, column=1, columnspan=3, sticky='nsew', pady=(8, 3))

    frm.columnconfigure(1, weight=1)
    frm.rowconfigure(4, weight=1)

    def log(line):
        log_area.configure(state='normal')
        log_area.insert('end', str(line) + "\n")
        log_area.see('end')
        log_area.configure(state='disabled')
        root.update_idletasks()

    def clear_log():
        log_area.configure(state='normal')
        log_area.delete('1.0', 'end')
        log_area.configure(state='disabled')

    # -----------------------------------------------------------------
    # Row 5: Convert button
    # -----------------------------------------------------------------
    btn_frame = ttk.Frame(frm)
    btn_frame.grid(row=5, column=0, columnspan=4, sticky='ew', pady=8)

    convert_btn = ttk.Button(btn_frame, text="🚀 CONVERT")
    convert_btn.pack(side='left', ipadx=20, ipady=6)
    ttk.Button(btn_frame, text="Clear log", command=clear_log).pack(side='left', padx=8)

    status_var = tk.StringVar(value="Ready.")
    ttk.Label(btn_frame, textvariable=status_var, foreground='#5a5a6a').pack(side='right')

    def do_convert_async():
        blender = blender_var.get().strip()
        input_folder = input_var.get().strip()
        output_folder = output_var.get().strip()

        if not blender or not os.path.exists(blender):
            log("[ERROR] Blender path invalid: " + repr(blender))
            return
        if not input_folder or not os.path.isdir(input_folder):
            log("[ERROR] Input folder not found: " + repr(input_folder))
            return
        if not output_folder:
            log("[ERROR] Set an output folder.")
            return

        cli = ["--input", input_folder, "--output", output_folder]
        if compress_var.get(): cli.append("--compress")
        if noanim_var.get():   cli.append("--no-anim")
        if nomorphs_var.get(): cli.append("--no-morphs")
        if scale_var.get() != 1.0:
            cli += ["--scale", str(scale_var.get())]
        # yup is the default, no flag needed

        status_var.set("Converting...")
        convert_btn.config(state='disabled')
        log("=" * 50)
        log("Starting conversion...")
        rc = _run_conversion(blender, cli, log_fn=log)
        status_var.set("Done (exit {})".format(rc) if rc == 0 else "FAILED (exit {})".format(rc))
        convert_btn.config(state='normal')

    def on_convert():
        threading.Thread(target=do_convert_async, daemon=True).start()

    convert_btn.config(command=on_convert)

    # Initial log
    log("Ready. Pick folders and click CONVERT.")
    if not blender_var.get():
        log("⚠️  Blender not auto-detected. Click 'Detect' or 'Browse...'.")
    else:
        log("Blender found: " + blender_var.get())

    root.mainloop()


def main_blender():
    """Blender-side entry point: parses args after --, runs the batch."""
    argv = sys.argv
    # Blender adds its own args before --, ours come after
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = argv[1:]
    args = _parse_args(argv)
    sys.exit(_run_in_blender(args))


if __name__ == "__main__":
    # Are we running inside Blender?
    try:
        import bpy
        _in_blender = True
    except ImportError:
        _in_blender = False

    if _in_blender:
        main_blender()
    elif len(sys.argv) > 1:
        # Command-line mode: run Blender with the passed args
        main_wrapper()
    else:
        # No args → open the GUI
        launch_gui()
