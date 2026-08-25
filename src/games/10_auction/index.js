/**
 * 村莊拍賣 — 2v2 secret-bid auction ported from auction/index.html.
 *
 * Not a real-time physics game like the others: it's a slow round-based
 * bidding game, so there's no joystick/buttons on the phone at all — just a
 * bid slider + lock button (see controller-layout.js). The prototype was a
 * single-device demo (1 real "you" + 3 scripted bots sharing one screen with
 * a DOM slider); here all 4 seats are real players on their own phones, so
 * the bot bidding logic is dropped entirely and each phone gets its own
 * private slider — bid amounts must stay hidden from the shared TV screen
 * while a round is live, or the opposing team could just read them off it.
 *
 * Each round: red's two members' bids sum to a team bid, same for blue;
 * highest team total wins the lot and pays it immediately; a coin flip
 * weighted by the gift's type then decides good (reward back, multiplied)
 * or bad (bid is gone). 5 rounds, most money at the end wins.
 *
 * Screen and controller only share round metadata (gift type, this round's
 * max bid) via one-shot messages pushed through globalState._pendingMessages
 * when a round starts — not a continuous stream, since nothing about a bid
 * round needs sub-second sync beyond the timer countdown, which each side
 * just runs independently.
 */
import { truncateName } from '../../shared/nameDisplay.js';
import { preloadImages, drawAssetLoadingPlaceholder } from '../../shared/assetPreload.js';
import { bgm, SFX } from './audio.js';

const W = 720, H = 450;

const ROUND_COUNT = 5;
const STARTING_MONEY = 20;
const BID_TIME = 15;
const SHORTEN_TIME = 5;     // once a whole team has locked in, the round hurries to this
const PREVIEW_TIME = 3;
const WINNER_PAUSE = 2.4;
const UNSOLD_PAUSE = 2.2;
const SUSPENSE_TIME = 5;
const RESULT_PAUSE = 3.2;

const CHANCE = { angel: 0.7, normal: 0.5, devil: 0.25 };
const PAYOUT = { angel: 1.5, normal: 2, devil: 4 };

const GIFT_INFO = {
  angel:  { label: '天使禮物', note: '好禮物機率 70%・拿回 1.5 倍' },
  normal: { label: '普通禮物', note: '好壞機率各半・拿回 2 倍' },
  devil:  { label: '惡魔禮物', note: '好禮物機率 25%・拿回 4 倍' },
};

const TEAM_UI = {
  red:  { label: '紅隊', text: '#ff8080', fill: '#e94057' },
  blue: { label: '藍隊', text: '#80c0ff', fill: '#3fa9f5' },
};

const SLOT_DEFS = [
  { team: 'red' }, { team: 'red' }, { team: 'blue' }, { team: 'blue' },
];

function loadImage(path) {
  const img = new Image();
  img.src = path;
  return img;
}

const bgImg = loadImage('10_auction/background.png');
const GIFT_IMG = {
  angel:  loadImage('10_auction/gifts/angel.png'),
  devil:  loadImage('10_auction/gifts/devil.png'),
  normal: loadImage('10_auction/gifts/normal.png'),
  good:   loadImage('10_auction/gifts/good.png'),
  bad:    loadImage('10_auction/gifts/bad.png'),
};
const GIFT_FRAMES = {
  angel: Array.from({ length: 8 }, (_, i) => loadImage(`10_auction/gifts/angel-${i}.png`)),
  devil: Array.from({ length: 8 }, (_, i) => loadImage(`10_auction/gifts/devil-${i}.png`)),
};
const AUCTION_IMAGES = [bgImg, ...Object.values(GIFT_IMG), ...GIFT_FRAMES.angel, ...GIFT_FRAMES.devil];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 5 gifts per game, drawn from 3 angel / 3 devil / 4 normal, re-rolled until
// at least 3 distinct types show up so a game is never all-normal.
function newTags() {
  const pool = ['angel', 'angel', 'angel', 'devil', 'devil', 'devil', 'normal', 'normal', 'normal', 'normal'];
  let picked;
  do { picked = shuffle([...pool]).slice(0, ROUND_COUNT); }
  while (new Set(picked).size < 3);
  return picked;
}

