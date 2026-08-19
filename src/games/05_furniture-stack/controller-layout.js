import { createJoystick } from '../../controller/joystick.js';

export const controls = [
  { icon: '🕹️', label: '移動' },
  { icon: 'Ⓐ', label: '旋轉' },
  { icon: 'Ⓑ', label: '放下' },
  { icon: 'Ⓧ', label: '反轉' },
  { icon: 'Ⓨ', label: '換形狀' },
];

let _joystick = null;
let cleanup = [];

export function mount(root, sendFn) {
  root.innerHTML = `
    <div class="gamepad-layout">
      <div class="gamepad-left"></div>
      <div class="gamepad-right">
        <div class="abxy-buttons">
          <button class="abxy-btn btn-y" data-action="reroll">Y</button>
          <button class="abxy-btn btn-x" data-rotation="-1">X</button>
          <button class="abxy-btn btn-b" data-action="b">B</button>
          <button class="abxy-btn btn-a" data-rotation="1">A</button>
        </div>
      </div>
    </div>
  `;

  // 家具高塔只需要左右移動 — 上下軸鎖死
  _joystick = createJoystick(
    root.querySelector('.gamepad-layout'),
    ({ dx }) => sendFn({ action: 'move', dx: dx ?? 0 }),
    { disabled: ['up', 'down'] },
  );

  root.querySelectorAll('[data-rotation]').forEach((button) => {
    const direction = Number(button.dataset.rotation);
    const press = (event) => {
      event.preventDefault();
      button.classList.add('pressed');
      sendFn({ action: 'rotate', direction });
    };
    const release = () => {
      button.classList.remove('pressed');
      sendFn({ action: 'rotate', direction: 0 });
    };

    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('pointerleave', release);
    cleanup.push(() => {
      button.removeEventListener('pointerdown', press);
      button.removeEventListener('pointerup', release);
      button.removeEventListener('pointercancel', release);
      button.removeEventListener('pointerleave', release);
    });
  });

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
