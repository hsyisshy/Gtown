/**
 * Directional pad (up/down/left/right buttons).
 * Renders inside `container`, calls `onMove({ dx, dy, direction })` on change.
 * dx/dy are one of -1, 0, 1. direction is 'up'|'down'|'left'|'right'|null.
 * Drop-in replacement for the analog joystick — same callback shape.
 *
 * opts.disabled: direction keys to render dimmed + non-interactive, for
 * games that only move along one axis (e.g. volleyball ignores up/down,
 * pong ignores left/right) — same treatment as the ABXY layouts already
 * give their unused face buttons (`.inactive`).
 */
const DIRS = [
  { key: 'up',    dx: 0,  dy: -1 },
  { key: 'down',  dx: 0,  dy: 1  },
  { key: 'left',  dx: -1, dy: 0  },
  { key: 'right', dx: 1,  dy: 0  },
];

export function createDpad(container, onMove, opts = {}) {
  const disabled = new Set(opts.disabled ?? []);
  const pressed = new Set();
  const cleanup = [];

  const grid = document.createElement('div');
  grid.className = 'dpad-buttons';

  function emit() {
    let dx = (pressed.has('right') ? 1 : 0) - (pressed.has('left') ? 1 : 0);
    let dy = (pressed.has('down')  ? 1 : 0) - (pressed.has('up')   ? 1 : 0);
    if (dx !== 0 && dy !== 0) {
      // Normalize diagonals so they aren't faster than a single cardinal
      // direction — matches the joystick's unit-circle magnitude cap.
      dx /= Math.SQRT2;
      dy /= Math.SQRT2;
    }
    const direction = pressed.size ? [...pressed][pressed.size - 1] : null;
    onMove({ dx, dy, direction });
  }

  DIRS.forEach(({ key }) => {
    const isDisabled = disabled.has(key);
    const btn = document.createElement('button');
    btn.className = `dpad-btn dpad-${key}${isDisabled ? ' inactive' : ''}`;
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" class="dpad-chevron"><path d="M7 15 L12 9 L17 15" /></svg>';

    if (!isDisabled) {
      const down = e => {
        e.preventDefault();
        pressed.add(key);
        btn.classList.add('pressed');
        emit();
      };
      const up = () => {
        pressed.delete(key);
        btn.classList.remove('pressed');
        emit();
      };

      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      cleanup.push(() => {
        btn.removeEventListener('pointerdown', down);
        btn.removeEventListener('pointerup', up);
        btn.removeEventListener('pointercancel', up);
      });
    }

    grid.appendChild(btn);
  });

  container.appendChild(grid);

  return {
    destroy() {
      cleanup.forEach(fn => fn());
      grid.remove();
    },
  };
}
