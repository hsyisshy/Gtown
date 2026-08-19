import { createJoystick } from '../../controller/joystick.js';

export const controls = [
  { icon: '🕹️', label: '移動游標' },
  { icon: 'Ⓑ', label: '抓取／放置' },
  { icon: 'Ⓐ', label: '提前完成' },
];

let _joystick = null;
let cleanup = [];

export function mount(root, sendFn) {
  root.innerHTML = `
    <div class="gamepad-layout">
      <div class="gamepad-left"></div>
      <div class="gamepad-right">
        <div class="abxy-buttons">
          <button class="abxy-btn btn-y inactive">Y</button>
          <button class="abxy-btn btn-x inactive">X</button>
          <button class="abxy-btn btn-b" data-action="grab">B</button>
          <button class="abxy-btn btn-a" data-action="finish">A</button>
        </div>
      </div>
    </div>
  `;

  // 自由 2D 移動游標 — 不鎖軸
  _joystick = createJoystick(
    root.querySelector('.gamepad-layout'),
    ({ dx, dy }) => sendFn({ action: 'move', dx, dy }),
  );

  root.querySelectorAll('[data-action]').forEach((button) => {
    const action = button.dataset.action;
    const press = (event) => {
      event.preventDefault();
      button.classList.add('pressed');
      sendFn({ action });
    };
    const release = () => button.classList.remove('pressed');

    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    cleanup.push(() => {
      button.removeEventListener('pointerdown', press);
      button.removeEventListener('pointerup', release);
      button.removeEventListener('pointercancel', release);
    });
  });
}

export function unmount() {
  _joystick?.destroy();
  _joystick = null;
  cleanup.forEach(fn => fn());
  cleanup = [];
}
