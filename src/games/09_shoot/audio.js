import { createLoopingBgm } from '../../shared/loopingBgm.js';

export const bgm = createLoopingBgm('09_shoot/audio/bgm.mp3');

function sfxClip(file, volume) {
  const el = new Audio(`09_shoot/audio/${file}`);
  el.preload = 'auto';
  el.volume = volume;
  return el;
}

const CLIPS = {
  ding:  sfxClip('ding.mp3', 0.6),
  pop:   sfxClip('pop.mp3', 0.7),
  boom:  sfxClip('boom.mp3', 0.7),
  punch: sfxClip('punch.mp3', 0.65),
};

// Up to 4 players can pick up / explode / dash in the same frame — clone per
// play so overlapping triggers don't cut each other off.
function playSfx(base) {
  const inst = base.cloneNode();
  inst.volume = base.volume;
  inst.play().catch(() => {});
}

export const SFX = {
  ding:  () => playSfx(CLIPS.ding),
  pop:   () => playSfx(CLIPS.pop),
  boom:  () => playSfx(CLIPS.boom),
  punch: () => playSfx(CLIPS.punch),
};
