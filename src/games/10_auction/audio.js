import { createLoopingBgm } from '../../shared/loopingBgm.js';

export const bgm = createLoopingBgm('10_auction/audio/bgm.mp3');

function sfxClip(file, volume) {
  const el = new Audio(`10_auction/audio/${file}`);
  el.preload = 'auto';
  el.volume = volume;
  return el;
}

const CLIPS = {
  loading: sfxClip('loading.mp3', 0.75),
  good:    sfxClip('good.mp3', 0.85),
  bad:     sfxClip('bad.mp3', 0.85),
};

// Only one of these plays at a time (suspense sting vs. outcome jingle never
// overlap), so cutting the previous instance off on a new play — instead of
// cloning like shoot's SFX — matches the original prototype's activeSfx swap.
let active = null;
function playSfx(clip) {
  if (active) { active.pause(); active.currentTime = 0; }
  active = clip;
  clip.currentTime = 0;
  clip.play().catch(() => {});
}

export const SFX = {
  loading: () => playSfx(CLIPS.loading),
  good:    () => playSfx(CLIPS.good),
  bad:     () => playSfx(CLIPS.bad),
};
