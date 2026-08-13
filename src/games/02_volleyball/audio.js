import { createLoopingBgm } from '../../shared/loopingBgm.js';

export const bgm = createLoopingBgm('02_volleyball/audio/bgm.mp3');

function sfxClip(file, volume) {
  const el = new Audio(`02_volleyball/audio/${file}`);
  el.preload = 'auto';
  el.volume = volume;
  return el;
}

const CLIPS = {
  jump:    sfxClip('jump.mp3', 0.7),
  slap:    sfxClip('slap.mp3', 0.9),
  whistle: sfxClip('whistle.mp3', 0.8),
};

function playClip(el) {
  el.currentTime = 0;
  el.play().catch(() => {});
}

export const SFX = {
  jump:    () => playClip(CLIPS.jump),
  slap:    () => playClip(CLIPS.slap),
  whistle: () => playClip(CLIPS.whistle),
};
