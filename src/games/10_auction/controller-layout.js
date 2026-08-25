/**
 * 村莊拍賣 controller — same joystick + ABXY diamond shell every other game
 * uses (previously this had its own bespoke slider+button panel, which read
 * as an out-of-place screen next to every other game's controller). Stick
 * up/down raises/lowers this round's bid, A locks it in.
 *
 * Round/gift/timer/lock-status are all already public on the shared screen
 * (drawTopBar/drawBid/drawLockStatus in index.js) — the only thing that
 * genuinely can't go there is each player's OWN bid amount, so that's the
 * one piece of private HUD this layout shows, in the gamepad's otherwise-
 * empty middle zone.
 *
 * Bid value is accumulated LOCALLY on the phone (not round-tripped through
 * the screen) so the readout responds instantly to the stick, exactly like
 * the old slider's 'input' event did — only the resulting value is sent to
 * the screen, via the same { action: 'bid', value } / { action: 'lock' }
 * messages the original slider UI already used, so 10_auction/index.js's
 * onInput() needed no changes at all.
 */
import { createJoystick } from '../../controller/joystick.js';

const BID_ADJUST_RATE = 3; // 出價每秒最多變動幾枚(搖桿全推到底時)
const BID_TICK_MS = 100;

export const controls = [
  { icon: '🕹️', label: '推上／推下調整出價（隊友與對手都看不到，其他資訊看大螢幕）' },
  { icon: 'Ⓐ', label: '鎖定出價（鎖定前可以隨時調整）' },
];

let _joystick = null;
let _cleanup = [];
let _tickTimer = null;
let _els = null;
let _lockBtn = null;

let _currentDy = 0;
let _bidValue = 0;
let _maxBid = 0;
let _locked = false;
let _lastSentValue = -1;

export function mount(root, sendFn) {
  _currentDy = 0;
  _bidValue = 0;
  _maxBid = 0;
  _locked = false;
  _lastSentValue = -1;

  root.innerHTML = `
    <div class="gamepad-layout">
      <div class="gamepad-left"></div>
      <div class="auction-hud" id="auction-hud">
        <div class="auction-hud-label" id="auction-hud-label">等待開拍…</div>
        <div class="auction-hud-value" id="auction-hud-value">0</div>
        <div class="auction-hud-cap" id="auction-hud-cap"></div>
      </div>
      <div class="gamepad-right">
        <div class="abxy-buttons">
          <button class="abxy-btn btn-y inactive">Y</button>
          <button class="abxy-btn btn-x inactive">X</button>
          <button class="abxy-btn btn-b inactive">B</button>
          <button class="abxy-btn btn-a inactive" data-action="lock">A</button>
        </div>
      </div>
    </div>
  `;

  _els = {
    label: root.querySelector('#auction-hud-label'),
    value: root.querySelector('#auction-hud-value'),
    cap:   root.querySelector('#auction-hud-cap'),
  };

  // 只用上下軸 — 左右軸鎖死,推的幅度(不是位移距離)決定出價變動的速度。
  _joystick = createJoystick(
    root.querySelector('.gamepad-layout'),
    ({ dy }) => { _currentDy = dy ?? 0; },
    { disabled: ['left', 'right'] },
  );

  // 用固定頻率的計時器持續累加,而不是只在 pointermove 觸發時累加 ——
  // 手指推著搖桿不動時仍要持續加價,單純掛在 joystick 的 move callback 上
  // 的話,沒有新的 pointermove 事件就會卡住不動。
  _tickTimer = setInterval(() => {
    if (_locked || _currentDy === 0 || _maxBid <= 0) return;
    _bidValue = Math.max(0, Math.min(_maxBid, _bidValue - _currentDy * BID_ADJUST_RATE * (BID_TICK_MS / 1000)));
    const rounded = Math.round(_bidValue);
    _els.value.textContent = rounded;
    if (rounded !== _lastSentValue) {
      _lastSentValue = rounded;
      sendFn({ action: 'bid', value: rounded });
    }
  }, BID_TICK_MS);

  _lockBtn = root.querySelector('[data-action="lock"]');
  const pressLock = (e) => {
    e.preventDefault();
    if (_locked || _maxBid <= 0) return;
    _locked = true;
    _lockBtn.classList.add('pressed', 'inactive');
    sendFn({ action: 'lock' });
    _els.label.textContent = '✓ 已鎖定';
  };
  _lockBtn.addEventListener('pointerdown', pressLock);
  _cleanup.push(() => _lockBtn.removeEventListener('pointerdown', pressLock));
}

export function unmount() {
  clearInterval(_tickTimer);
  _tickTimer = null;
  _joystick?.destroy();
  _joystick = null;
  _cleanup.forEach(fn => fn());
  _cleanup = [];
  _els = null;
  _lockBtn = null;
}

// Called by controller/main.js for any screen->controller message it
// doesn't already handle itself, so the layout can opt into its own types.
// Round/gift/timer text intentionally isn't mirrored here — the shared
// screen already shows all of it publicly (see the module comment).
export function onMessage(data) {
  if (data.type !== 'auction_round' || !_els) return;

  _currentDy = 0;
  _bidValue = 0;
  _maxBid = data.maxBid;
  _locked = false;
  _lastSentValue = -1;

  _els.label.textContent = data.maxBid > 0 ? '你的出價' : '沒有金幣可出價';
  _els.value.textContent = '0';
  _els.cap.textContent = data.maxBid > 0 ? `上限 ${data.maxBid}` : '';

  _lockBtn?.classList.remove('pressed');
  _lockBtn?.classList.toggle('inactive', data.maxBid <= 0);
}