let ag = null; // module-level auction-game state

function pushMessage(globalState, deviceId, payload) {
  if (!deviceId) return;
  if (!globalState._pendingMessages) globalState._pendingMessages = [];
  globalState._pendingMessages.push({ deviceId: String(deviceId), ...payload });
}

function teamIndexOf(team) { return team === 'red' ? 0 : 1; }

function maxBidFor(team) {
  return Math.floor(ag.teamMoney[teamIndexOf(team)] / 2);
}

function startBidRound(globalState) {
  ag.phase = 'bid';
  ag.bidTimeLeft = BID_TIME;
  ag.bids = [0, 0, 0, 0];
  ag.locked = [false, false, false, false];

  const giftType = ag.tags[ag.roundIndex];
  for (const p of ag.players) {
    pushMessage(globalState, p.deviceId, {
      type: 'auction_round',
      round: ag.roundIndex + 1,
      giftType,
      maxBid: maxBidFor(p.team),
      timeLeft: BID_TIME,
    });
  }
}

function resolveRound() {
  const teamBids = [ag.bids[0] + ag.bids[1], ag.bids[2] + ag.bids[3]];
  const max = Math.max(...teamBids);

  if (max === 0) {
    ag.result = { unsold: true };
    ag.phase = 'unsold';
    ag.phaseTimer = UNSOLD_PAUSE;
    return;
  }

  const pool = [0, 1].filter(i => teamBids[i] === max);
  const winnerTeamIdx = pool[Math.floor(Math.random() * pool.length)];
  ag.teamMoney[winnerTeamIdx] -= teamBids[winnerTeamIdx];
  ag.result = {
    unsold: false,
    winnerTeamIdx,
    winnerTeam: winnerTeamIdx === 0 ? 'red' : 'blue',
    price: teamBids[winnerTeamIdx],
    teamBids,
    bids: [...ag.bids],
  };
  ag.phase = 'winner';
  ag.phaseTimer = WINNER_PAUSE;
}

function revealResult() {
  const giftType = ag.tags[ag.roundIndex];
  const good = Math.random() < CHANCE[giftType];
  const r = ag.result;
  r.type = good ? 'good' : 'bad';
  r.reward = good ? Math.round(r.price * PAYOUT[giftType]) : 0;
  r.net = good ? r.reward - r.price : -r.price;
  ag.teamMoney[r.winnerTeamIdx] += r.reward;
  ag.phase = 'result';
  ag.phaseTimer = RESULT_PAUSE;
  SFX[good ? 'good' : 'bad']();
}

function advanceRound(globalState) {
  ag.roundIndex++;
  ag.result = null;
  if (ag.roundIndex >= ROUND_COUNT) { finish(globalState); return; }
  startBidRound(globalState);
}

function finish(globalState) {
  if (ag.done) return;
  ag.done = true;
  ag.phase = 'end';

  for (const p of ag.players) {
    if (!p.deviceId || !globalState.players?.[p.deviceId]) continue;
    globalState.players[p.deviceId].score =
      (globalState.players[p.deviceId].score || 0) + ag.teamMoney[teamIndexOf(p.team)];
  }

  const winnerTeam = ag.teamMoney[0] === ag.teamMoney[1]
    ? null
    : (ag.teamMoney[0] > ag.teamMoney[1] ? 'red' : 'blue');
  ag._endCb?.(winnerTeam, { label: '金幣', red: `🪙${ag.teamMoney[0]}`, blue: `🪙${ag.teamMoney[1]}` });
}

// --- 繪製 -------------------------------------------------------------------

