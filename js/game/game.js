import * as THREE from 'three';
import { GamePlayer } from './game-player.js';
import { GameWorld } from './game-world.js';
import { SketchbookWorld } from './game-world-sketchbook.js';
import { NpcManager } from './game-npc.js';
import { GameDialogue } from './game-dialogue.js';
import { GameHud } from './game-hud.js';
import { GameCamera } from './game-camera.js';
import { GameVehicle } from './game-vehicle.js';
import { NpcDriverManager } from './game-npc-driver.js';
import { MissionManager } from './game-missions.js';
import { PhysicsWorld } from './physics-world.js?v=2';
import { FreeCam } from './game-freecam.js';
import { WastedManager } from './game-wasted.js';
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
        this.paused = false;

        // Camera target is a getter so we can switch between player & vehicle
        this.drivingVehicle = null;
        this.gameCamera = new GameCamera(camera, () => {
            if (this.drivingVehicle) return this.drivingVehicle.getCameraTarget();
            return this.character.model.position;
        });
        this.player = new GamePlayer(character, this.gameCamera);
        // Level selection — 'city' (default) or 'sketchbook'
        this.levelMode = localStorage.getItem('gloops_level') || 'city';
        this.world = this.levelMode === 'sketchbook'
            ? new SketchbookWorld(scene)
            : new GameWorld(scene);
        this.vehicle = null;
        this.plane = null;
        this.heli = null;
        this.traffic = new NpcDriverManager(scene);
        this.npcs = new NpcManager(character, scene);
        this.npcs.setLoaderData(manifestData, characterConfig);
        this.dialogue = new GameDialogue();
        this.hud = new GameHud();
        // Sketchbook-style cannon-es physics world (Stage 1: wired but
        // does not yet drive any gameplay — static + debug wireframes only).
        this.physics = new PhysicsWorld(scene);
        // Free fly camera for debugging (press C in-game to toggle)
        this.freecam = new FreeCam(camera, renderer);
        // GTA-style "WASTED" drown system
        this.wasted = new WastedManager(character, scene);
        // Crazy-Taxi style delivery mission manager (only active while driving)
        this.missions = new MissionManager(scene, this);

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
        // Wire physics BEFORE world.build() so _buildTestArena can register
        // cannon-es bodies for its ramps and pillars as it creates them.
        this.world.setPhysicsWorld(this.physics);
        this.world.build();
        // Wait for async worlds (city blocks from manifest)
        if (this.world.ready) {
            await this.world.ready();
        }
        this.world.hide();
        // cannon-es ground at y=0 — matches the visual ground plane
        this.physics.addGroundPlane();
        // Spawn a drivable car (cannon-es vehicle physics)
        this.vehicle = new GameVehicle(this.scene);
        this.vehicle.setPhysicsWorld(this.physics);
        this.vehicle.group.visible = false;
        // Spawn a drivable helicopter (cannon-es heli physics)
        this.heli = new GameVehicle(this.scene, {
            url: 'assets/sketchbook/heli.glb',
            kind: 'heli',
        });
        this.heli.setPhysicsWorld(this.physics);
        this.heli.group.visible = false;
        // Airplane stays disabled for now
        this.plane = null;
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
        console.log('[game] enter — starting build');
        await this.build();
        console.log('[game] enter — build done');

        // Wire physics debug controls once
        if (!this._physicsKeyBound) {
            window.addEventListener('keydown', (e) => {
                if (!this.active) return;
                // ESC = toggle pause menu (always available while game is active)
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this._togglePause();
                    return;
                }
                // Swallow all other keys while paused
                if (this.paused) return;
                const k = e.key.toLowerCase();
                if (k === 'c') {
                    this.freecam.toggle();
                    return;
                }
                if (k === 'p') {
                    const on = this.physics.toggleDebug();
                    console.log(`[physics] debug wireframes: ${on ? 'ON' : 'off'}`);
                } else if (k === 'b') {
                    // Drop a test ball from above the player / vehicle
                    const origin = this.drivingVehicle
                        ? this.drivingVehicle.group.position
                        : this.character.model.position;
                    const body = this.physics.addDynamicSphere(
                        0.6, 2,
                        { x: origin.x + (Math.random() - 0.5) * 2,
                          y: origin.y + 10,
                          z: origin.z + (Math.random() - 0.5) * 2 }
                    );
                    body.linearDamping = 0.05;
                    body.angularDamping = 0.15;
                    // Give it a little random spin / velocity so it looks alive
                    body.velocity.set(
                        (Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2
                    );
                    console.log(`[physics] dropped ball at (${body.position.x.toFixed(1)}, ${body.position.y.toFixed(1)}, ${body.position.z.toFixed(1)})`);
                }
            });
            this._physicsKeyBound = true;
        }

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

        // Spawn position — depends on level
        if (this.levelMode === 'sketchbook') {
            // Use the scenario player spawn if present; else use (0, y, 0)
            // at whatever the terrain height is there.
            const sp = this.world.spawns?.player;
            const sx = sp?.x ?? 0;
            const sz = sp?.z ?? 0;
            const sy = (this.world.raycastGroundAt?.(sx, sz) ?? 0) + 0.1;
            this.character.model.position.set(sx, sy, sz);
        } else {
            // Spawn south of the 10×10 city grid (extent ±125) so the
            // player sees the blocks in front of him. Preserve the
            // customizer Y so the model's pivot-to-feet offset is kept —
            // otherwise Y=0 buries him.
            const feetY = this._savedCharPos.y;
            this.character.model.position.set(0, feetY, 150);
        }
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

        // Car spawn — just east of the player, same south edge of city
        if (this.vehicle) {
            this.vehicle.group.visible = true;
            this.vehicle.group.position.set(10, 0, 140);
            this.vehicle.group.rotation.y = 0;
            this.vehicle.speed = 0;
            if (this.vehicle.chassisBody) {
                this.vehicle.chassisBody.position.set(10, 1.2, 140);
                this.vehicle.chassisBody.velocity.setZero();
                this.vehicle.chassisBody.angularVelocity.setZero();
                this.vehicle.chassisBody.quaternion.setFromEuler(0, 0, 0);
            }
        }
        // Helicopter spawn — north-west corner of the city, visible from afar
        if (this.heli) {
            this.heli.group.visible = true;
            this.heli.group.position.set(-60, 0, -100);
            this.heli.group.rotation.set(0, Math.PI * 0.25, 0);
            this.heli.speed = 0;
            if (this.heli.chassisBody) {
                this.heli.chassisBody.position.set(-60, 1.5, -100);
                this.heli.chassisBody.velocity.setZero();
                this.heli.chassisBody.angularVelocity.setZero();
                this.heli.chassisBody.quaternion.setFromEuler(0, Math.PI * 0.25, 0);
            }
        }

        this.drivingVehicle = null;

        // Keep the interact handler wired so F enters/exits vehicles.
        this.player.setInteractHandler(() => this._handleInteract());

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
        console.log('[game] enter — active');
    }

    exit() {
        if (!this.active) return;
        // Clear any leftover pause overlay
        this.paused = false;
        document.getElementById('pause-menu')?.classList.add('hidden');
        // Force out of vehicle first (also restores character visibility)
        if (this.drivingVehicle) this._exitVehicle();
        // Belt-and-suspenders: ensure the character is visible back in
        // the customizer even if something funky left it hidden.
        if (this.character.model) this.character.model.visible = true;
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
        // ESC pause freezes the world: no player input, no physics step,
        // no AI. Only the camera/mixer stay alive so nothing snaps.
        if (this.paused) return;

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
        this.world.update(dt, playerPos, this.camera);
        this.npcs.update(dt, dialogueOpen, threatPos, this.world, this.character.model.position);
        this.traffic.update(dt);
        this.missions.update(dt);
        this.hud.updateMission?.(this.missions);
        // Step cannon-es physics world
        this.physics.step(dt);
        // Sync car visual to its physics body every frame (so the car
        // doesn't drift away from its chassis while no-one is driving)
        this.vehicle?.syncVisuals?.();
        this.plane?.syncVisuals?.();
        this.heli?.syncVisuals?.();
        // WASTED / drown system
        if (!this.drivingVehicle) this.wasted.update(dt);

        // Auto-pickup items
        if (!dialogueOpen) {
            const picked = this.world.pickupNear(this.character.model.position);
            if (picked) this.hud.addItem(picked);
        }

        // Camera — freecam wins if active, otherwise follow rig
        if (this.freecam.active) {
            this.freecam.update(dt);
        } else {
            this.gameCamera.update(dt);
        }

        // Prompt priority: driving → NPC → vehicle
        if (dialogueOpen) return;
        if (this.drivingVehicle) {
            const k = this.drivingVehicle.kind;
            const label = k === 'plane' ? 'F : sortir de l\'avion'
                       : k === 'heli'  ? 'F : sortir de l\'hélicoptère'
                       :                 'F : sortir de la voiture';
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
            if (Math.hypot(dx, dz) < 5.0) {
                this.hud.setPrompt(
                    v.kind === 'plane' ? 'F : monter dans l\'avion'
                  : v.kind === 'heli'  ? 'F : monter dans l\'hélicoptère'
                  :                      'F : monter dans la voiture'
                );
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

    /** Stage 1 validation: drop 5 spheres from the sky to prove cannon-es
     *  works. Press P in-game to see their wireframes bouncing on the
     *  ground plane. Replaced by real colliders in later stages. */
    _buildPhysicsPlayground() {
        for (let i = 0; i < 5; i++) {
            const body = this.physics.addDynamicSphere(
                0.6, 1, { x: (i - 2) * 1.5, y: 8 + i * 0.4, z: 10 }
            );
            body.linearDamping = 0.1;
            body.angularDamping = 0.2;
        }
    }

    _tryInteract() {
        // Already talking? F is now "end conversation" — same key opens
        // and closes so the player doesn't have to remember two keys.
        if (this.dialogue.isOpen()) {
            this.dialogue.close();
            return;
        }
        const npc = this._closestNpc;
        if (!npc) return;
        this.dialogue.open(npc);
    }

    /**
     * ESC pause menu. Opens an overlay, releases pointer lock, and
     * halts input-driven updates. Resume button or another ESC closes it.
     * First-time wiring binds the three in-overlay buttons.
     */
    _togglePause() {
        if (!this._pauseWired) this._wirePauseMenu();
        const overlay = document.getElementById('pause-menu');
        if (!overlay) return;
        this.paused = !this.paused;
        if (this.paused) {
            overlay.classList.remove('hidden');
            if (document.pointerLockElement) document.exitPointerLock();
            this._syncMuteBtn?.();    // refresh the mute icon state
        } else {
            overlay.classList.add('hidden');
            // Pointer lock re-acquires on next canvas click automatically.
        }
    }

    _wirePauseMenu() {
        this._pauseWired = true;
        document.getElementById('btn-pause-resume')
            ?.addEventListener('click', () => this._togglePause());
        document.getElementById('btn-pause-exit')
            ?.addEventListener('click', () => {
                this.paused = false;
                document.getElementById('pause-menu')?.classList.add('hidden');
                this.exit();  // wrapped version returns to main menu
            });
        // Mute toggle — just flips the shared HTMLAudioElement `.muted`
        // flag, no state change in the app. Stays in-game.
        const muteBtn = document.getElementById('btn-pause-mute');
        muteBtn?.addEventListener('click', () => {
            const audio = window._musicAudio || null;
            if (!audio) {
                // No music playing yet — try to kick off the default track
                // (user gesture satisfies browser autoplay policy).
                window._armMusicAutoStart?.();
                return;
            }
            audio.muted = !audio.muted;
            muteBtn.textContent = audio.muted ? '🔇' : '🔊';
            muteBtn.classList.toggle('muted', audio.muted);
        });

        // Music switcher — prev / next triangles around a track name.
        const trackLabel = document.getElementById('pause-track-name');
        const applyTrack = (track) => {
            if (trackLabel) trackLabel.textContent = track ? track.name : '—';
        };
        document.getElementById('btn-pause-music-prev')
            ?.addEventListener('click', () => {
                const t = window._musicAPI?.switch(-1);
                applyTrack(t);
                // Re-sync mute button (muted state persists across switches)
                this._syncMuteBtn?.();
            });
        document.getElementById('btn-pause-music-next')
            ?.addEventListener('click', () => {
                const t = window._musicAPI?.switch(+1);
                applyTrack(t);
                this._syncMuteBtn?.();
            });

        // Sync icons + label with current audio state every time the menu opens
        this._syncMuteBtn = () => {
            const audio = window._musicAudio;
            if (audio && muteBtn) {
                muteBtn.textContent = audio.muted ? '🔇' : '🔊';
                muteBtn.classList.toggle('muted', audio.muted);
            }
            const track = window._musicAPI?.current();
            if (track) applyTrack(track);
        };
    }

    /** Called on F key. Enter/exit vehicle or talk to NPC. */
    _handleInteract() {
        // If a dialogue is open, F closes it regardless of vehicle state.
        if (this.dialogue.isOpen()) {
            this.dialogue.close();
            return;
        }
        // Driving → F tries mission pickup first, else exits the vehicle
        if (this.drivingVehicle) {
            if (this.drivingVehicle === this.vehicle
                && this.missions?.getState() === 'OFFERED'
                && this.missions.tryPickup(this.drivingVehicle.group.position)) {
                return;
            }
            this._exitVehicle();
            return;
        }
        // Pick the closest vehicle in range (car, plane, heli, or a traffic car — hijack!)
        const candidates = [this.vehicle, this.plane, this.heli].filter(Boolean);
        // Add every AI-driven traffic car — stealing one boots the AI gloop
        if (this.traffic?.drivers) {
            for (const d of this.traffic.drivers) {
                if (d.vehicle) candidates.push(d.vehicle);
            }
        }
        const playerPos = this.character.model.position;
        let closest = null;
        // Generous interaction radius — 5 m in XZ, any Y difference
        let best = 5.0;
        for (const v of candidates) {
            const dx = v.group.position.x - playerPos.x;
            const dz = v.group.position.z - playerPos.z;
            const d = Math.hypot(dx, dz);
            if (d < best) { best = d; closest = v; }
        }
        if (closest) {
            // If it's a traffic car, boot its AI driver before entering
            if (this.traffic?.drivers) {
                const hijacked = this.traffic.drivers.find((d) => d.vehicle === closest);
                if (hijacked && typeof hijacked.evict === 'function') {
                    hijacked.evict();
                }
            }
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
            const isFlyer = (target.kind === 'plane' || target.kind === 'heli');
            this.gameCamera.targetRadius = isFlyer ? 10 : 7.5;
            this.hud.setMode(isFlyer ? 'fly' : 'drive');
            // Freeze Move animations so the character holds the T-pose
            const moveCat = this.character.categories.get('Move');
            if (moveCat) {
                for (const item of moveCat.items.values()) {
                    item.action.setEffectiveWeight(0);
                }
                moveCat.active = null;
            }
            this.player._currentLocomotion = null;
            // Hide the Gloops — user sees only the vehicle while driving.
            if (this.character.model) this.character.model.visible = false;
        }
    }

    _exitVehicle() {
        if (!this.drivingVehicle) return;
        const exitInfo = this.drivingVehicle.exit();
        this.drivingVehicle = null;
        this.gameCamera.targetRadius = 5.0;
        this.player.velocity.set(0, 0, 0);
        this.hud.setMode('walk');
        // Reveal the Gloops again when we step out
        if (this.character.model) this.character.model.visible = true;

        // If we bailed out of a flying vehicle, start a skydive: no
        // ground clamping, gravity kicks in, and when we hit the water
        // the WASTED system takes over.
        if (exitInfo?.wasAirborne) {
            this.player._velY = 0;                // reset vertical vel
            this.player._grounded = false;
            // Play panic anim on the way down
            const moveCat = this.character.categories?.get('Move');
            if (moveCat) {
                const panicKey = [...moveCat.items.keys()].find(
                    (k) => k.toLowerCase().includes('panic')
                );
                if (panicKey) this.character.selectItem('Move', panicKey);
            }
            console.log(`[exit] bailed out at y=${exitInfo.exitY.toFixed(1)} — skydive!`);
        }
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
