import { createJoystick } from '../../controller/joystick.js';

export const controls = [
  { icon: 'Ⓐ', label: '按住轉圈' },
  { icon: 'Ⓐ', label: '放開衝刺' },
];

let _joystick = null;
let _cleanup = [];

export function mount(root, sendFn) {
  root.innerHTML = `
    <div class="gamepad-layout">
      <div class="gamepad-left"></div>
      <div class="gamepad-right">
        <div class="abxy-buttons">
          <button class="abxy-btn btn-y inactive">Y</button>
          <button class="abxy-btn btn-x inactive">X</button>
          <button class="abxy-btn btn-b inactive">B</button>
          <button class="abxy-btn btn-a" data-action="accel">A</button>
        </div>
      </div>
    </div>
  `;

  // Truck is one-button (spin-dash) and never reads the stick, but the
  // gamepad still shows it — dimmed and non-interactive, like the unused
  // face buttons — so the layout matches every other game's controller.
  _joystick = createJoystick(
    root.querySelector('.gamepad-layout'),
    () => {},
    { disabled: ['up', 'down', 'left', 'right'] }
  );
  root.querySelector('.joy-zone')?.classList.add('inactive');

  // One-button spin-dash: the truck spins in place until A is held, then
  // dashes straight — so the button needs explicit press AND release events,
  // unlike volleyball's fire-once buttons.
  const btn = root.querySelector('[data-action="accel"]');
  const down = e => {
    e.preventDefault();
    btn.classList.add('pressed');
    sendFn({ action: 'accel', pressed: true });
  };
  const up = () => {
    btn.classList.remove('pressed');
    sendFn({ action: 'accel', pressed: false });
  };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  _cleanup.push(() => {
    btn.removeEventListener('pointerdown', down);
    btn.removeEventListener('pointerup', up);
    btn.removeEventListener('pointercancel', up);
  });
}

export function unmount() {
  _joystick?.destroy();
  _joystick = null;
  _cleanup.forEach(fn => fn());
  _cleanup = [];
}