function drawGiftIcon(ctx, type, cx, cy, size, animFrame) {
  const frames = GIFT_FRAMES[type];
  const img = frames ? frames[animFrame % frames.length] : GIFT_IMG[type];
  if (!img?.complete || !img.naturalWidth) return;
  const t = Date.now() / 1000;
  ctx.save();
  ctx.translate(cx, cy);
  if (type === 'normal') {
    // Box stays put; only the bow at the top wiggles — same trick as the
    // original's bow-layer clip-path overlay (clip to the top slice, rotate
    // around a pivot near the top instead of the image center).
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
    const pivotY = -size / 2 + size * 0.26;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-size / 2, -size / 2, size, size * 0.43);
    ctx.clip();
    ctx.translate(0, pivotY);
    ctx.rotate(Math.sin(t * 2.856) * 0.031); // ~1.8deg, 2.2s period
    ctx.drawImage(img, -size / 2, -size / 2 - pivotY, size, size);
    ctx.restore();
  } else if (frames) {
    // angel/devil: the whole box gently bobs (original's .float class)
    // while its 8-frame wing-flap animation plays.
    ctx.translate(0, -1 + Math.sin(t * 1.963) * 4); // 3.2s period
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
  } else {
    // good/bad: a quick rotational flinch once every ~2.5s (original's
    // .wobble class), not a continuous drift.
    const phase = (t % 2.5) / 2.5;
    let deg = 0;
    if (phase >= 0.85 && phase < 0.90) deg = -2 * ((phase - 0.85) / 0.05);
    else if (phase >= 0.90 && phase < 0.95) deg = -2 + 4 * ((phase - 0.90) / 0.05);
    else if (phase >= 0.95) deg = 2 - 2 * ((phase - 0.95) / 0.05);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
  }
  ctx.restore();
}

function makeDustMotes() {
  return Array.from({ length: 12 }, (_, i) => ({
    x: 0.12 + ((i * 17) % 76) / 100,
    y: 0.22 + ((i * 23) % 58) / 100,
    delay: i * 0.21,
  }));
}

function drawTopBar(ctx) {
  ctx.save();
  ctx.fillStyle = 'rgba(40, 20, 8, 0.55)';
  ctx.fillRect(0, 0, W, 40);

  ctx.font = "bold 13px 'Noto Sans TC', sans-serif";
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = TEAM_UI.red.text;
  ctx.fillText(`🔴 ${TEAM_UI.red.label}　🪙 ${ag.teamMoney[0]}`, 14, 20);

  ctx.textAlign = 'right';
  ctx.fillStyle = TEAM_UI.blue.text;
  ctx.fillText(`🪙 ${ag.teamMoney[1]}　🔵 ${TEAM_UI.blue.label}`, W - 14, 20);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff4d4';
  ctx.font = "bold 14px 'Noto Sans TC', sans-serif";
  ctx.fillText(`第 ${Math.min(ag.roundIndex + 1, ROUND_COUNT)} / ${ROUND_COUNT} 輪`, W / 2, 20);
  ctx.restore();
}

function drawLockStatus(ctx, cy) {
  const boxW = 150, boxH = 28, gap = 12;
  const totalW = boxW * 4 + gap * 3;
  let x = (W - totalW) / 2;
  ag.players.forEach((p, i) => {
    const locked = ag.locked[i];
    ctx.fillStyle = locked ? 'rgba(78, 155, 85, 0.85)' : 'rgba(255,255,255,0.12)';
    ctx.strokeStyle = TEAM_UI[p.team].fill;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, cy, boxW, boxH, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = "bold 12px 'Noto Sans TC', sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${p.name}${locked ? ' ✓已鎖定' : ' 思考中…'}`, x + boxW / 2, cy + boxH / 2);
    x += boxW + gap;
  });
}

