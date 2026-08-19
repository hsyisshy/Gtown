import { createJoystick } from '../../controller/joystick.js';

export const controls = [
  { icon: '🕹️', label: '移動塗色' },
  { icon: 'Ⓐ', label: '衝刺' },
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
          <button class="abxy-btn btn-a" data-action="dash">A</button>
        </div>
      </div>
    </div>
  `;

  // 自由 2D 移動噴漆 — 不鎖軸
  _joystick = createJoystick(
    root.querySelector('.gamepad-layout'),
    ({ dx, dy }) => sendFn({ action: 'move', dx: dx ?? 0, dy: dy ?? 0 }),
  );

  // 衝刺是「按住」語意:放開空白鍵前,只要冷卻好了就會一直自動衝,不是按一次衝一次。
  const btn = root.querySelector('[data-action="dash"]');
  const down = e => {
    e.preventDefault();
    btn.classList.add('pressed');
    sendFn({ action: 'dash', pressed: true });
  };
  const up = () => {
    btn.classList.remove('pressed');
    sendFn({ action: 'dash', pressed: false });
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
