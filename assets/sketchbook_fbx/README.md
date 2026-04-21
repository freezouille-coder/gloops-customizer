# Sketchbook assets — FBX for Maya

Conversion automatique des `.glb` originaux de Sketchbook (dossier
`../sketchbook/`) vers `.fbx` pour ouverture dans Maya.

Régénéré avec :

    "C:/Program Files/Blender Foundation/Blender 4.3/blender.exe" \
        --background --python scripts/glb_to_fbx_sketchbook.py

## Contenu

| Fichier          | Taille  | Description                                          |
|------------------|---------|------------------------------------------------------|
| `car.fbx`        | 422 KB  | Voiture jouable (carrosserie + 4 roues nommées)     |
| `heli.fbx`       | 265 KB  | Hélicoptère (corps + rotor principal + rotor queue) |
| `airplane.fbx`   | 273 KB  | Avion (fuselage + hélice avant)                      |
| `boxman.fbx`     | 2.7 MB  | Personnage humanoïde Sketchbook (le "boxman" rig)   |
| `world.fbx`      | 2.5 MB  | Île complète avec meshes `physics`/`scenario` taggés |

## Textures

Chaque FBX est accompagné de son dossier `<nom>.fbm/` (convention FBX
standard — Maya le lit automatiquement à l'ouverture). Les PNGs y sont
déjà décompressés. Un dossier `textures/<nom>/` contient les mêmes PNGs
en plus pour consultation rapide si besoin.

## Convention Sketchbook

L'île contient des meshes avec `userData.data` taggé — à retrouver dans
Maya via les attributs personnalisés :

| Tag              | Usage                                                   |
|------------------|---------------------------------------------------------|
| `physics`        | Collider invisible (la texture/visibilité est ignorée)  |
| `scenario`       | Point de spawn nommé (player, car, plane, heli, etc.)   |
| `path`           | Chemin de patrouille pour véhicules IA                  |

Les rotors et roues sont détectés côté web par nom de mesh (ex. `Wheel`,
`Rotor`, `Blade`, `Prop`, `Helice`). Si tu les renommes, pense à mettre
à jour `js/game/game-vehicle.js` en conséquence.

## Axes

- Blender exporte en **Y-up, -Z forward** — la convention Maya.
- Scale = 1.0, unités = mètres.

Rien à régler à l'import Maya : `File → Import → <.fbx>` et c'est en place.