function drawPreview(ctx) {
  ctx.fillStyle = '#fff4d4';
  ctx.font = "bold 26px 'Noto Sans TC', sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('本局的五份神秘禮物', W / 2, H / 2 - 70);
  ctx.font = "13px 'Noto Sans TC', sans-serif";
  ctx.fillStyle = '#e9d6b0';
  ctx.fillText('同隊出價相加，最高者得標！好禮物加倍拿回，壞禮物出價不退', W / 2, H / 2 - 40);

  const size = 70, gap = 20;
  const totalW = size * ROUND_COUNT + gap * (ROUND_COUNT - 1);
  let x = (W - totalW) / 2 + size / 2;
  ag.tags.forEach(type => {
    drawGiftIcon(ctx, type, x, H / 2 + 30, size, ag.animFrame);
    x += size + gap;
  });
}

function drawBid(ctx) {
  const type = ag.tags[ag.roundIndex];
  const info = GIFT_INFO[type];
  drawGiftIcon(ctx, type, W / 2, H / 2 - 30, 130, ag.animFrame);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff4d4';
  ctx.font = "bold 20px 'Noto Sans TC', sans-serif";
  ctx.fillText(info.label, W / 2, H / 2 + 65);
  ctx.font = "12px 'Noto Sans TC', sans-serif";
  ctx.fillStyle = '#e9d6b0';
  ctx.fillText(info.note, W / 2, H / 2 + 85);

  const urgent = ag.bidTimeLeft <= 5;
  ctx.font = `bold ${urgent ? 30 : 26}px sans-serif`;
  ctx.fillStyle = urgent ? '#ff6b5e' : '#ffd700';
  ctx.fillText(`⏱ ${Math.ceil(ag.bidTimeLeft)}秒`, W / 2, 65);

  ctx.font = "11px 'Noto Sans TC', sans-serif";
  ctx.fillStyle = '#a08860';
  ctx.fillText('隊友與對手的出價都是隱藏的，鎖定後才會公開', W / 2, H - 20);

  drawLockStatus(ctx, H - 55);
}

function drawUnsold(ctx) {
  drawGiftIcon(ctx, ag.tags[ag.roundIndex], W / 2, H / 2 - 30, 120, ag.animFrame);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff4d4';
  ctx.font = "bold 24px 'Noto Sans TC', sans-serif";
  ctx.fillText('本輪流標', W / 2, H / 2 + 60);
  ctx.font = "13px 'Noto Sans TC', sans-serif";
  ctx.fillStyle = '#e9d6b0';
  ctx.fillText('紅隊與藍隊都沒有出價', W / 2, H / 2 + 85);
}

function drawWinner(ctx) {
  const r = ag.result;
  const ui = TEAM_UI[r.winnerTeam];
  drawGiftIcon(ctx, ag.tags[ag.roundIndex], W / 2, H / 2 - 100, 90, ag.animFrame);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ui.fill;
  ctx.font = "bold 24px 'Noto Sans TC', sans-serif";
  ctx.fillText(`${r.winnerTeam === 'red' ? '🔴' : '🔵'} ${ui.label}得標！`, W / 2, H / 2 - 30);

  const boxW = 260, boxH = 70, gap = 20;
  const startX = W / 2 - boxW - gap / 2;
  [0, 1].forEach(i => {
    const team = i === 0 ? 'red' : 'blue';
    const tui = TEAM_UI[team];
    const won = r.winnerTeamIdx === i;
    const x = startX + i * (boxW + gap);
    const y = H / 2 + 10;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeStyle = won ? '#e6a62d' : tui.fill;
    ctx.lineWidth = won ? 4 : 2;
    ctx.beginPath();
    ctx.roundRect(x, y, boxW, boxH, 10);
    ctx.fill();
    ctx.stroke();

    const members = i === 0 ? [0, 1] : [2, 3];
    ctx.textAlign = 'left';
    ctx.font = "bold 13px 'Noto Sans TC', sans-serif";
    ctx.fillStyle = tui.text;
    ctx.fillText(`${team === 'red' ? '🔴' : '🔵'} ${tui.label}`, x + 14, y + 20);
    ctx.font = "12px 'Noto Sans TC', sans-serif";
    ctx.fillStyle = '#e9d6b0';
    ctx.fillText(members.map(m => `${ag.players[m].name} ${r.bids[m]}`).join('　'), x + 14, y + 40);
    ctx.font = "bold 15px 'Noto Sans TC', sans-serif";
    ctx.fillStyle = '#fff4d4';
    ctx.fillText(`總出價 🪙 ${r.teamBids[i]}`, x + 14, y + 58);
  });
}

