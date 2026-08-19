import { createJoystick } from '../../controller/joystick.js';

export const controls = [
  { icon: '🕹️', label: '移動' },
];

let _joystick = null;

export function mount(root, sendFn) {
  root.innerHTML = `
    <div class="gamepad-layout">
      <div class="gamepad-left"></div>
      <div class="gamepad-right">
        <div class="abxy-buttons">
          <button class="abxy-btn btn-y inactive">Y</button>
          <button class="abxy-btn btn-x inactive">X</button>
          <button class="abxy-btn btn-b inactive">B</button>
          <button class="abxy-btn btn-a inactive">A</button>
        </div>
      </div>
    </div>
  `;

  _joystick = createJoystick(
    root.querySelector('.gamepad-layout'),
    ({ dx, dy, direction }) => sendFn({ action: 'move', dx, dy, direction })
  );
}

export function unmount() {
  _joystick?.destroy();
  _joystick = null;
}
