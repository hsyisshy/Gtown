import { createLoopingBgm } from '../../shared/loopingBgm.js';

export const bgm = createLoopingBgm('07_painting-sticker/audio/bgm.mp3');

function sfxClip(file, volume) {
  const el = new Audio(`07_painting-sticker/audio/${file}`);
  el.preload = 'auto';
  el.volume = volume;
  return el;
}

const CLIPS = {
  grab: sfxClip('grab.mp3', 0.6),
};

// Both teams (and a shared item) can be grabbed in the same frame — clone
// per play so simultaneous triggers don't cut each other off.
function playSfx(base) {
  const inst = base.cloneNode();
  inst.volume = base.volume;
  inst.play().catch(() => {});
}

export const SFX = {
  grab: () => playSfx(CLIPS.grab),
};