function drawSuspense(ctx) {
  const progress = Math.min(1, Math.max(0, 1 - ag.phaseTimer / SUSPENSE_TIME));
  const t = Date.now() / 1000;
  const r = ag.result;

  const pulse = 1 + Math.sin(t * 6.2) * 0.06;
  ctx.save();
  const grad = ctx.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, 200);
  grad.addColorStop(0, 'rgba(255, 216, 91, 0.32)');
  grad.addColorStop(1, 'rgba(15, 8, 22, 0.1)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // spotlight beam converging on the platform
  ctx.save();
  ctx.globalAlpha = 0.55 + Math.sin(t * 1.3) * 0.08;
  const beamGrad = ctx.createLinearGradient(W / 2 - 130, 0, W / 2 + 130, 0);
  beamGrad.addColorStop(0, 'rgba(255,232,167,0)');
  beamGrad.addColorStop(0.5, 'rgba(255,242,189,0.22)');
  beamGrad.addColorStop(1, 'rgba(255,232,167,0)');
  ctx.fillStyle = beamGrad;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 30, 40);
  ctx.lineTo(W / 2 + 30, 40);
  ctx.lineTo(W / 2 + 130, H);
  ctx.lineTo(W / 2 - 130, H);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // auction platform
  ctx.save();
  ctx.fillStyle = 'rgba(140, 90, 45, 0.5)';
  ctx.strokeStyle = 'rgba(60, 35, 18, 0.8)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(W / 2, H / 2 + 118, 120, 18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // drifting dust motes caught in the spotlight
  ag.dustMotes?.forEach(m => {
    const local = ((t + m.delay) % 2.5) / 2.5;
    const opacity = local < 0.35 ? (local / 0.35) * 0.5 : Math.max(0, 0.5 * (1 - (local - 0.35) / 0.65));
    if (opacity <= 0) return;
    const dx = m.x * W + local * 8;
    const dy = m.y * H + 12 - 50 * local;
    ctx.fillStyle = `rgba(244, 220, 166, ${opacity})`;
    ctx.beginPath();
    ctx.arc(dx, dy, 2, 0, Math.PI * 2);
    ctx.fill();
  });

  // "LOT 0N" plaque and each team's final bid, fading in then retiring
  // before the curtains part
  const infoT = progress < 0.1 ? progress / 0.1 : progress > 0.82 ? Math.max(0, 1 - (progress - 0.82) / 0.18) : 1;
  if (infoT > 0.01) {
    ctx.save();
    ctx.globalAlpha = infoT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.translate(W / 2, 58);
    ctx.rotate(-0.035);
    ctx.fillStyle = 'rgba(244, 223, 170, 0.92)';
    ctx.strokeStyle = 'rgba(112, 68, 31, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(-46, -14, 92, 28, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#51301a';
    ctx.font = "bold 12px 'Noto Sans TC', sans-serif";
    ctx.fillText(`LOT ${String(ag.roundIndex + 1).padStart(2, '0')}`, 0, 1);
    ctx.restore();

    const placardY = H / 2 + 12;
    ['red', 'blue'].forEach((team, i) => {
      const x = i === 0 ? W / 2 - 175 : W / 2 + 175;
      const rot = i === 0 ? -0.14 : 0.14;
      ctx.save();
      ctx.translate(x, placardY);
      ctx.rotate(rot);
      ctx.fillStyle = TEAM_UI[team].fill;
      ctx.strokeStyle = 'rgba(40,20,10,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(-42, -16, 84, 32, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = "bold 12px 'Noto Sans TC', sans-serif";
      ctx.fillText(`🪙 ${r.teamBids[i]}`, 0, 1);
      ctx.restore();
    });
    ctx.restore();
  }

  // gift being inspected: gentle tilt + pulse, like it's being turned over
  ctx.save();
  ctx.translate(W / 2, H / 2 - 20);
  ctx.rotate(Math.sin(t * 1.9) * 0.05);
  ctx.scale(pulse, pulse);
  drawGiftIcon(ctx, ag.tags[ag.roundIndex], 0, 0, 140, ag.animFrame);
  ctx.restore();

  // stage curtains part dramatically in the final stretch
  const openT = progress < 0.72 ? 0 : (progress - 0.72) / 0.28;
  if (openT < 0.999) {
    const curtainW = W * 0.15;
    ['left', 'right'].forEach(side => {
      ctx.save();
      const slide = openT * curtainW * 1.6;
      const x = side === 'left' ? -slide : W - curtainW + slide;
      ctx.beginPath();
      ctx.rect(x, 0, curtainW, H);
      ctx.clip();
      for (let sx = x - curtainW; sx < x + curtainW * 2; sx += 14) {
        ctx.fillStyle = (Math.round(sx / 14) % 2 === 0) ? '#8f3229' : '#b54a38';
        ctx.fillRect(sx, 0, 14, H);
      }
      ctx.restore();
    });
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffe9b0';
  ctx.font = "bold 18px 'Noto Sans TC', sans-serif";
  ctx.fillText('鑑定中…', W / 2, H - 42);
  ctx.font = "12px 'Noto Sans TC', sans-serif";
  ctx.fillStyle = '#c9b3e6';
  const winnerUi = TEAM_UI[r.winnerTeam];
  ctx.fillText(`${winnerUi.label}以 🪙 ${r.price} 得標，正在開箱…`, W / 2, H - 20);
}

