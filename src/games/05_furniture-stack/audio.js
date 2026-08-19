import { createLoopingBgm } from '../../shared/loopingBgm.js';

export const bgm = createLoopingBgm('05_furniture-stack/audio/bgm.mp3');

function sfxClip(file, volume) {
  const el = new Audio(`05_furniture-stack/audio/${file}`);
  el.preload = 'auto';
  el.volume = volume;
  return el;
}

const CLIPS = {
  changeItem: sfxClip('changeitem.mp3', 0.7),
  crack: sfxClip('crack.mp3', 0.8),
};

function playClip(el) {
  el.currentTime = 0;
  el.play().catch(() => {});
}

export const SFX = {
  changeItem: () => playClip(CLIPS.changeItem),
  crack: () => playClip(CLIPS.crack),
};
