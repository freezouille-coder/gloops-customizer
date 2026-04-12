# Gloops - Texture Nomenclature

## Folder Structure

```
TEXTURES/
  {mesh_name}/
    {mesh}_{Type}.png             -> base texture
    {mesh}_{Type}.{N}.png         -> variant N (0, 1, 2, ...)
```

The folder name must match the material name in the FBX (case-insensitive).
Example: material "Body" -> folder `TEXTURES/body/`


## Texture Types

| Suffix        | Aliases                  | Slot               | Colorspace   | Channels | Notes                          |
|---------------|--------------------------|---------------------|-------------|----------|--------------------------------|
| `_Diffuse`    | `_BaseColor`, `_Color`   | R Channel Color A   | sRGB        | RGB      | Main color. Supports variants  |
| `_ID`         | `_Mask`                  | RGBA Mask           | Linear/Raw  | RGBA     | 4 zone separator               |
| `_Normal`     |                          | Normal Map          | Linear/Raw  | RGB      | OpenGL format (Y up)           |
| `_Roughness`  | `_Rough`                 | Roughness Map       | Linear/Raw  | Greyscale| White=rough, Black=smooth      |
| `_Metalness`  | `_Metal`, `_Metallic`    | Metalness Map       | Linear/Raw  | Greyscale| White=metal, Black=dielectric  |
| `_Occ`        | `_AO`, `_Occlusion`      | Ambient Occlusion   | Linear/Raw  | Greyscale| White=exposed, Black=occluded  |
| `_Normal`     |                          | Normal Map          | Linear/Raw  | RGB      | OpenGL (green=Y up)            |
| `_Ramp`       |                          | Blend Mask (A/B)    | Linear/Raw  | Greyscale| White=Color B, Black=Color A   |
| `_DS`         | `_Displacement`,`_Height`| Displacement Map    | Linear/Raw  | Greyscale| OFF by default, enable in UI   |
| `_Alpha`      | `_Opacity`               | Alpha Map           | Linear/Raw  | Greyscale| White=opaque, Black=transparent|
| `_Emit`       | `_Emissive`              | Emissive Map        | sRGB        | RGB      | Glow color/weight              |
| `_SSS`        | `_Subsurface`            | SSS Map             | Linear/Raw  | Greyscale| Subsurface scattering weight   |
| `_Bump`       | `_BP`                    | Bump Map            | Linear/Raw  | Greyscale| Height-based bumps             |
| `_DiffuseW`   | `_DW`                    | Diffuse Weight Map  | Linear/Raw  | Greyscale| White=full diffuse, Black=none |
| `_Pattern`    |                          | Pattern Map         | Linear/Raw  | Greyscale| Casual/Luxury pattern. Supports variants |


## Variants (Diffuse)

Variants allow multiple diffuse options per material (e.g., different eye colors).

```
eyes/
  eyes_Diffuse.png      -> default (shown first)
  eyes_Diffuse.0.png    -> variant 0
  eyes_Diffuse.1.png    -> variant 1
  eyes_Diffuse.2.png    -> variant 2
  ...
```

Variants appear as clickable thumbnails in the R Channel section.
The default (no number) is loaded automatically.


## Pattern System

Patterns add surface detail to materials. Two modes available:

### Casual Mode
- **Diffuse**: Darkens the base color where the pattern is white
- **Bump**: Pushes geometry inward (engraved effect)
- Use for: fabric textures, subtle surface variation, wear/tear

### Luxury Mode
- **Metalness**: Adds metallic sheen where the pattern is white
- **Bump**: Pushes geometry outward (embossed/raised effect)
- Use for: gold embossing, metallic logos, decorative elements

### Pattern Variants
```
body/
  body_Pattern.0.png    -> no pattern (all black)
  body_Pattern.1.png    -> stripes
  body_Pattern.2.png    -> dots
  body_Pattern.3.png    -> logo
```

Pattern 0 should always be all-black (no pattern = default).
Variants appear as clickable thumbnails in the UI.


## RGB Mask Channels

The `_ID` texture uses 4 channels to define color zones:

| Channel | Zone | Controls                      |
|---------|------|-------------------------------|
| R (Red) | Zone 1 | R Channel Color A / Color B |
| G (Green)| Zone 2 | G Channel Color A / Color B|
| B (Blue) | Zone 3 | B Channel Color A / Color B|
| A (Alpha)| Zone 4 | A Channel Color A / Color B|

- Each zone can have a flat color (from palette) or a texture
- The **Blend Mask** (B&W) controls the mix between Color A and Color B per zone
- Black areas (no channel data) = base texture passthrough


## Format Guidelines

| Property     | Recommendation          |
|-------------|-------------------------|
| Format      | PNG (lossless, alpha support) |
| Resolution  | 1024x1024 or 2048x2048  |
| Bit depth   | 8-bit (standard)        |
| Colorspace  | sRGB for Diffuse/Emissive, Linear/Raw for everything else |
| Normal Map  | OpenGL format (green=Y up). Flip green if from DirectX |


## Auto-Connect

When the page loads, textures are automatically connected if:
1. The folder name matches a material name (case-insensitive)
2. The texture follows the naming convention above

**Displacement is NOT auto-connected** (OFF by default). Enable manually in the UI.

If a `_Diffuse` texture exists in the folder, the RGBA Mask and Blend Mask
are NOT auto-connected (simple diffuse mode takes priority).


## Examples

### Body (with RGBA mask system)
```
TEXTURES/body/
  body_ID.png           -> RGBA mask (4 zones)
  body_Ramp.png         -> Blend mask (A/B control)
  body_Normal.png       -> Normal map
  body_Roughness.png    -> Roughness
  body_Occ.png          -> Ambient occlusion
  body_SSS.png          -> Subsurface weight
  body_DS.png           -> Displacement (manual)
```

### Eyes (with diffuse variants)
```
TEXTURES/eyes/
  eyes_Diffuse.png      -> Default diffuse
  eyes_Diffuse.0.png    -> Blue eyes
  eyes_Diffuse.1.png    -> Green eyes
  eyes_Diffuse.2.png    -> Brown eyes
  ...
  eyes_Normal.png       -> Normal map
  eyes_Roughness.png    -> Roughness
```

### Horns (with RGBA mask)
```
TEXTURES/horns/
  horns_ID.png
  horns_Normal.png
  horns_Roughness.png
  horns_Occ.png
```


## Build Manifest

After adding/removing textures, regenerate the manifest:

```
python scripts/build_manifest.py
```

This scans TEXTURES/ and FBX/ANIM/ folders and updates `FBX/manifest.json`.