function drawResult(ctx) {
  const r = ag.result;
  const good = r.type === 'good';
  const ui = TEAM_UI[r.winnerTeam];
  const isJackpot = good && ag.tags[ag.roundIndex] === 'devil';
  const elapsed = Math.min(RESULT_PAUSE, Math.max(0, RESULT_PAUSE - ag.phaseTimer));

  // bad outcome gets a short decaying screen shake, like the box slammed shut
  let shakeX = 0, shakeY = 0;
  if (!good && elapsed < 0.5) {
    const decay = 1 - elapsed / 0.5;
    shakeX = Math.sin(elapsed * 90) * 7 * decay;
    shakeY = Math.cos(elapsed * 70) * 4 * decay;
  }
  ctx.save();
  ctx.translate(shakeX, shakeY);

  const glow = ctx.createRadialGradient(W / 2, H / 2 - 40, 10, W / 2, H / 2 - 40, 170);
  if (good) {
    glow.addColorStop(0, 'rgba(255, 247, 165, 0.5)');
    glow.addColorStop(1, 'rgba(255, 247, 165, 0)');
  } else {
    glow.addColorStop(0, 'rgba(113, 54, 107, 0.4)');
    glow.addColorStop(1, 'rgba(113, 54, 107, 0)');
  }
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  drawGiftIcon(ctx, good ? 'good' : 'bad', W / 2, H / 2 - 50, 130, 0);

  if (good) {
    // coins burst outward from the gift and arc up, fading as they go
    const coinCount = 11;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '20px sans-serif';
    for (let i = 0; i < coinCount; i++) {
      const local = Math.min(1, Math.max(0, (elapsed - i * 0.055) / 0.7));
      if (local <= 0) continue;
      const ease = 1 - (1 - local) * (1 - local);
      const dx = (i - 5) * 28 * ease;
      const dy = (-65 - (i % 3) * 30) * ease;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - local);
      ctx.translate(W / 2 + dx, H / 2 - 50 + dy);
      ctx.rotate(ease * 7.3);
      ctx.fillText('🪙', 0, 0);
      ctx.restore();
    }
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = good ? '#8ee06b' : '#ff6b6b';
  ctx.font = "bold 30px 'Noto Sans TC', sans-serif";
  ctx.fillText(good ? '好禮物！' : '壞禮物！', W / 2, H / 2 + 45);

  ctx.font = "bold 40px 'Noto Sans TC', sans-serif";
  ctx.fillText(`${good ? '+' : '-'}${good ? r.reward : r.price}`, W / 2, H / 2 + 90);

  if (isJackpot) {
    const pop = Math.min(1, elapsed / 0.45);
    const overshoot = pop < 1 ? 0.6 + pop * 0.4 + Math.sin(pop * Math.PI) * 0.08 : 1;
    ctx.save();
    ctx.globalAlpha = pop;
    ctx.translate(W / 2, H / 2 + 118);
    ctx.scale(overshoot, overshoot);
    ctx.fillStyle = '#ffe99b';
    ctx.font = "bold 16px 'Noto Sans TC', sans-serif";
    ctx.fillText('惡魔珍品 ×4', 0, 0);
    ctx.restore();
  }

  ctx.font = "13px 'Noto Sans TC', sans-serif";
  ctx.fillStyle = ui.text;
  ctx.fillText(
    good
      ? `${ui.label}拿回 ${r.reward} 枚金幣，淨賺 ${r.net} 枚，目前 🪙 ${ag.teamMoney[r.winnerTeamIdx]}`
      : `${ui.label}賠掉 ${r.price} 枚出價，目前 🪙 ${ag.teamMoney[r.winnerTeamIdx]}`,
    W / 2, H / 2 + (isJackpot ? 145 : 120),
  );

  ctx.restore();
}

