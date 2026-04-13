/**
 * Audio manager: plays emotion sounds when animations are selected.
 * Maps emotion filenames to sound files.
 */

export class AudioManager {
    constructor() {
        this.audio = new Audio();
        this.audio.loop = true;
        this.volume = 0.5;
        this.audio.volume = this.volume;
        this.muted = false;
        this.currentSound = null;

        // Map emotion FBX filenames to sound files
        this.soundMap = {
            '01_peace.fbx':         'sound/mp3/01_peace.mp3',
            '02_waouh.fbx':         'sound/mp3/02_wow.mp3',
            '03_happy.fbx':         'sound/mp3/03_happy.mp3',
            '04_inlove.fbx':        'sound/mp3/04_inlove.mp3',
            '05_playful.fbx':       'sound/mp3/05_playful.mp3',
            '06_satisfied.fbx':     'sound/mp3/06_satisfied.mp3',
            '07_thug.fbx':          'sound/mp3/07_thug.mp3',
            '08_worried.fbx':       'sound/mp3/08_worried.mp3',
            '09_frustrated.fbx':    'sound/mp3/09_frustrated.mp3',
            '10_disappointed.fbx':  'sound/mp3/10_disappointed.mp3',
            '11_angry.fbx':         'sound/mp3/11_angry.mp3',
            '11_angry_V2.fbx':      'sound/mp3/11_angry.mp3',
            '12_despising.fbx':     'sound/mp3/12_despising.mp3',
            '13_sad.fbx':           'sound/mp3/13_sad.mp3',
            '14_afraid.fbx':        'sound/mp3/14_scared.mp3',
            '15_crying.fbx':        'sound/mp3/15_crying.mp3',
            '16_annihilated.fbx':   'sound/mp3/16_annihilated.mp3',
            '16_annihilated_V2.fbx':'sound/mp3/16_annihilated.mp3',
        };
    }

    /**
     * Play the sound for an emotion filename.
     */
    play(emotionFilename) {
        const soundPath = this.soundMap[emotionFilename];
        if (!soundPath) {
            this.stop();
            return;
        }

        if (this.currentSound === soundPath) return; // already playing
        this.currentSound = soundPath;

        this.audio.src = soundPath;
        this.audio.volume = this.muted ? 0 : this.volume;
        this.audio.play().catch(() => {}); // ignore autoplay block
    }

    stop() {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.currentSound = null;
    }

    setVolume(v) {
        this.volume = v;
        if (!this.muted) this.audio.volume = v;
    }

    setMuted(m) {
        this.muted = m;
        this.audio.volume = m ? 0 : this.volume;
    }
}

/**
 * Build a mini audio player UI.
 */
export function buildAudioPlayer(audioManager) {
    const player = document.createElement('div');
    player.id = 'audio-player';

    // Mute button
    const muteBtn = document.createElement('button');
    muteBtn.id = 'audio-mute';
    muteBtn.textContent = '🔊';
    muteBtn.addEventListener('click', () => {
        audioManager.setMuted(!audioManager.muted);
        muteBtn.textContent = audioManager.muted ? '🔇' : '🔊';
    });

    // Volume slider
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = 0;
    vol.max = 1;
    vol.step = 0.05;
    vol.value = audioManager.volume;
    vol.id = 'audio-volume';
    vol.addEventListener('input', () => {
        audioManager.setVolume(parseFloat(vol.value));
    });

    player.appendChild(muteBtn);
    player.appendChild(vol);

    return player;
}
