/**
 * 危台求生 — 2v2 platform-survival battle royale ported from fall-main/index.html
 *
 * Red vs blue, 2 per team (playersPerTeam: 2); requireFullTeams means both
 * sides always field exactly 2 real players before the match can start.
 * Everyone starts on one solid floating platform; at 20s it permanently
 * cracks into 3 pieces (5 in the "裂成五塊"
 * crazy-mode mutator) and starts wobbling. Rising obstacles, falling
 * star/gem/fake-trap pickups, and periodic screen-wide "big hazard" columns
 * whittle down each player's 5 lives — falling off the platform costs a life
 * and respawns you, it only eliminates you once lives hit 0. A full team wipe
 * ends the match immediately (simultaneous wipe = draw); otherwise at time's
 * up the winner is whoever has more survivors, then more total lives, then
 * whoever was hit least recently.
 *
 * "瘋狂模式" (crazy mode) is exposed through the hub's normal mode-select
 * picker (`maps`) — picking it rolls one random mutator for the whole match,
 * exactly like the prototype's checkbox did.
 *
 * Physics runs in a fixed logical space (900x600) so tuning is independent of
 * the screen resolution; draw() uniform-scales + letterboxes into the actual
 * canvas. Frame-based timers (durations tuned assuming ~60fps in the source)
 * are driven by `frames = dt * 60` each tick, same trick the prototype used
 * for its requestAnimationFrame loop, so the tuned feel carries over exactly
 * even though our dt is variable.
 */
import { truncateName } from '../../shared/nameDisplay.js';
import { bgm, SFX } from './audio.js';

const W = 900, H = 600;
const PLATFORM_Y = 260;
const PLATFORM_MARGIN = 30;
const MIN_PIECE_W = 70;
const GRAVITY = 0.7;
const MAX_FALL_VY = 15;
const JUMP_FORCE = 16.5;
const PLAYER_W = 60, PLAYER_H = 60;
const PLAYER_SPRITE_Y_OFFSET = 2;
const PLAYER_HITBOX_INSET_X = PLAYER_W * 0.19; // 雪人實際內容寬度約盒子的六成,兩側各內縮一點再判定
function playerHitLeft(p) { return p.x + PLAYER_HITBOX_INSET_X; }
function playerHitRight(p) { return p.x + PLAYER_W - PLAYER_HITBOX_INSET_X; }
const STAR_DURATION = 300; // frames (~5s)
const TIME_LIMIT = 60;
const FALL_STUN_FRAMES = 45; // 掉落後短暫失能,約 0.75 秒
const STARTING_LIVES = 5;

const PUSH_FORCE = 10; // 巨型威脅命中時的擊退力道

// 踩頭暈眩機制
const STOMP_HEAD_MARGIN = 16;
const STOMP_STUN_FRAMES = 90; // 約 1.5 秒
const STOMP_BOUNCE = 12;

// 障礙物命中判定縮小(避免透明留白造成誤判)
const OBSTACLE_HITBOX_SCALE = 0.72;

// 平台裂成三塊的時間點與裂開前的警戒預告秒數
const SPLIT_TRIGGER_SECONDS = 20;
const SPLIT_WARN_SEC = 1.6;

// big hazard(大範圍威脅): 先警示,再從畫面下方往上衝出一整條巨大危險區
const BIG_HAZARD_WARN_SEC = 1.5;
const BIG_HAZARD_HEIGHT = 340;

// --- 隊伍色 / 玩家位置設定 ---------------------------------------------------
const TEAM_UI = {
  red:  { label: '紅隊', text: '#ff8080', barBg: '#552222', barFill: '#ff4d4d' },
  blue: { label: '藍隊', text: '#80c0ff', barBg: '#223355', barFill: '#4da3ff' },
};
// 紅隊 = 雪人1(深紅帽)+雪人2(淺紅帽), 藍隊 = 雪人3(深藍帽)+雪人4(淺藍帽)
// ── 雪人圖本身就有隊伍色的帽子,不用像 climb 那樣套濾鏡染色
const SLOT_DEFS = [
  { spriteIdx: 0, team: 'red' },
  { spriteIdx: 1, team: 'red' },
  { spriteIdx: 2, team: 'blue' },
  { spriteIdx: 3, team: 'blue' },
];
// 開局站位:讓兩隊交錯站(由左到右是 P1、P3、P2、P4),而不是同隊擠在一起
const START_POSITION_SLOTS = [0, 2, 1, 3];

// 瘋狂模式:每局隨機從中抽 1 條套用
const CRAZY_MUTATORS = [
  { id: 'ice', name: '冰面滑動', desc: '移動有慣性,滑起來更誇張' },
  { id: 'fakeItem', name: '假道具', desc: '外觀明顯不同的陷阱道具混在其中,而且一落地就會消失' },
  { id: 'oneLife', name: '一命模式', desc: '所有人只有 1 條命,一次失誤就淘汰' },
  { id: 'stompDamage', name: '踩人扣血', desc: '踩到對手直接扣血,取代原本的暈眩效果' },
  { id: 'fiveSplit', name: '裂成五塊', desc: '平台永久裂成五塊,巨型威脅會同時攻擊兩塊不相鄰的板塊' },
];