// --- game module -------------------------------------------------------------

export default {
  id: 'auction',
  name: '村莊拍賣',
  description: '2v2 秘密出價拍賣，賭一把好禮物還是壞禮物！',
  playersPerTeam: 2,
  requireFullTeams: true,
  color: '#e6a62d',
  emoji: '🔨',
  cover: '10_auction/auction_cover.png',

  tutorial: {
    goal: '2v2 秘密出價拍賣！每輪五份神秘禮物，同隊兩人出價相加，出價最高的隊伍得標並立刻付款。得標後開箱有機率拿到好禮物（加倍拿回金幣）或壞禮物（出價直接沒收）。5 輪結束後金幣較多的隊伍獲勝！',
    controls: [
      { key: '🎚️', text: '拖曳滑桿決定這一輪要出多少金幣（隊友與對手都看不到）' },
      { key: '🔒', text: '鎖定出價（鎖定前可以隨時修改；雙方都鎖定後倒數會縮短到 5 秒）' },
    ],
    tips: [
      '天使禮物好禮物機率高但賠率低，惡魔禮物好禮物機率低但賠率高達 4 倍，普通禮物機率各半',
      '出到 0 元也算出價，只要同隊總和比對方高就能得標；雙方都出 0 則本輪流標',
      '得標金額會立刻從隊伍金幣扣除，開箱結果之後才知道是賺是賠',
      '每人單輪出價上限是隊伍目前金幣的一半，金幣愈少能出的價愈低',
    ],
  },

  onStart(globalState, endCb) {
    const active = globalState.activePlayers || {};
    const teams = globalState.teams || {};
    const playing = Object.entries(active)
      .filter(([, role]) => role === 'playing')
      .map(([id]) => id);
    const redIds = playing.filter(id => teams[id] === 'red');
    const blueIds = playing.filter(id => teams[id] === 'blue');

    const players = SLOT_DEFS.map((def, i) => {
      const pool = def.team === 'red' ? redIds : blueIds;
      const poolIdx = def.team === 'red' ? i : i - 2;
      const deviceId = pool[poolIdx];
      const name = truncateName(globalState.players?.[deviceId]?.name ?? `Player ${deviceId}`);
      return { slot: i, team: def.team, deviceId, name };
    });

    ag = {
      players,
      teamMoney: [STARTING_MONEY, STARTING_MONEY],
      tags: newTags(),
      roundIndex: 0,
      phase: 'preview',
      phaseTimer: PREVIEW_TIME,
      bidTimeLeft: 0,
      bids: [0, 0, 0, 0],
      locked: [false, false, false, false],
      result: null,
      animFrame: 0,
      animTimer: 0,
      done: false,
      assetsReady: false,
      _endCb: endCb,
    };

    bgm.start();
    preloadImages(AUCTION_IMAGES).then(() => { if (ag) ag.assetsReady = true; });
  },

  preload() {
    return preloadImages(AUCTION_IMAGES);
  },

  update(dt, globalState) {
    if (!ag || ag.done || !ag.assetsReady) return;

    ag.animTimer += dt;
    if (ag.animTimer >= 0.105) { ag.animTimer = 0; ag.animFrame = (ag.animFrame + 1) % 8; }

    switch (ag.phase) {
      case 'preview':
        ag.phaseTimer -= dt;
        if (ag.phaseTimer <= 0) startBidRound(globalState);
        break;

      case 'bid': {
        ag.bidTimeLeft -= dt;
        const redLocked  = ag.locked[0] && ag.locked[1];
        const blueLocked = ag.locked[2] && ag.locked[3];
        if ((redLocked || blueLocked)) ag.bidTimeLeft = Math.min(ag.bidTimeLeft, SHORTEN_TIME);
        if (ag.bidTimeLeft <= 0) resolveRound();
        break;
      }

      case 'unsold':
        ag.phaseTimer -= dt;
        if (ag.phaseTimer <= 0) advanceRound(globalState);
        break;

      case 'winner':
        ag.phaseTimer -= dt;
        if (ag.phaseTimer <= 0) {
          ag.phase = 'suspense';
          ag.phaseTimer = SUSPENSE_TIME;
          ag.dustMotes = makeDustMotes();
          SFX.loading();
        }
        break;

      case 'suspense':
        ag.phaseTimer -= dt;
        if (ag.phaseTimer <= 0) revealResult();
        break;

      case 'result':
        ag.phaseTimer -= dt;
        if (ag.phaseTimer <= 0) advanceRound(globalState);
        break;
    }
  },

  draw(ctx, w, h) {
    if (!ag) return;
    if (!ag.assetsReady) { drawAssetLoadingPlaceholder(ctx, w, h, '村莊拍賣'); return; }

    ctx.fillStyle = '#241408';
    ctx.fillRect(0, 0, w, h);
    const scale = Math.min(w / W, h / H);
    ctx.save();
    ctx.translate((w - W * scale) / 2, (h - H * scale) / 2);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    if (bgImg.complete && bgImg.naturalWidth > 0) {
      ctx.drawImage(bgImg, 0, 0, W, H);
    } else {
      ctx.fillStyle = '#3a230f';
      ctx.fillRect(0, 0, W, H);
    }
    ctx.fillStyle = 'rgba(20, 10, 5, 0.35)';
    ctx.fillRect(0, 0, W, H);

    if (ag.phase !== 'preview') drawTopBar(ctx);

    switch (ag.phase) {
      case 'preview':  drawPreview(ctx); break;
      case 'bid':      drawBid(ctx); break;
      case 'unsold':   drawUnsold(ctx); break;
      case 'winner':   drawWinner(ctx); break;
      case 'suspense': drawSuspense(ctx); break;
      case 'result':   drawResult(ctx); break;
    }

    ctx.restore();
  },

  onInput(deviceId, data) {
    if (!ag || ag.phase !== 'bid') return;
    const did = String(deviceId);
    const p = ag.players.find(pl => pl.deviceId != null && String(pl.deviceId) === did);
    if (!p || ag.locked[p.slot]) return;

    if (data.action === 'bid') {
      const max = maxBidFor(p.team);
      ag.bids[p.slot] = Math.max(0, Math.min(max, Math.round(data.value ?? 0)));
    } else if (data.action === 'lock') {
      ag.locked[p.slot] = true;
    }
  },

  onEnd() {
    bgm.stop();
    ag = null;
  },
};
