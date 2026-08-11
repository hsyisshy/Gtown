import { createDpad } from '../../controller/dpad.js';

let dpad = null;
let cleanup = [];

export function mount(root, sendFn) {
  root.innerHTML = `
    <div class="gamepad-layout">
      <div class="gamepad-left">
        <div id="dpad-container"></div>
      </div>
      <div class="gamepad-right">
        <div class="abxy-buttons">
          <button class="abxy-btn btn-y inactive">Y</button>
          <button class="abxy-btn btn-x inactive">X</button>
          <button class="abxy-btn btn-b" data-action="push">推人</button>
          <button class="abxy-btn btn-a" data-action="jump">跳躍</button>
        </div>
      </div>
    </div>
  `;

  // 爬高派對只需要左右移動 — 上下鍵停用(跳躍/推人走 A/B 鍵)
  dpad = createDpad(
    root.querySelector('#dpad-container'),
    ({ dx }) => sendFn({ action: 'move', dx: dx ?? 0 }),
    { disabled: ['up', 'down'] },
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
  dpad?.destroy();
  dpad = null;
  cleanup.forEach(fn => fn());
  cleanup = [];
}
