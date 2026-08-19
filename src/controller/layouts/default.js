import { createJoystick } from '../joystick.js';

// No per-game legend to show here — this only mounts when a game's own
// controller-layout.js failed to load (see mountLayout in main.js).
export const controls = [];

let _joystick = null;
let _cleanup  = [];

export function mount(root, sendFn) {
  root.innerHTML = `
    <div class="gamepad-layout">
      <div class="gamepad-left"></div>
      <div class="gamepad-right">
        <div class="abxy-buttons">
          <button class="abxy-btn btn-y" data-action="y">Y</button>
          <button class="abxy-btn btn-x" data-action="x">X</button>
          <button class="abxy-btn btn-b" data-action="b">B</button>
          <button class="abxy-btn btn-a" data-action="a">A</button>
        </div>
      </div>
    </div>
  `;

  _joystick = createJoystick(
    root.querySelector('.gamepad-layout'),
    ({ dx, dy, direction }) => sendFn({ action: 'move', dx, dy, direction })
  );

  root.querySelectorAll('.abxy-btn').forEach(btn => {
    const action = btn.dataset.action;
    const down = e => { e.preventDefault(); btn.classList.add('pressed'); sendFn({ action }); };
    const up   = ()  => btn.classList.remove('pressed');
    btn.addEventListener('pointerdown',  down);
    btn.addEventListener('pointerup',    up);
    btn.addEventListener('pointercancel', up);
    _cleanup.push(() => {
      btn.removeEventListener('pointerdown',  down);
      btn.removeEventListener('pointerup',    up);
      btn.removeEventListener('pointercancel', up);
    });
  });
}

export function unmount() {
  _joystick?.destroy();
  _joystick = null;
  _cleanup.forEach(fn => fn());
  _cleanup = [];
}