// --- 圖片素材(角色圖預設朝左) -------------------------------------------------
function loadImg(src) { const img = new Image(); img.src = src; return img; }
const playerImages = [1, 2, 3, 4].map(n => loadImg(`08_fall/player/snowman${n}.png`));
const obsSmallImg = loadImg('08_fall/obs/obs1.png');
const obsBigImg = loadImg('08_fall/obs/obs2.png');
const starImg = loadImg('08_fall/item/star.png');
const gemImg = loadImg('08_fall/item/diamond.png');
const bgImg = loadImg('08_fall/background.png');

let fg = null; // module-level fall-game state

function diff() { return Math.min(1, fg.t / 45); }
function nextBigHazardInterval() {
  return Math.max(4.2, 7.5 - diff() * 3) + Math.random() * 1.2;
}

function planSplit(forceCount) {
  const d = diff();
  let count = forceCount || 2;
  if (!forceCount) {
    const r = Math.random();
    if (d > 0.65 && r < 0.55) count = 3;
    else if (d > 0.3 && r < 0.3) count = 3;
  }

  const usable = W - 2 * PLATFORM_MARGIN;
  const gapsCount = count - 1;
  let gapW = 55 + d * 95 + (Math.random() * 30 - 15);
  const maxTotalGap = usable - MIN_PIECE_W * count;
  gapW = Math.max(30, Math.min(gapW, gapsCount > 0 ? maxTotalGap / gapsCount : 0));

  const totalGap = gapW * gapsCount;
  const totalPieceW = usable - totalGap;
  const ratios = [];
  let sum = 0;
  for (let i = 0; i < count; i++) { const r2 = 0.7 + Math.random() * 0.6; ratios.push(r2); sum += r2; }
  const widths = ratios.map(r2 => Math.max(MIN_PIECE_W, (r2 / sum) * totalPieceW));
  const wSum = widths.reduce((a, b) => a + b, 0);
  const scale = totalPieceW / wSum;
  const finalWidths = widths.map(w => w * scale);

  const newPieces = [];
  let x = PLATFORM_MARGIN;
  for (let i = 0; i < count; i++) {
    const w = finalWidths[i];
    newPieces.push({
      x, w,
      yOffsetBase: (Math.random() * 32 - 16),
      wobbleAmp: 5 + Math.random() * 3,
      wobbleSpeed: 0.03 + Math.random() * 0.03,
      wobblePhase: Math.random() * Math.PI * 2,
    });
    x += w + gapW;
  }
  return newPieces;
}

function pieceEffY(p) {
  return PLATFORM_Y + p.yOffsetBase + Math.sin(fg.t * 60 * p.wobbleSpeed + p.wobblePhase) * p.wobbleAmp;
}

function startSolid() {
  fg.phase = 'solid';
  fg.pieces = [{
    x: PLATFORM_MARGIN, w: W - 2 * PLATFORM_MARGIN,
    yOffsetBase: 0, wobbleAmp: 2, wobbleSpeed: 0.02, wobblePhase: Math.random() * Math.PI * 2,
  }];
}

function triggerPermanentSplit() {
  fg.permanentSplit = true;
  fg.phase = 'permanentSplit';
  if (!fg.crackPlan) fg.crackPlan = planSplit(fg.activeMutator?.id === 'fiveSplit' ? 5 : 3);
  fg.pieces = fg.crackPlan;
  fg.bigHazardTimer = 3;

  // 裂開瞬間,把原本站在板子上的玩家直接貼齊新板塊表面,避免懸空掉落
  for (const p of fg.players) {
    if (p.eliminated) continue;
    for (const piece of fg.pieces) {
      const overlap = p.x + PLAYER_W > piece.x && p.x < piece.x + piece.w;
      if (overlap) { p.y = pieceEffY(piece) - PLAYER_H; p.vy = 0; break; }
    }
  }

  // 舊板塊上停留的道具重新落下找新板塊
  for (const it of fg.items) {
    if (it.state === 'resting') {
      it.state = 'falling';
      it.restPiece = null;
      it.vy = Math.abs(it.vy) || 2.4;
    }
  }
}

function spawnObstacle() {
  const x = 40 + Math.random() * (W - 80);
  const speed = 4.8 + diff() * 4.8 + Math.random() * 1.5;
  const size = 50 + Math.random() * 10;
  fg.obstacles.push({ x, y: H + 20, w: size, h: size, vy: -speed });
}

function spawnItem() {
  const x = 60 + Math.random() * (W - 120);
  const speed = 2.4 + diff() * 1.2;
  let type;
  const am = fg.activeMutator;
  if (am && am.id === 'fakeItem') {
    const r = Math.random();
    type = r < 0.4 ? 'star' : (r < 0.7 ? 'gem' : 'fake');
  } else if (am && am.id === 'oneLife') {
    type = 'star'; // 一命模式沒有補血的意義,只留無敵星星
  } else {
    type = Math.random() < 0.6 ? 'star' : 'gem';
  }
  // 從上方掉落,落到板塊上會停留幾秒等人撿,掉進縫隙就直接消失
  fg.items.push({ x, y: -30, r: 13, vy: speed, type, state: 'falling', restPiece: null, restTimer: 0 });
}

function spawnBgParticle() {
  fg.bgParticles.push({
    x: 45 + Math.random() * (W - 90),
    y: H + 15,
    size: 2 + Math.random() * 9,
    speed: 1 + Math.random() * 2.2 + diff() * 1.3,
    alpha: 0.10 + Math.random() * 0.22,
  });
}

