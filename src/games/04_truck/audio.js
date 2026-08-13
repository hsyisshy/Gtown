import { createLoopingBgm } from '../../shared/loopingBgm.js';

export const bgm = createLoopingBgm('04_truck/audio/truck_bgm.mp3');

function sfxClip(file, volume) {
  const el = new Audio(`04_truck/audio/${file}`);
  el.preload = 'auto';
  el.volume = volume;
  return el;
}

const CLIPS = {
  crash: sfxClip('crash.mp3', 0.85),
};

function playClip(el) {
  el.currentTime = 0;
  el.play().catch(() => {});
}

export const SFX = {
  crash: () => playClip(CLIPS.crash),
};
