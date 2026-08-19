import { createJoystick } from '../../controller/joystick.js';

export const controls = [
  { icon: '🕹️', label: '移動' },
  { icon: 'Ⓐ', label: '跳躍' },
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
          <button class="abxy-btn btn-b inactive">B</button>
          <button class="abxy-btn btn-a" data-action="jump">A</button>
        </div>
      </div>
    </div>
  `;

  // 危台求生只需要左右移動 — 上下軸鎖死(跳躍走 A 鍵,沒有推人鍵)
  _joystick = createJoystick(
    root.querySelector('.gamepad-layout'),
    ({ dx }) => sendFn({ action: 'move', dx: dx ?? 0 }),
    { disabled: ['up', 'down'] },
  );

  // 原型是按住鍵盤空白鍵的「held」語意:只要落地時仍按著跳躍鍵就會自動再跳一次
  // (連續彈跳逃命),不是按一次跳一次,所以要送 press/release 兩種事件,不能只
  // fire-once。
  const jumpBtn = root.querySelector('[data-action="jump"]');
  const down = (event) => {
    event.preventDefault();
    jumpBtn.classList.add('pressed');
    sendFn({ action: 'jump', pressed: true });
  };
  const up = () => {
    jumpBtn.classList.remove('pressed');
    sendFn({ action: 'jump', pressed: false });
  };

  jumpBtn.addEventListener('pointerdown', down);
  jumpBtn.addEventListener('pointerup', up);
  jumpBtn.addEventListener('pointercancel', up);
  cleanup.push(() => {
    jumpBtn.removeEventListener('pointerdown', down);
    jumpBtn.removeEventListener('pointerup', up);
    jumpBtn.removeEventListener('pointercancel', up);
  });
}

export function unmount() {
  _joystick?.destroy();
  _joystick = null;
  cleanup.forEach(fn => fn());
  cleanup = [];
}