function spawnBigHazard() {
  if (!fg.pieces.length) return;

  // 裂成五塊模式:一次同時攻擊兩塊不相鄰的板塊
  if (fg.activeMutator?.id === 'fiveSplit' && fg.pieces.length >= 4) {
    const validPairs = [];
    for (let a = 0; a < fg.pieces.length; a++) {
      for (let b = a + 2; b < fg.pieces.length; b++) validPairs.push([a, b]);
    }
    if (validPairs.length > 0) {
      const [ia, ib] = validPairs[Math.floor(Math.random() * validPairs.length)];
      for (const idx of [ia, ib]) {
        const piece = fg.pieces[idx];
        const w = Math.min(piece.w, piece.w * (0.65 + Math.random() * 0.3));
        const maxX = piece.x + piece.w - w;
        const x = piece.x + Math.random() * Math.max(0, maxX - piece.x);
        fg.bigHazards.push({ x, w, state: 'warn', timer: BIG_HAZARD_WARN_SEC });
      }
      return;
    }
  }

  // 一般模式:排除上一次選過的板塊,優先挑目前有玩家站著的板塊
  const candidates = fg.pieces.length > 1 ? fg.pieces.filter(p => p !== fg.lastBigHazardPiece) : fg.pieces;
  const alivePlayers = fg.players.filter(p => !p.eliminated);
  let candidatePiece = null;
  for (const p of alivePlayers) {
    for (const piece of candidates) {
      if (p.x + PLAYER_W > piece.x && p.x < piece.x + piece.w) { candidatePiece = piece; break; }
    }
    if (candidatePiece) break;
  }
  const piece = candidatePiece || candidates[Math.floor(Math.random() * candidates.length)];
  const w = Math.min(piece.w, piece.w * (0.65 + Math.random() * 0.3));
  const maxX = piece.x + piece.w - w;
  const x = piece.x + Math.random() * Math.max(0, maxX - piece.x);
  fg.bigHazards.push({ x, w, state: 'warn', timer: BIG_HAZARD_WARN_SEC });
  fg.lastBigHazardPiece = piece;
}

function makePlayer(def, x, deviceId, name) {
  return {
    ...def,
    deviceId,
    name,
    x, y: PLATFORM_Y - PLAYER_H,
    vy: 0,
    lives: STARTING_LIVES,
    eliminated: false,
    lastDamageTime: -1,
    invuln: 0,
    flashTimer: 0,
    invincibleTimer: 0,
    kbVX: 0,
    stunTimer: 0,
    facing: 'left',
    prevY: PLATFORM_Y - PLAYER_H,
    iceVX: 0,
    ctrl: { dx: 0, jumpHeld: false },
  };
}

// 只踩得到「對手」的頭 — 原型說明文字寫的就是踩對手,但程式碼漏了隊伍檢查,
// 移植時順手補上,不然會誤傷同隊隊友。
function resolveStomps() {
  for (const attacker of fg.players) {
    if (attacker.eliminated || attacker.vy <= 0) continue;
    for (const target of fg.players) {
      if (target === attacker || target.eliminated || target.team === attacker.team) continue;
      if (target.stunTimer > 0 || target.invincibleTimer > 0 || target.invuln > 0) continue;
      const feetPrev = attacker.prevY + PLAYER_H;
      const feetNow = attacker.y + PLAYER_H;
      const headY = target.y + STOMP_HEAD_MARGIN;
      const horizOverlap = playerHitRight(attacker) > playerHitLeft(target) && playerHitLeft(attacker) < playerHitRight(target);
      if (horizOverlap && feetPrev <= headY && feetNow >= target.y - 6) {
        if (fg.activeMutator?.id === 'stompDamage') {
          loseLife(target);
          target.invuln = 40;
          target.flashTimer = Math.max(target.flashTimer, 30);
        } else {
          target.stunTimer = STOMP_STUN_FRAMES;
          target.flashTimer = Math.max(target.flashTimer, 30);
          vibrate(target);
        }
        attacker.vy = -STOMP_BOUNCE;
        attacker.y = target.y - PLAYER_H - 2;
        fg.hitEffects.push({ x: target.x + PLAYER_W / 2, y: target.y + 10, timer: 20, maxTimer: 20 });
        break;
      }
    }
  }
}

function eliminate(p) { p.eliminated = true; }

function loseLife(p) {
  if (p.eliminated) return;
  p.lives -= 1;
  p.lastDamageTime = fg.t;
  SFX.hurt();
  vibrate(p);
  if (p.lives <= 0) eliminate(p);
}

function fallOff(p) {
  loseLife(p);
  if (p.eliminated) {
    p.y = H + 300; // 淘汰後移出畫面,不再參與
    p.vy = 0;
    return;
  }
  const target = fg.pieces[Math.floor(Math.random() * fg.pieces.length)];
  p.x = target.x + target.w / 2 - PLAYER_W / 2;
  p.y = pieceEffY(target) - PLAYER_H;
  p.vy = 0;
  p.invuln = 55;
  p.flashTimer = 55;
  p.stunTimer = FALL_STUN_FRAMES;
  fg.screenFlash = 1;
}

function teamPlayers(team) { return fg.players.filter(p => p.team === team); }
function teamAliveCount(team) { return teamPlayers(team).filter(p => !p.eliminated).length; }
function teamLivesSum(team) { return teamPlayers(team).reduce((s, p) => s + Math.max(0, p.lives), 0); }
function teamLastDamageTime(team) { return teamPlayers(team).reduce((m, p) => Math.max(m, p.lastDamageTime ?? -1), -1); }

