/**
 * Floating (dynamic) joystick — MOBA-style: the stick is not fixed in place;
 * wherever the finger first lands inside the zone becomes the stick's center,
 * and dragging from that point steers. Release resets to a faint idle ghost
 * at the zone's resting spot.
 *
 * Same callback shape as the d-pad it replaces: onMove({ dx, dy, direction })
 * with dx/dy in [-1, 1] (analog, deadzone-filtered) and direction the
 * dominant cardinal ('up'|'down'|'left'|'right') or null at rest.
 *
 * opts.disabled: same contract as createDpad — pass ['left','right'] to lock
 * the x axis (pong) or ['up','down'] to lock y (volleyball).
 *
 * Emits are throttled to MSG_THROTTLE_MS (pointermove fires far faster than
 * AirConsole messages should), with press/release always sent immediately
 * and a trailing timer so the last drag value is never dropped.
 *
 * Uses offsetX/offsetY (coordinates in the zone's own space) instead of
 * clientX/Y so the portrait auto-rotate hack — which CSS-rotates the whole
 * body — doesn't swap the stick's axes.
 */
import { MSG_THROTTLE_MS } from '../shared/constants.js';

const DEADZONE = 0.15;

export function createJoystick(container, onMove, opts = {}) {
  const disabled = new Set(opts.disabled ?? []);
  const lockX = disabled.has('left') || disabled.has('right');
  const lockY = disabled.has('up') || disabled.has('down');

  const zone = document.createElement('div');
  zone.className = 'joy-zone';
  const base = document.createElement('div');
  base.className = 'joy-base idle';
  const knob = document.createElement('div');
  knob.className = 'joy-knob';
  base.appendChild(knob);
  zone.appendChild(base);
  container.appendChild(zone);

  let activeId = null;
  let center = null;
  let lastEmitAt = 0;
  let trailing = null;
  let pendingVal = null;

  function emit(val, force = false) {
    const now = performance.now();
    if (force || now - lastEmitAt >= MSG_THROTTLE_MS) {
      clearTimeout(trailing);
      trailing = null;
      lastEmitAt = now;
      onMove(val);
    } else {
      pendingVal = val;
      if (!trailing) {
        trailing = setTimeout(() => {
          trailing = null;
          lastEmitAt = performance.now();
          onMove(pendingVal);
        }, MSG_THROTTLE_MS - (now - lastEmitAt));
      }
    }
  }

  function setKnob(nx, ny) {
    const r = base.offsetWidth / 2;
    knob.style.transform = `translate(-50%, -50%) translate(${nx * r}px, ${ny * r}px)`;
  }

  const down = e => {
    if (activeId !== null) return;
    e.preventDefault();
    activeId = e.pointerId;
    zone.setPointerCapture(activeId);
    center = { x: e.offsetX, y: e.offsetY };
    base.classList.remove('idle');
    base.style.left = `${center.x}px`;
    base.style.top = `${center.y}px`;
    setKnob(0, 0);
    emit({ dx: 0, dy: 0, direction: null }, true);
  };

  const move = e => {
    if (e.pointerId !== activeId || !center) return;
    const r = base.offsetWidth / 2 || 1;
    let nx = lockX ? 0 : (e.offsetX - center.x) / r;
    let ny = lockY ? 0 : (e.offsetY - center.y) / r;
    const mag = Math.hypot(nx, ny);
    if (mag > 1) { nx /= mag; ny /= mag; }
    setKnob(nx, ny);

    // Deadzone, then rescale so output still spans the full 0..1 range
    const m = Math.hypot(nx, ny);
    let dx = 0, dy = 0, direction = null;
    if (m >= DEADZONE) {
      const scaled = (m - DEADZONE) / (1 - DEADZONE);
      dx = (nx / m) * scaled;
      dy = (ny / m) * scaled;
      direction = Math.abs(dx) >= Math.abs(dy)
        ? (dx > 0 ? 'right' : 'left')
        : (dy > 0 ? 'down' : 'up');
    }
    emit({ dx, dy, direction });
  };

  const up = e => {
    if (e.pointerId !== activeId) return;
    activeId = null;
    center = null;
    base.classList.add('idle');
    base.style.left = '';
    base.style.top = '';
    setKnob(0, 0);
    emit({ dx: 0, dy: 0, direction: null }, true);
  };

  zone.addEventListener('pointerdown', down);
  zone.addEventListener('pointermove', move);
  zone.addEventListener('pointerup', up);
  zone.addEventListener('pointercancel', up);

  return {
    destroy() {
      clearTimeout(trailing);
      zone.removeEventListener('pointerdown', down);
      zone.removeEventListener('pointermove', move);
      zone.removeEventListener('pointerup', up);
      zone.removeEventListener('pointercancel', up);
      zone.remove();
    },
  };
}
