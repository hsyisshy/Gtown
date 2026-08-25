import { BGM_RELATIVE_GAIN } from './constants.js';

/**
 * Looping in-game BGM with seamless-feeling loops.
 *
 * Two fade layers, same recipe as the lobby BGM in screen/main.js:
 *  - base: eased in on start() and out on stop(), so the track never
 *    slams on/off around a match
 *  - seam envelope: the last few seconds of every pass fade out and the
 *    first few fade back in, so the loop restart is a gentle breathe
 *    instead of an audible cut
 *
 * Volume follows the screen settings panel: initial value comes from the
 * persisted 背景音樂 setting, and live slider moves arrive via the
 * 'bgm-volume-change' window event. `volume`/`base`/`target` all stay in
 * that raw 0-1 slider-fraction space; BGM_RELATIVE_GAIN is only applied at
 * the last step where it actually reaches `el.volume` (see its comment in
 * shared/constants.js for why BGM needs to sit below SFX at the same
 * slider position).
 */
export function createLoopingBgm(src, {
  seamFadeSec = 3,
  fadeInMs = 1500,
  fadeOutMs = 1200,
} = {}) {
  const el = new Audio(src);
  el.loop = true;
  el.volume = 0;
  el.preload = 'auto';

  let volume = _storedBgmVolume();
  let base = 0;
  let target = 0;
  let step = 0;
  let timer = null;

  const TICK_MS = 50;

  window.addEventListener('bgm-volume-change', e => {
    volume = e.detail;
    if (target > 0) fadeTo(volume, 200);
  });

  function tick() {
    if (base !== target) {
      base = step > 0 ? Math.min(target, base + step)
                      : Math.max(target, base + step);
      if (base === 0 && target === 0) {
        el.pause();
        clearInterval(timer);
        timer = null;
        return;
      }
    }
    let envelope = 1;
    const d = el.duration;
    if (Number.isFinite(d) && d > seamFadeSec * 2) {
      const t = el.currentTime;
      if (t < seamFadeSec) envelope = t / seamFadeSec;
      else if (t > d - seamFadeSec) envelope = Math.max(0, (d - t) / seamFadeSec);
    }
    el.volume = Math.max(0, Math.min(1, base * envelope * BGM_RELATIVE_GAIN));
  }

  function fadeTo(v, ms) {
    target = v;
    step = (v - base) / Math.max(1, ms / TICK_MS);
    if (!timer) timer = setInterval(tick, TICK_MS);
  }

  return {
    start() {
      volume = _storedBgmVolume();
      if (el.paused) {
        el.currentTime = 0;
        // Games start well after the page's first user gesture, so
        // autoplay rejection here is unexpected — just stay silent.
        el.play().catch(() => {});
      }
      fadeTo(volume, fadeInMs);
    },
    stop() {
      fadeTo(0, fadeOutMs);
    },
  };
}

function _storedBgmVolume() {
  const v = parseFloat(localStorage.getItem('setting_bgm_volume'));
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}
