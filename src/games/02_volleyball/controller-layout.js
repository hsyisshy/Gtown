import { createJoystick } from '../../controller/joystick.js';

let _joystick = null;
let _cleanup  = [];

export function mount(root, sendFn) {
  root.innerHTML = `
    <div class="gamepad-layout">
      <div class="gamepad-left"></div>
      <div class="gamepad-right">
        <div class="abxy-buttons">
          <button class="abxy-btn btn-y inactive">Y</button>
          <button class="abxy-btn btn-x inactive">X</button>
          <button class="abxy-btn btn-b" data-action="b">B</button>
          <button class="abxy-btn btn-a" data-action="a">A</button>
        </div>
      </div>
    </div>
  `;

  // Volleyball only moves left/right — lock the stick's vertical axis.
  _joystick = createJoystick(
    root.querySelector('.gamepad-layout'),
    ({ dx, dy, direction }) => sendFn({ action: 'move', dx, dy, direction }),
    { disabled: ['up', 'down'] }
  );

  root.querySelectorAll('.abxy-btn:not(.inactive)').forEach(btn => {
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
