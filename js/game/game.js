import * as THREE from 'three';
import { GamePlayer } from './game-player.js';
import { GameWorld } from './game-world.js';
import { NpcManager } from './game-npc.js';
import { GameDialogue } from './game-dialogue.js';
import { GameHud } from './game-hud.js';
import { GameCamera } from './game-camera.js';
import { GameVehicle } from './game-vehicle.js';
import { NpcDriverManager } from './game-npc-driver.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

/**
 * Game mode controller. Toggles between customizer and play.
 *
 * Reuses the existing scene/camera/renderer/character. When entering
 * play mode it:
 *  - hides the customizer panel
 *  - disables OrbitControls
 *  - moves the camera into a third-person follow rig
 *  - swaps in the GameWorld root
 *  - spawns NPCs that clone the main character
 *  - shows HUD + dialogue overlays
 *
 * Exiting restores camera, orbit controls, panel and disposes NPCs.
 */
export class Game {
    constructor({ scene, camera, renderer, character, orbit, ground, manifestData, characterConfig }) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.character = character;
        this.orbit = orbit;
        this.ground = ground;
        this.manifestData = manifestData;
        this.characterConfig = characterConfig;
        this.active = false;

        // Camera target is a getter so we can switch between player & vehicle
        this.drivingVehicle = null;
        this.gameCamera = new GameCamera(camera, () => {
            if (this.drivingVehicle) return this.drivingVehicle.getCameraTarget();
            return this.character.model.position;
        });
        this.player = new GamePlayer(character, this.gameCamera);
        this.world = new GameWorld(scene);
        this.vehicle = null;
        this.plane = null;
        this.heli = null;
        this.traffic = new NpcDriverManager(scene);
        this.npcs = new NpcManager(character, scene);
        this.npcs.setLoaderData(manifestData, characterConfig);
        this.dialogue = new GameDialogue();
        this.hud = new GameHud();

        // Saved customizer state to restore on exit
        this._savedCamPos = new THREE.Vector3();
        this._savedOrbitTarget = new THREE.Vector3();
        this._savedCharPos = new THREE.Vector3();
        this._savedCharRot = 0;
        this._savedFov = 0;
        this._savedGroundVisible = true;