function finishMatch(globalState) {
  const aliveA = teamAliveCount('red'), aliveB = teamAliveCount('blue');
  const livesA = teamLivesSum('red'), livesB = teamLivesSum('blue');
  const dmgA = teamLastDamageTime('red'), dmgB = teamLastDamageTime('blue');

  let winnerTeam = null;
  if (aliveA === 0 && aliveB === 0) winnerTeam = null;
  else if (aliveA === 0) winnerTeam = 'blue';
  else if (aliveB === 0) winnerTeam = 'red';
  else if (aliveA !== aliveB) winnerTeam = aliveA > aliveB ? 'red' : 'blue';
  else if (livesA !== livesB) winnerTeam = livesA > livesB ? 'red' : 'blue';
  else if (dmgA !== dmgB) winnerTeam = dmgA > dmgB ? 'red' : 'blue';
  _finish(globalState, winnerTeam);
}

function checkEndConditions(globalState) {
  if (teamAliveCount('red') === 0 || teamAliveCount('blue') === 0) {
    finishMatch(globalState);
    return true;
  }
  return false;
}

function _finish(globalState, winnerTeam) {
  if (!fg || fg.done) return;
  fg.done = true;
  // 每位真人玩家把最終剩餘命數折算進大廳計分板
  for (const p of fg.players) {
    if (!p.deviceId || !globalState.players?.[p.deviceId]) continue;
    globalState.players[p.deviceId].score = (globalState.players[p.deviceId].score || 0) + Math.max(0, p.lives);
  }
  fg._endCb?.(winnerTeam);
}

function vibrate(p) {
  if (!p.deviceId) return;
  const gs = fg?._globalState;
  if (!gs) return;
  if (!gs._pendingMessages) gs._pendingMessages = [];
  gs._pendingMessages.push({ type: 'hit_confirm', deviceId: String(p.deviceId) });
}

// --- 繪製 ---------------------------------------------------------------------

function drawImageSafe(ctx, img, x, y, w, h) {
  if (img && img.complete && img.naturalWidth > 0) ctx.drawImage(img, x, y, w, h);
}

function drawFakeItem(ctx, cx, cy, r) {
  // 假道具:刻意畫成暗紅尖刺球+白色X,外觀跟真道具明顯不同
  ctx.save();
  ctx.translate(cx, cy);
  const spikes = 8;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const ang = i * Math.PI / spikes;
    const rr = i % 2 === 0 ? r * 1.35 : r * 0.7;
    const px = Math.cos(ang) * rr, py = Math.sin(ang) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = '#6b0f0f';
  ctx.fill();
  ctx.strokeStyle = '#2a0505';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-r * 0.5, -r * 0.5); ctx.lineTo(r * 0.5, r * 0.5);
  ctx.moveTo(r * 0.5, -r * 0.5); ctx.lineTo(-r * 0.5, r * 0.5);
  ctx.stroke();
  ctx.restore();
}

