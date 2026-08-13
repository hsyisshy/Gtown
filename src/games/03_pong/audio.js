import { createLoopingBgm } from '../../shared/loopingBgm.js';

export const bgm = createLoopingBgm('03_pong/audio/pong_bgm.mp3');

function sfxClip(file, volume) {
  const el = new Audio(`03_pong/audio/${file}`);
  el.preload = 'auto';
  el.volume = volume;
  return el;
}

const CLIPS = {
  hit:  sfxClip('hit.mp3', 0.8),
  ding: sfxClip('ding.mp3', 0.8),
};

function playClip(el) {
  el.currentTime = 0;
  el.play().catch(() => {});
}

export const SFX = {
  hit:  () => playClip(CLIPS.hit),
  ding: () => playClip(CLIPS.ding),
};
