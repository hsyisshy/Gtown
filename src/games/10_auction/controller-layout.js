/**
 * 村莊拍賣 controller — no joystick/buttons, just a secret bid slider + lock
 * button. Each round's max bid and gift type land via a screen->controller
 * message (type 'auction_round', routed through controller/main.js's generic
 * onMessage->layout forwarding) since this game has no continuous per-frame
 * state to poll like the physics games do.
 */
const GIFT_INFO = {
  angel:  { icon: '👼', label: '天使禮物', note: '好禮物機率 70%・拿回 1.5 倍' },
  normal: { icon: '🎁', label: '普通禮物', note: '好壞機率各半・拿回 2 倍' },
  devil:  { icon: '😈', label: '惡魔禮物', note: '好禮物機率 25%・拿回 4 倍' },
};

export const controls = [
  { icon: '🎚️', label: '拖曳滑桿決定出價（隊友與對手都看不到）' },
  { icon: '🔒', label: '鎖定出價（鎖定前可以隨時調整）' },
];

let _sendFn = null;
let _locked = false;
let _countdownTimer = null;
let _els = null;

export function mount(root, sendFn) {
  _sendFn = sendFn;
  _locked = false;

  root.innerHTML = `
    <div class="auction-panel">
      <div class="auction-round" id="auction-round">第 1 / 5 輪</div>
      <div class="auction-gift">
        <span class="auction-gift-icon" id="auction-gift-icon">🎁</span>
        <div class="auction-gift-text">
          <div class="auction-gift-label" id="auction-gift-label">等待開拍…</div>
          <div class="auction-gift-note" id="auction-gift-note"></div>
        </div>
      </div>
      <div class="auction-timer" id="auction-timer">⏱ --</div>
      <div class="auction-bid-row">
        <span>你的出價</span>
        <span class="auction-bid-value" id="auction-bid-value">0</span>
      </div>
      <input type="range" class="auction-slider" id="auction-slider" min="0" max="0" value="0" disabled />
      <button class="primary-btn auction-lock-btn" id="auction-lock-btn" disabled>🔒 鎖定出價</button>
      <div class="hint auction-status" id="auction-status">等待本局開拍…</div>
    </div>
  `;

  _els = {
    round:  root.querySelector('#auction-round'),
    icon:   root.querySelector('#auction-gift-icon'),
    label:  root.querySelector('#auction-gift-label'),
    note:   root.querySelector('#auction-gift-note'),
    timer:  root.querySelector('#auction-timer'),
    value:  root.querySelector('#auction-bid-value'),
    slider: root.querySelector('#auction-slider'),
    lockBtn: root.querySelector('#auction-lock-btn'),
    status: root.querySelector('#auction-status'),
  };

  _els.slider.addEventListener('input', () => {
    _els.value.textContent = _els.slider.value;
    _sendFn({ action: 'bid', value: Number(_els.slider.value) });
  });

  _els.lockBtn.addEventListener('click', () => {
    if (_locked) return;
    _locked = true;
    _sendFn({ action: 'lock' });
    _els.slider.disabled = true;
    _els.lockBtn.disabled = true;
    _els.status.textContent = '✓ 已鎖定，等待其他人…';
  });
}

export function unmount() {
  clearInterval(_countdownTimer);
  _countdownTimer = null;
  _sendFn = null;
  _els = null;
}

// Called by controller/main.js for any screen->controller message it
// doesn't already handle itself, so the layout can opt into its own types.
export function onMessage(data) {
  if (data.type !== 'auction_round' || !_els) return;

  _locked = false;
  clearInterval(_countdownTimer);

  const gift = GIFT_INFO[data.giftType] ?? GIFT_INFO.normal;
  _els.round.textContent = `第 ${data.round} / 5 輪`;
  _els.icon.textContent = gift.icon;
  _els.label.textContent = gift.label;
  _els.note.textContent = gift.note;

  _els.slider.max = data.maxBid;
  _els.slider.value = 0;
  _els.slider.disabled = data.maxBid <= 0;
  _els.value.textContent = '0';
  _els.lockBtn.disabled = data.maxBid <= 0;
  _els.status.textContent = data.maxBid > 0 ? '拖曳滑桿決定出價，鎖定前可以隨時修改' : '你的隊伍沒有金幣可以出價了';

  let remaining = Math.ceil(data.timeLeft);
  _els.timer.textContent = `⏱ ${remaining}秒`;
  _countdownTimer = setInterval(() => {
    remaining -= 1;
    _els.timer.textContent = `⏱ ${Math.max(0, remaining)}秒`;
    if (remaining <= 0) clearInterval(_countdownTimer);
  }, 1000);
}
