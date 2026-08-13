import { createLoopingBgm } from '../../shared/loopingBgm.js';

export const bgm = createLoopingBgm('06_climb/audio/bgm.mp3');

function sfxClip(file, volume) {
  const el = new Audio(`06_climb/audio/${file}`);
  el.preload = 'auto';
  el.volume = volume;
  return el;
}

const CLIPS = {
  jump: sfxClip('jump.mp3', 0.6),
  push: sfxClip('push.mp3', 0.6),
};

// Up to 6 climbers can jump/push in overlapping frames — clone per play so
// simultaneous triggers don't cut each other off.
function playSfx(base) {
  const inst = base.cloneNode();
  inst.volume = base.volume;
  inst.play().catch(() => {});
}

export const SFX = {
  jump: () => playSfx(CLIPS.jump),
  push: () => playSfx(CLIPS.push),
};
