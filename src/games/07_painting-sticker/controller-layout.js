import { createJoystick } from '../../controller/joystick.js';

export const controls = [
  { icon: '🕹️', label: '移動游標' },
  { icon: 'Ⓑ', label: '抓取／放置' },
  { icon: 'Ⓐ', label: '提前交卷（跳出確認視窗，確認後無法反悔，兩人都送出才會鎖定）' },
];

let _joystick = null;
let cleanup = [];
let _confirmed = false; // this device's own submission — one-way once true

export function mount(root, sendFn) {
  _confirmed = false;
  root.innerHTML = `
    <div class="gamepad-layout">
      <div class="gamepad-left"></div>
      <div class="gamepad-right">
        <div class="abxy-buttons">
          <button class="abxy-btn btn-y inactive">Y</button>
          <button class="abxy-btn btn-x inactive">X</button>
          <button class="abxy-btn btn-b" data-action="grab">B</button>
          <button class="abxy-btn btn-a" id="ps-finish-btn">A</button>
        </div>
      </div>
    </div>
    <div id="ps-finish-overlay" class="ps-finish-overlay hidden">
      <div class="ps-finish-card">
        <p class="ps-finish-title">確定要交卷嗎？</p>
        <p class="ps-finish-hint">確認後無法反悔，兩人都送出才會真的結束比賽</p>
        <div class="ps-finish-actions">
          <button type="button" class="ps-finish-btn ps-finish-cancel">再想一下</button>
          <button type="button" class="ps-finish-btn ps-finish-confirm">確定交卷</button>
        </div>
      </div>
    </div>
  `;

  // 自由 2D 移動游標 — 不鎖軸
  _joystick = createJoystick(
    root.querySelector('.gamepad-layout'),
    ({ dx, dy }) => sendFn({ action: 'move', dx, dy }),
  );

  // B keeps the plain press-and-send binding every other game uses.
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

  // A is irreversible once confirmed, so it gets its own "are you sure?"
  // popup instead of sending straight away — pressing A only opens the
  // popup; the actual 'finish' message only goes out from the popup's
  // confirm button, and only once, ever, for this device this match.
  const aBtn = root.querySelector('#ps-finish-btn');
  const overlay = root.querySelector('#ps-finish-overlay');
  const cancelBtn = root.querySelector('.ps-finish-cancel');
  const confirmBtn = root.querySelector('.ps-finish-confirm');

  const openConfirm = (event) => {
    event.preventDefault();
    if (_confirmed) return;
    // While this device is still reading the how-to-play book, A is owned
    // by the tutorial reader's own document-level click handler (A = 上一頁
    // there) — see body.tutorial-controlling in controller/main.js. Without
    // this guard, tapping A during the tutorial fired BOTH: the page-back
    // and this popup, since #ps-finish-btn IS the same .abxy-btn.btn-a
    // element the tutorial reader listens for clicks on.
    if (document.body.classList.contains('tutorial-controlling')) return;
    aBtn.classList.add('pressed');
    overlay.classList.remove('hidden');
  };
  const releaseA = () => aBtn.classList.remove('pressed');
  const closeOverlay = (event) => {
    event.preventDefault();
    overlay.classList.add('hidden');
  };
  const doConfirm = (event) => {
    event.preventDefault();
    if (_confirmed) return;
    _confirmed = true;
    overlay.classList.add('hidden');
    sendFn({ action: 'finish' });
    aBtn.classList.add('inactive');
    aBtn.textContent = '✓';
  };

  aBtn.addEventListener('pointerdown', openConfirm);
  aBtn.addEventListener('pointerup', releaseA);
  aBtn.addEventListener('pointercancel', releaseA);
  cancelBtn.addEventListener('pointerdown', closeOverlay);
  confirmBtn.addEventListener('pointerdown', doConfirm);

  cleanup.push(() => {
    aBtn.removeEventListener('pointerdown', openConfirm);
    aBtn.removeEventListener('pointerup', releaseA);
    aBtn.removeEventListener('pointercancel', releaseA);
    cancelBtn.removeEventListener('pointerdown', closeOverlay);
    confirmBtn.removeEventListener('pointerdown', doConfirm);
  });
}

export function unmount() {
  _joystick?.destroy();
  _joystick = null;
  cleanup.forEach(fn => fn());
  cleanup = [];
  _confirmed = false;
}
