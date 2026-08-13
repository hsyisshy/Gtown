import { createLoopingBgm } from '../../shared/loopingBgm.js';

export const bgm = createLoopingBgm('08_fall/audio/bgm.mp3');

function sfxClip(file, volume) {
  const el = new Audio(`08_fall/audio/${file}`);
  el.preload = 'auto';
  el.volume = volume;
  return el;
}

const CLIPS = {
  ding:  sfxClip('ding.mp3', 0.7),
  jump:  sfxClip('jump.mp3', 0.7),
  punch: sfxClip('punch.mp3', 0.7),
};

// Unlike the other games' single-instance clips, hits/jumps here can
// legitimately overlap (two players losing a life in the same frame) — clone
// the node per play so overlapping triggers don't cut each other off.
function playSfx(base) {
  const inst = base.cloneNode();
  inst.volume = base.volume;
  inst.play().catch(() => {});
}

export const SFX = {
  ding:  () => playSfx(CLIPS.ding),
  jump:  () => playSfx(CLIPS.jump),
  hurt:  () => playSfx(CLIPS.punch),
};