function drawPlatformPiece(ctx, piece, y) {
  const x = piece.x, w = piece.w, h = 20, r = 4;

  if (!piece.cracks) {
    piece.cracks = [];
    const numCracks = 1 + Math.floor(Math.random() * 2);
    for (let c = 0; c < numCracks; c++) {
      const segments = 3 + Math.floor(Math.random() * 3);
      const totalLen = w * (0.25 + Math.random() * 0.35);
      const startX = Math.random() * Math.max(0, w - totalLen);
      const startY = h * 0.3 + Math.random() * h * 0.3;
      const points = [{ dx: startX, dy: startY }];
      const stepX = totalLen / (segments - 1);
      let curX = startX, curY = startY;
      for (let i = 1; i < segments; i++) {
        curX += stepX;
        curY = Math.max(2, Math.min(h - 3, curY + (Math.random() - 0.5) * h * 0.35));
        points.push({ dx: curX, dy: curY });
      }
      piece.cracks.push(points);
    }
  }
  if (!piece.sparkles) {
    piece.sparkles = [];
    const count = Math.max(1, Math.round(w / 70));
    for (let i = 0; i < count; i++) {
      piece.sparkles.push({
        dx: Math.random() * w, dy: h * 0.15 + Math.random() * h * 0.55,
        r: 0.6 + Math.random() * 0.8, phase: Math.random() * Math.PI * 2,
      });
    }
  }

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h + 6, w * 0.42, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  const bodyGrad = ctx.createLinearGradient(0, y, 0, y + h);
  bodyGrad.addColorStop(0, '#eef2fb');
  bodyGrad.addColorStop(1, '#9aa8c8');
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  ctx.save();
  ctx.clip();
  const edgeH = Math.min(8, h * 0.4);
  const edgeGrad = ctx.createLinearGradient(0, y + h - edgeH, 0, y + h);
  edgeGrad.addColorStop(0, 'rgba(60,70,100,0)');
  edgeGrad.addColorStop(1, 'rgba(50,58,86,0.55)');
  ctx.fillStyle = edgeGrad;
  ctx.fillRect(x, y + h - edgeH, w, edgeH);

  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + 3, y + 2.5);
  ctx.lineTo(x + w - 3, y + 2.5);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(110,130,175,0.55)';
  ctx.lineWidth = 1;
  for (const crack of piece.cracks) {
    ctx.beginPath();
    ctx.moveTo(x + crack[0].dx, y + crack[0].dy);
    for (let i = 1; i < crack.length; i++) ctx.lineTo(x + crack[i].dx, y + crack[i].dy);
    ctx.stroke();
  }

  ctx.fillStyle = '#ffffff';
  for (const sp of piece.sparkles) {
    ctx.globalAlpha = 0.45 + 0.45 * Math.sin(fg.t * 3 + sp.phase);
    ctx.beginPath();
    ctx.arc(x + sp.dx, y + sp.dy, sp.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.strokeStyle = 'rgba(100,112,145,0.65)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawBackground(ctx) {
  if (!bgImg.complete || !bgImg.naturalWidth) {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#394566');
    grad.addColorStop(1, '#0a0c14');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  const tileH = bgImg.naturalHeight * (W / bgImg.naturalWidth);
  const offY = (tileH - (fg.scrollOffset % tileH)) % tileH;
  for (let y = -tileH + offY; y < H; y += tileH) ctx.drawImage(bgImg, 0, y, W, tileH);
}

function drawPlayer(ctx, p) {
  if (p.eliminated) return;
  if (p.flashTimer > 0 && Math.floor(p.flashTimer / 4) % 2 === 0) return;
  if (p.invincibleTimer > 0) {
    ctx.fillStyle = 'rgba(255,210,63,0.35)';
    ctx.beginPath();
    ctx.arc(p.x + PLAYER_W / 2, p.y + PLAYER_H / 2, PLAYER_W * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }

  const img = playerImages[p.spriteIdx];
  if (p.facing === 'right') {
    // 圖片預設朝左,朝右移動時水平翻轉
    ctx.save();
    ctx.translate(p.x + PLAYER_W, p.y);
    ctx.scale(-1, 1);
    drawImageSafe(ctx, img, 0, PLAYER_SPRITE_Y_OFFSET, PLAYER_W, PLAYER_H);
    ctx.restore();
  } else {
    drawImageSafe(ctx, img, p.x, p.y + PLAYER_SPRITE_Y_OFFSET, PLAYER_W, PLAYER_H);
  }

  if (p.stunTimer > 0) {
    for (let si = 0; si < 3; si++) {
      const ang = fg.t * 6 + si * (Math.PI * 2 / 3);
      const sx = p.x + PLAYER_W / 2 + Math.cos(ang) * 22;
      const sy = p.y - 6 + Math.sin(ang) * 8;
      ctx.fillStyle = '#ffe27a';
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 名字 + 剩餘命數(取代原型的 DOM 角落血條,直接畫在頭頂上方)
  ctx.font = "bold 12px 'Noto Sans TC', sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const labelX = p.x + PLAYER_W / 2;
  const labelY = p.y - 8;
  const label = `${p.name} ❤${Math.max(0, p.lives)}`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(label, labelX, labelY);
  ctx.fillStyle = TEAM_UI[p.team].text;
  ctx.fillText(label, labelX, labelY);
}

function drawUI(ctx) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, W, 46);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`${Math.ceil(fg.timeLeft)}`, W / 2, 6);

  // 隊伍剩餘總命數長條(取代 climb 的高度長條,這裡比的是命數)
  const livesRed = teamLivesSum('red'), livesBlue = teamLivesSum('blue');
  const maxRef = STARTING_LIVES * 2;
  const barW = 200, barH = 10;

  ctx.font = "bold 12px 'Noto Sans TC', sans-serif";
  ctx.textAlign = 'left';
  ctx.fillStyle = TEAM_UI.red.text;
  ctx.fillText(`${TEAM_UI.red.label}  ❤${livesRed}`, 12, 4);
  ctx.fillStyle = TEAM_UI.red.barBg;
  ctx.fillRect(12, 22, barW, barH);
  ctx.fillStyle = TEAM_UI.red.barFill;
  ctx.fillRect(12, 22, barW * Math.min(1, livesRed / maxRef), barH);

  ctx.textAlign = 'right';
  ctx.fillStyle = TEAM_UI.blue.text;
  ctx.fillText(`❤${livesBlue}  ${TEAM_UI.blue.label}`, W - 12, 4);
  ctx.fillStyle = TEAM_UI.blue.barBg;
  ctx.fillRect(W - 12 - barW, 22, barW, barH);
  ctx.fillStyle = TEAM_UI.blue.barFill;
  ctx.fillRect(W - 12 - barW + barW * (1 - Math.min(1, livesBlue / maxRef)), 22, barW * Math.min(1, livesBlue / maxRef), barH);

  ctx.restore();
}

// --- game module ------------------------------------------------------------

export default {
  id: 'fall',
  name: '危台求生',
  description: '2v2 平台大逃殺，別被踢下浮動平台',
  playersPerTeam: 2,
  requireFullTeams: true,
  color: '#5aa9c9',
  emoji: '❄️',
  cover: '08_fall/fall_cover.png',

  maps: [
    { name: '一般模式', description: '標準規則', enabled: true },
    { name: '瘋狂模式', description: '開局隨機套用一條特殊規則', enabled: true },
  ],

  tutorial: {
    goal: '2v2 大逃殺！腳下浮動平台會裂成好幾塊，掉出畫面外會扣血，5 條命扣光就淘汰。時間到或對方全滅就獲勝！',
    controls: [
      { key: '⬅➡', text: '左右移動' },
      { key: 'Ⓐ', text: '跳躍（按住不放，落地時會自動再跳一次）' },
    ],
    tips: [
      '跳到對手頭上可以把他踩暈，讓他短暫無法操作——同隊隊友頭上踩了沒事',
      '★金色星星＝短暫無敵　◆紫色寶石＝補一條命（滿血時沒有用）',
      '20 秒後平台會永久裂成三塊，之後不時有巨型威脅從畫面下方整條衝出，只能左右閃開',
      '時間到時比較：存活人數 → 剩餘總命數 → 最晚被扣血的隊伍獲勝',
      '「瘋狂模式」開局會隨機套用一條特殊規則：冰面滑動、假道具陷阱、一命模式、踩人扣血、平台裂成五塊',
    ],
  },

  onStart(globalState, endCb) {
    // requireFullTeams guarantees exactly 2 real players per side.
    const active = globalState.activePlayers || {};
    const teams = globalState.teams || {};
    const playing = Object.entries(active)
      .filter(([, role]) => role === 'playing')
      .map(([id]) => id);
    const redIds = playing.filter(id => teams[id] === 'red');
    const blueIds = playing.filter(id => teams[id] === 'blue');

    const crazyModeEnabled = globalState.selectedMap === 1;
    const activeMutator = crazyModeEnabled
      ? CRAZY_MUTATORS[Math.floor(Math.random() * CRAZY_MUTATORS.length)]
      : null;
    const maxLives = activeMutator?.id === 'oneLife' ? 1 : STARTING_LIVES;

    const players = SLOT_DEFS.map((def, i) => {
      const pool = def.team === 'red' ? redIds : blueIds;
      const poolIdx = def.team === 'red' ? i : i - 2;
      const deviceId = pool[poolIdx];
      const x = W / 2 - 105 + START_POSITION_SLOTS[i] * 70;
      const name = truncateName(globalState.players?.[deviceId]?.name ?? `Player ${deviceId}`);
      const p = makePlayer(def, x, deviceId, name);
      p.lives = maxLives;
      return p;
    });

    fg = {
      t: 0,
      timeLeft: TIME_LIMIT,
      done: false,
      permanentSplit: false,
      permanentSplitWarned: false,
      crackPlan: null,
      activeMutator,
      maxLives,
      phase: 'solid',
      pieces: [],
      obstacles: [], obstacleTimer: 1.0,
      items: [], itemTimer: 2.5,
      bgParticles: [], bgSpawnTimer: 0,
      hitEffects: [],
      scrollOffset: 0,
      screenFlash: 0,
      bigHazards: [], bigHazardTimer: 3, lastBigHazardPiece: null,
      players,
      _endCb: endCb,
      _globalState: globalState,
    };
    startSolid();
    bgm.start();
  },

  update(dt, globalState) {
    if (!fg || fg.done) return;
    fg.t += dt;
    const frames = dt * 60;

    if (!fg.permanentSplit) {
      if (!fg.permanentSplitWarned && fg.t >= SPLIT_TRIGGER_SECONDS - SPLIT_WARN_SEC) {
        fg.permanentSplitWarned = true;
        fg.crackPlan = planSplit(fg.activeMutator?.id === 'fiveSplit' ? 5 : 3);
        fg.phase = 'permanentWarning';
      }
      if (fg.t >= SPLIT_TRIGGER_SECONDS) triggerPermanentSplit();
    }

    fg.scrollOffset += (2 + diff() * 3) * frames;

    fg.obstacleTimer -= dt;
    if (fg.obstacleTimer <= 0) {
      spawnObstacle();
      fg.obstacleTimer = Math.max(0.08, 1.25 - diff() * 1.3) + Math.random() * 0.12;
    }
    for (const o of fg.obstacles) o.y += o.vy * frames;
    fg.obstacles = fg.obstacles.filter(o => o.y > -60);

    fg.itemTimer -= dt;
    if (fg.itemTimer <= 0) {
      spawnItem();
      fg.itemTimer = 3.0 + Math.random() * 2.5;
    }
    for (const it of fg.items) {
      if (it.state === 'falling') {
        it.y += it.vy * frames;
        for (const piece of fg.pieces) {
          const effY = pieceEffY(piece);
          const overlap = it.x + it.r > piece.x && it.x - it.r < piece.x + piece.w;
          if (overlap && it.y + it.r >= effY - 4 && it.y - it.r <= effY + 12) {
            it.state = 'resting';
            it.restPiece = piece;
            it.restTimer = it.type === 'fake' ? 0 : 6.0;
            it.y = effY - it.r - 2;
            break;
          }
        }
      } else {
        it.restTimer -= dt;
        if (it.restPiece) it.y = pieceEffY(it.restPiece) - it.r - 2;
      }
    }
    fg.items = fg.items.filter(it => it.state === 'falling' ? it.y < H + 30 : it.restTimer > 0);

    fg.bgSpawnTimer -= dt;
    if (fg.bgSpawnTimer <= 0) { spawnBgParticle(); fg.bgSpawnTimer = 0.08; }
    for (const bp of fg.bgParticles) bp.y -= bp.speed * frames;
    fg.bgParticles = fg.bgParticles.filter(bp => bp.y > -20);

    for (const he of fg.hitEffects) he.timer -= frames;
    fg.hitEffects = fg.hitEffects.filter(he => he.timer > 0);

    if (fg.screenFlash > 0) fg.screenFlash = Math.max(0, fg.screenFlash - 0.06 * frames);

    if (fg.permanentSplit) {
      fg.bigHazardTimer -= dt;
      if (fg.bigHazardTimer <= 0) {
        spawnBigHazard();
        fg.bigHazardTimer = nextBigHazardInterval();
      }
    }
    for (const bh of fg.bigHazards) {
      if (bh.state === 'warn') {
        bh.timer -= dt;
        if (bh.timer <= 0) {
          bh.state = 'rising';
          bh.y = H + BIG_HAZARD_HEIGHT / 2 + 10;
          bh.vy = -(6 + diff() * 5.5 + Math.random() * 1.2);
        }
      } else if (bh.state === 'rising') {
        bh.y += bh.vy * frames;
      }
    }
    fg.bigHazards = fg.bigHazards.filter(bh => !(bh.state === 'rising' && bh.y < -BIG_HAZARD_HEIGHT / 2 - 20));
    if (fg.permanentSplit && fg.bigHazards.length === 0 && diff() > 0.85) {
      fg.bigHazardTimer = Math.min(fg.bigHazardTimer, 0.4);
    }

    for (const p of fg.players) if (!p.eliminated) p.prevY = p.y;

    for (const p of fg.players) {
      if (p.eliminated) continue;

      let wantLeft = false, wantRight = false, jumpPressed = false;
      if (p.stunTimer > 0) {
        p.stunTimer -= frames;
      } else {
        wantLeft = p.ctrl.dx < -0.3;
        wantRight = p.ctrl.dx > 0.3;
        jumpPressed = p.ctrl.jumpHeld;
      }

      if (fg.activeMutator?.id === 'ice') {
        const ICE_ACCEL = 0.5, ICE_MAX = 7.6, ICE_FRICTION = 0.965;
        if (wantLeft) p.iceVX -= ICE_ACCEL * frames;
        if (wantRight) p.iceVX += ICE_ACCEL * frames;
        if (!wantLeft && !wantRight) p.iceVX *= Math.pow(ICE_FRICTION, frames);
        p.iceVX = Math.max(-ICE_MAX, Math.min(ICE_MAX, p.iceVX));
        if (p.iceVX < -0.05) p.facing = 'left';
        else if (p.iceVX > 0.05) p.facing = 'right';
        p.x += p.iceVX * frames + (p.kbVX || 0) * frames;
      } else {
        let vx = 0;
        if (wantLeft) vx -= 5.6;
        if (wantRight) vx += 5.6;
        if (vx < 0) p.facing = 'left';
        else if (vx > 0) p.facing = 'right';
        p.x += vx * frames * 0.5 + (p.kbVX || 0) * frames;
      }
      p.kbVX = (p.kbVX || 0) * Math.pow(0.85, frames);
      p.x = Math.max(0, Math.min(W - PLAYER_W, p.x));

      let supported = false, standingPiece = null;
      if (p.vy >= 0) {
        for (const piece of fg.pieces) {
          const effY = pieceEffY(piece);
          const overlap = p.x + PLAYER_W > piece.x && p.x < piece.x + piece.w;
          const feet = p.y + PLAYER_H;
          if (overlap && feet >= effY - 6 && feet <= effY + 16) { supported = true; standingPiece = piece; break; }
        }
      }
      if (supported) {
        p.y = pieceEffY(standingPiece) - PLAYER_H;
        p.vy = 0;
        if (jumpPressed) {
          p.vy = -JUMP_FORCE;
          supported = false;
          SFX.jump();
        }
      }
      if (!supported) {
        p.vy = Math.min(MAX_FALL_VY, p.vy + GRAVITY * frames);
        p.y += p.vy * frames;
      }

      if (p.invuln > 0) p.invuln -= frames;
      if (p.flashTimer > 0) p.flashTimer -= frames;
      if (p.invincibleTimer > 0) p.invincibleTimer -= frames;

      if (p.invuln <= 0 && p.invincibleTimer <= 0) {
        for (const o of fg.obstacles) {
          const cw = o.w * OBSTACLE_HITBOX_SCALE, ch = o.h * OBSTACLE_HITBOX_SCALE;
          const overlap = playerHitRight(p) > o.x - cw / 2 && playerHitLeft(p) < o.x + cw / 2 &&
                           p.y + PLAYER_H > o.y - ch / 2 && p.y < o.y + ch / 2;
          if (overlap) {
            loseLife(p);
            p.invuln = 50;
            p.flashTimer = 50;
            fg.screenFlash = Math.max(fg.screenFlash, 0.45);
            fg.hitEffects.push({ x: p.x + PLAYER_W / 2, y: p.y + PLAYER_H / 2, timer: 18, maxTimer: 18 });
            break;
          }
        }
      }

      if (!p.eliminated && p.invuln <= 0 && p.invincibleTimer <= 0) {
        for (const bh of fg.bigHazards) {
          if (bh.state !== 'rising') continue;
          const overlapX = playerHitRight(p) > bh.x && playerHitLeft(p) < bh.x + bh.w;
          const overlapY = p.y + PLAYER_H > bh.y - BIG_HAZARD_HEIGHT / 2 && p.y < bh.y + BIG_HAZARD_HEIGHT / 2;
          if (overlapX && overlapY) {
            loseLife(p);
            if (!p.eliminated) {
              const dir = (p.x + PLAYER_W / 2) < (bh.x + bh.w / 2) ? -1 : 1;
              p.kbVX = dir * PUSH_FORCE * 1.8;
              p.vy = -10;
              p.invuln = 70;
              p.flashTimer = 70;
              fg.screenFlash = Math.max(fg.screenFlash, 0.8);
            }
            break;
          }
        }
      }

      for (let i = fg.items.length - 1; i >= 0; i--) {
        const it = fg.items[i];
        const overlap = playerHitRight(p) > it.x - it.r && playerHitLeft(p) < it.x + it.r &&
                         p.y + PLAYER_H > it.y - it.r && p.y < it.y + it.r;
        if (overlap) {
          if (it.type === 'star') {
            p.invincibleTimer = STAR_DURATION;
            SFX.ding();
          } else if (it.type === 'fake') {
            loseLife(p);
            p.invuln = 40;
            p.flashTimer = 40;
            fg.screenFlash = Math.max(fg.screenFlash, 0.5);
            fg.hitEffects.push({ x: p.x + PLAYER_W / 2, y: p.y + PLAYER_H / 2, timer: 18, maxTimer: 18 });
          } else {
            if (p.lives < fg.maxLives) p.lives += 1;
            SFX.ding();
          }
          fg.items.splice(i, 1);
        }
      }

      if (p.y > H + 20) fallOff(p);
    }

    resolveStomps();

    if (checkEndConditions(globalState)) return;
    fg.timeLeft -= dt;
    if (fg.timeLeft <= 0) { fg.timeLeft = 0; finishMatch(globalState); }
  },

  draw(ctx, w, h) {
    if (!fg) return;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const scale = Math.min(w / W, h / H);
    ctx.save();
    ctx.translate((w - W * scale) / 2, (h - H * scale) / 2);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    drawBackground(ctx);

    for (const bp of fg.bgParticles) {
      ctx.fillStyle = `rgba(190,200,225,${bp.alpha})`;
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, bp.size, 0, Math.PI * 2);
      ctx.fill();
    }

    const spacing = 40;
    const off = fg.scrollOffset % spacing;
    ctx.strokeStyle = 'rgba(120,130,160,0.25)';
    ctx.lineWidth = 1;
    for (let side = 0; side < 2; side++) {
      const bx = side === 0 ? 0 : W - 30;
      ctx.fillStyle = 'rgba(40,46,66,0.6)';
      ctx.fillRect(bx, 0, 30, H);
      for (let y = -spacing + off; y < H; y += spacing) {
        ctx.beginPath();
        ctx.moveTo(bx, y);
        ctx.lineTo(bx + 30, y);
        ctx.stroke();
      }
    }

    for (const piece of fg.pieces) drawPlatformPiece(ctx, piece, pieceEffY(piece));

    if (fg.phase === 'permanentWarning' && fg.crackPlan) {
      const flick = Math.floor(fg.t * 10) % 2 === 0;
      if (flick) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        for (let i = 1; i < fg.crackPlan.length; i++) {
          const gapStart = fg.crackPlan[i - 1].x + fg.crackPlan[i - 1].w;
          const gapEnd = fg.crackPlan[i].x;
          ctx.fillRect(gapStart, PLATFORM_Y - 6, gapEnd - gapStart, 28);
        }
      }
      ctx.fillStyle = flick ? 'rgba(255,110,110,0.95)' : 'rgba(255,110,110,0.5)';
      ctx.font = 'bold 15px "Noto Sans TC", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚠ 平台即將斷裂!', W / 2, PLATFORM_Y - 30);
    }

    for (const o of fg.obstacles) drawImageSafe(ctx, obsSmallImg, o.x - o.w / 2, o.y - o.h / 2, o.w, o.h);

    for (const it of fg.items) {
      if (it.type === 'fake') drawFakeItem(ctx, it.x, it.y, it.r);
      else {
        const img = it.type === 'star' ? starImg : gemImg;
        drawImageSafe(ctx, img, it.x - it.r, it.y - it.r, it.r * 2, it.r * 2);
      }
    }

    for (const bh of fg.bigHazards) {
      if (bh.state === 'warn') {
        const flick = Math.floor(fg.t * 14) % 2 === 0;
        ctx.fillStyle = flick ? 'rgba(255,60,60,0.35)' : 'rgba(255,60,60,0.15)';
        ctx.fillRect(bh.x, 0, bh.w, H);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        ctx.strokeRect(bh.x, 0, bh.w, H);
        ctx.setLineDash([]);
      } else if (bh.state === 'rising') {
        const top = bh.y - BIG_HAZARD_HEIGHT / 2;
        drawImageSafe(ctx, obsBigImg, bh.x, top, bh.w, BIG_HAZARD_HEIGHT);
      }
    }

    for (const p of fg.players) drawPlayer(ctx, p);

    for (const he of fg.hitEffects) {
      const progress = 1 - he.timer / he.maxTimer;
      const r = 10 + progress * 32;
      const alpha = 1 - progress;
      ctx.strokeStyle = `rgba(255,170,60,${alpha})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(he.x, he.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (fg.screenFlash > 0) {
      ctx.fillStyle = `rgba(230,40,45,${fg.screenFlash * 0.35})`;
      ctx.fillRect(0, 0, W, H);
    }

    drawUI(ctx);

    ctx.restore();
  },

  onInput(deviceId, data) {
    if (!fg) return;
    const did = String(deviceId);
    const p = fg.players.find(pl => pl.deviceId !== null && String(pl.deviceId) === did);
    if (!p) return;

    if (data.action === 'move') p.ctrl.dx = data.dx ?? 0;
    else if (data.action === 'jump') p.ctrl.jumpHeld = !!data.pressed;
  },

  onEnd() {
    bgm.stop();
    fg = null;
  },
};