        this._tmpV = new THREE.Vector3();
        this._built = false;
    }

    async build() {
        if (this._built) return;
        await this.dialogue.loadConfig();
        this.world.build();
        this.world.hide();
        // Spawn a drivable vehicle
        this.vehicle = new GameVehicle(this.scene);
        this.vehicle.group.visible = false;
        // Spawn a drivable airplane
        this.plane = new GameVehicle(this.scene, {
            url: 'assets/sketchbook/airplane.glb',
            kind: 'plane'
        });
        this.plane.group.visible = false;
        // Spawn a drivable helicopter
        this.heli = new GameVehicle(this.scene, {
            url: 'assets/sketchbook/heli.glb',
            kind: 'plane'           // uses the same flight physics for now
        });
        this.heli.group.visible = false;
        this.dialogue.build();
        this.dialogue.setHandlers({
            onDonut: (npc) => this._giveDonut(npc),
            onVeggie: (npc) => this._giveVeggie(npc),
            onBye: () => {},
        });
        this.hud.build({
            onExit: () => this.exit(),
            onJoystick: (x, y) => this.player.setJoystick(x, y),
            onInteract: () => this._tryInteract(),
        });
        this._built = true;
    }

    async enter() {
        if (this.active) return;
        await this.build();

        // Save state
        this._savedCamPos.copy(this.camera.position);
        this._savedOrbitTarget.copy(this.orbit.target);
        this._savedCharPos.copy(this.character.model.position);
        this._savedCharRot = this.character.model.rotation.y;
        this._savedFov = this.camera.fov;
        this._savedGroundVisible = this.ground.visible;

        // Switch UI
        document.getElementById('panel').classList.add('game-mode');
        this.orbit.enabled = false;
        this.ground.visible = false;
        this.world.show();
        // Force a resize so the canvas fills the now-hidden-panel area
        window.dispatchEvent(new Event('resize'));

        // Spawn at the open beach edge facing north (+Z) into the sea
        this.character.model.position.set(0, 0, 42);
        this.character.model.rotation.y = 0;
        this.player.orientation.set(0, 0, 1);
        this.player.orientationTarget.set(0, 0, 1);

        // Camera at theta=180° (south of player), phi tilted a bit down.
        // GameCamera uses degrees (Sketchbook convention).
        this.gameCamera.theta = 180;
        this.gameCamera.phi = 10;
        this.gameCamera.setObstacles(this.world.obstacles);
        // Register dynamic vehicles so NPCs collide with them
        // Register the player's drivable vehicles immediately
        this.world.setVehicles([this.vehicle, this.plane, this.heli].filter(Boolean));
        // Sketchbook-style big-world lighting + sky
        this._applyGameLighting();
        this.gameCamera.snap();
        this.gameCamera.enable(this.renderer.domElement);

        // Disable all emotion animations for the player character in game
        // mode — only Move clips should drive the skeleton.
        const emoCat = this.character.categories.get('Emotion');
        if (emoCat) {
            for (const item of emoCat.items.values()) {
                item.action.setEffectiveWeight(0);
            }
            emoCat.active = null;
        }

        // Vehicle visible & reset
        if (this.vehicle) {
            this.vehicle.group.visible = true;
            this.vehicle.group.position.set(5, 0, 5);
            this.vehicle.group.rotation.y = -0.3;
            this.vehicle.speed = 0;
        }
        if (this.plane) {
            this.plane.group.visible = true;
            const rw = this.world.runwayStart;
            if (rw) {
                this.plane.group.position.set(rw.x, 0, rw.z);
                this.plane.group.rotation.y = rw.yaw;
            } else {
                this.plane.group.position.set(-34, 0, 10);
                this.plane.group.rotation.y = 0;
            }
            this.plane.group.rotation.x = 0;
            this.plane.speed = 0;
        }
        if (this.heli) {
            this.heli.group.visible = true;
            const hp = this.world.helipad;
            if (hp) {
                this.heli.group.position.set(hp.x, 0, hp.z);
                this.heli.group.rotation.y = 0;
            } else {
                this.heli.group.position.set(30, 0, -22);
            }
            this.heli.group.rotation.x = 0;
            this.heli.speed = 0;
        }
        this.drivingVehicle = null;

        // Spawn traffic cars circling the track (AI)
        if (this.traffic.drivers.length === 0) {
            this.traffic.spawn(3);
        } else {
            this.traffic.show();
        }
        // Re-register all vehicles including traffic, so they become
        // standable surfaces for the player and colliders for NPCs.
        const allVehicles = [this.vehicle, this.plane, this.heli].filter(Boolean);
        for (const d of this.traffic.drivers) allVehicles.push(d.vehicle);
        this.world.setVehicles(allVehicles);

        // Player interact handler — F key toggles vehicle
        this.player.setInteractHandler(() => this._handleInteract());

        // Spawn NPCs (re-spawn each entry for fresh randomness)
        this.npcs.setWorld(this.world);
        this.npcs.clear();
        await this.npcs.spawn(5);

        // Camera fov widen for game feel
        this.camera.fov = 50;
        this.camera.updateProjectionMatrix();

        // Use main player name from preset name input if available
        const nameInput = document.querySelector('.gen-preset-name');
        if (nameInput && nameInput.value.trim()) {
            this.dialogue.setPlayerName(nameInput.value.trim());
        }

        this.player.enable();
        this.hud.show();
        this.active = true;
    }

    exit() {
        if (!this.active) return;
        // Force out of vehicle first
        if (this.drivingVehicle) this._exitVehicle();
        this._removeGameLighting();
        this.gameCamera.disable();
        this.player.disable();
        this.hud.hide();
        this.dialogue.close();
        this.world.hide();
        if (this.vehicle) this.vehicle.group.visible = false;
        if (this.plane) this.plane.group.visible = false;
        if (this.heli) this.heli.group.visible = false;
        this.traffic.hide();
        this.npcs.clear();

        // Restore
        document.getElementById('panel').classList.remove('game-mode');
        window.dispatchEvent(new Event('resize'));
        this.orbit.enabled = true;
        this.ground.visible = this._savedGroundVisible;
        this.character.model.position.copy(this._savedCharPos);
        this.character.model.rotation.y = this._savedCharRot;
        this.camera.position.copy(this._savedCamPos);
        this.camera.fov = this._savedFov;
        this.camera.updateProjectionMatrix();
        this.orbit.target.copy(this._savedOrbitTarget);
        this.orbit.update();

        this.active = false;
    }

    update(dt) {
        if (!this.active) return;

        const dialogueOpen = this.dialogue.isOpen();

        // Update player / vehicle only when dialogue is closed
        if (!dialogueOpen) {
            if (this.drivingVehicle) {
                // Driving → read raw input, send to vehicle, skip player move
                const input = this.player.readInput();
                this.drivingVehicle.drive(dt, input, this.world, this.npcs);
            } else {
                this.player.update(dt, this.world);
            }
        }

        const playerPos = this.drivingVehicle
            ? this.drivingVehicle.group.position
            : this.character.model.position;
        // NPCs only fear the CAR, not the walking player
        const threatPos = this.drivingVehicle
            ? this.drivingVehicle.group.position
            : null;
        this.world.update(dt, playerPos);
        this.npcs.update(dt, dialogueOpen, threatPos, this.world, this.character.model.position);
        this.traffic.update(dt);

        // Auto-pickup items
        if (!dialogueOpen) {
            const picked = this.world.pickupNear(this.character.model.position);
            if (picked) this.hud.addItem(picked);
        }

        // Camera orbit follows player
        this.gameCamera.update(dt);

        // Prompt priority: driving → NPC → vehicle
        if (dialogueOpen) return;
        if (this.drivingVehicle) {
            const label = this.drivingVehicle.kind === 'plane'
                ? 'F : sortir de l\'avion'
                : 'F : sortir de la voiture';
            this.hud.setPrompt(label);
            this.hud.setInteractVisible(false);
            this._closestNpc = null;
            return;
        }
        const closestNpc = this.npcs.findClosest(playerPos, 1.8);
        if (closestNpc) {
            this.hud.setPrompt(`${closestNpc.name}`);
            this.hud.setInteractVisible(true);
            this._closestNpc = closestNpc;
            return;
        }
        // Any vehicle in range?
        const vehicles = [this.vehicle, this.plane, this.heli].filter(Boolean);
        for (const v of vehicles) {
            const dx = v.group.position.x - playerPos.x;
            const dz = v.group.position.z - playerPos.z;
            if (Math.hypot(dx, dz) < 3.2) {
                this.hud.setPrompt(v.kind === 'plane'
                    ? 'F : monter dans l\'avion'
                    : 'F : monter dans la voiture');
                this.hud.setInteractVisible(false);
                this._closestNpc = null;
                return;
            }
        }
        this.hud.setPrompt(null);
        this.hud.setInteractVisible(false);
        this._closestNpc = null;
    }

    /**
     * Sketchbook-inspired outdoor lighting — strong hemisphere +
     * warm directional sun with a big shadow camera that covers the
     * whole island, plus a gradient sky background.
     */
    _applyGameLighting() {
        if (this._gameLightsApplied) return;
        this._gameLightsApplied = true;

        // Save existing scene state so we can restore on exit
        this._savedBackground = this.scene.background;
        this._savedEnvironment = this.scene.environment;

        // Gradient sky (top blue, horizon warm)
        const canvas = document.createElement('canvas');
        canvas.width = 8; canvas.height = 256;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 0, 256);
        grad.addColorStop(0, '#3a70b8');
        grad.addColorStop(0.55, '#9ec6ea');
        grad.addColorStop(0.82, '#ffd4a0');
        grad.addColorStop(1, '#ffa86a');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 8, 256);
        const skyTex = new THREE.CanvasTexture(canvas);
        skyTex.colorSpace = THREE.SRGBColorSpace;
        this.scene.background = skyTex;
        this._gameSkyTex = skyTex;

        // Hemisphere light for soft ambient fill
        this._gameHemi = new THREE.HemisphereLight(0xb7dcff, 0xe5c08a, 0.85);
        this.scene.add(this._gameHemi);

        // Warm directional sun
        this._gameSun = new THREE.DirectionalLight(0xfff1d0, 2.2);
        this._gameSun.position.set(24, 36, 14);
        this._gameSun.target.position.set(0, 0, 0);
        this._gameSun.castShadow = true;
        this._gameSun.shadow.mapSize.set(2048, 2048);
        this._gameSun.shadow.camera.near = 1;
        this._gameSun.shadow.camera.far = 120;
        this._gameSun.shadow.camera.left = -55;
        this._gameSun.shadow.camera.right = 55;
        this._gameSun.shadow.camera.top = 55;
        this._gameSun.shadow.camera.bottom = -55;
        this._gameSun.shadow.bias = -0.0005;
        this._gameSun.shadow.normalBias = 0.02;
        this.scene.add(this._gameSun);
        this.scene.add(this._gameSun.target);

        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.1;
    }

    _removeGameLighting() {
        if (!this._gameLightsApplied) return;
        this._gameLightsApplied = false;
        if (this._gameHemi) { this.scene.remove(this._gameHemi); this._gameHemi = null; }
        if (this._gameSun)  {
            this.scene.remove(this._gameSun);
            this.scene.remove(this._gameSun.target);
            this._gameSun = null;
        }
        this.scene.background = this._savedBackground;
        this.scene.environment = this._savedEnvironment;
    }

    /**
     * Export the current world decor as a GLB file the user can open
     * in Blender / re-export as FBX. Call via `_game.exportDecor()`.
     */
    exportDecor() {
        const exporter = new GLTFExporter();
        exporter.parse(
            this.world.root,
            (arrayBuffer) => {
                const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'gloops_decor.glb';
                a.click();
                URL.revokeObjectURL(url);
                console.log('[exportDecor] downloaded gloops_decor.glb');
            },
            (err) => console.error('[exportDecor] failed:', err),
            { binary: true, onlyVisible: true }
        );
    }

    _tryInteract() {
        const npc = this._closestNpc;
        if (!npc) return;
        this.dialogue.open(npc);
    }

    /** Called on F key. Enter/exit vehicle or talk to NPC. */
    _handleInteract() {
        // Already driving → exit
        if (this.drivingVehicle) {
            this._exitVehicle();
            return;
        }
        // Pick the closest vehicle in range (car, plane, heli)
        const candidates = [this.vehicle, this.plane, this.heli].filter(Boolean);
        const playerPos = this.character.model.position;
        let closest = null;
        let best = 3.2;
        for (const v of candidates) {
            const dx = v.group.position.x - playerPos.x;
            const dz = v.group.position.z - playerPos.z;
            const d = Math.hypot(dx, dz);
            if (d < best) { best = d; closest = v; }
        }
        if (closest) {
            this._enterVehicle(closest);
            return;
        }
        // Otherwise dialogue with closest NPC
        this._tryInteract();
    }

    _enterVehicle(v) {
        const target = v || this.vehicle;
        if (!target) return;
        if (target.enter(this.character)) {
            this.drivingVehicle = target;
            this.gameCamera.targetRadius = target.kind === 'plane' ? 10 : 7.5;
            this.hud.setMode(target.kind === 'plane' ? 'fly' : 'drive');
            // Freeze Move animations so the character holds the T-pose
            const moveCat = this.character.categories.get('Move');
            if (moveCat) {
                for (const item of moveCat.items.values()) {
                    item.action.setEffectiveWeight(0);
                }
                moveCat.active = null;
            }
            this.player._currentLocomotion = null;
        }
    }

    _exitVehicle() {
        if (!this.drivingVehicle) return;
        this.drivingVehicle.exit();
        this.drivingVehicle = null;
        this.gameCamera.targetRadius = 5.0;
        this.player.velocity.set(0, 0, 0);
        this.hud.setMode('walk');
    }

    _giveDonut(npc) {
        if (!this.hud.consumeDonut()) return;
        npc.feedDonut();
        this.dialogue.refresh('donut');
    }

    _giveVeggie(npc) {
        if (!this.hud.consumeVeggie()) return;
        npc.feedVeggie();
        this.dialogue.refresh('veggie');
    }
}
