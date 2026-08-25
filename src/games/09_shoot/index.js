/**
 * 噴槍佔地 — 2v2 territory-painting battle ported from shoot-main/index.html
 *
 * Red vs blue, 2 per team (playersPerTeam: 2); requireFullTeams means both
 * sides always field exactly 2 real players before the match can start.
 * Moving around continuously paints a radius of the floor in your own color;
 * grabbing yellow energy pickups builds a charge meter (slower on your own
 * territory, faster the later the match gets) that auto-detonates 3s after
 * filling, painting a huge radius at your current position. Dash (held
 * button) shoves people aside, or — only against opponents — cancels their
 * charge and stuns them if they're mid-detonation, a defensive counter-play.
 * Periodic "black spray" events neutralize a cluster of territory regardless
 * of owner. At 60s, whichever team holds more combined territory wins.
 *
 * Physics runs in a fixed logical space (720x450) so tuning is independent
 * of the screen resolution; draw() uniform-scales + letterboxes into the
 * actual canvas.
 */
import { truncateName } from '../../shared/nameDisplay.js';
import { preloadImages, drawAssetLoadingPlaceholder } from '../../shared/assetPreload.js';
import { bgm, SFX } from './audio.js';

const W = 720, H = 450;
const CELL = 10;
const COLS = Math.floor(W / CELL);
const ROWS = Math.floor(H / CELL);
const NEUTRAL = -1;

const MATCH_TIME = 60;
const MAX_CHARGE = 100;
const CHARGE_COUNTDOWN = 3.0; // 秒,蓄滿後倒數,結束時自動引爆(不需操作)
const DASH_COOLDOWN = 1.1;
const DASH_DURATION = 0.14;
const DASH_SPEED = 700;
const NORMAL_SPEED = 190;
const STUN_DURATION = 0.45;
const PLAYER_RADIUS = 24;
const PAINT_RADIUS = 24;
const EXPLODE_RADIUS = 150;
const PICKUP_RADIUS = 15;
const PICKUP_COUNT = 6;
const PICKUP_RESPAWN_DELAY = 3.5;
const PICKUP_GAIN_NEUTRAL = 26;
const PICKUP_GAIN_OWN = 12; // 在自己地盤上吸收效率打折
const PICKUP_GAIN_RAMP_MAX = 1.8; // 比賽後期能量點效率的最高倍率(開局=1倍,比賽結束時=此倍率)

// 隨機黑色噴霧事件:每隔一段時間,連續在地圖上噴出 3~4 個黑色範圍(依序噴、不是同時),
// 範圍內所有玩家的地盤會被清空為中立(不歸屬任何人)
const BLACK_SPRAY_MIN_INTERVAL = 14;
const BLACK_SPRAY_MAX_INTERVAL = 22;
const BLACK_SPRAY_RADIUS = 65;
const BLACK_SPRAY_MIN_COUNT = 3;
const BLACK_SPRAY_MAX_COUNT = 4;
const BLACK_SPRAY_GAP = 0.18;
const BLACK_SPRAY_CLUSTER_SPREAD = 150;
const BLACK_SPRAY_DISABLE_LAST = 10;
const BLACK_SPRAY_WARNING_DURATION = 1.3;

const FINAL_COUNTDOWN_START = 20;

const NOZZLE_BASE_ANGLE = -Math.PI / 4; // 角色圖預設噴嘴朝向(右上約45度),旋轉時需扣除此偏移量
const PLAYER_SHADE = [1.15, 0.7, 1.15, 0.7]; // 同隊第一位偏白、第二位偏深,方便區分隊友

const TEAM_UI = {
  red:  { label: '紅隊', text: '#ff8080', barFill: '#e94057' },
  blue: { label: '藍隊', text: '#80c0ff', barFill: '#3fa9f5' },
};
const SLOT_DEFS = [
  { team: 'red',  spriteKey: 'red'  },
  { team: 'red',  spriteKey: 'red'  },
  { team: 'blue', spriteKey: 'blue' },
  { team: 'blue', spriteKey: 'blue' },
];
const START_POSITIONS = [
  { x: 85,     y: 75 },
  { x: W - 85, y: 75 },
  { x: 85,     y: H - 75 },
  { x: W - 85, y: H - 75 },
];

function loadImage(path) {
  const img = new Image();
  img.src = path;
  return img;
}
const bgImg = loadImage('09_shoot/background.png');
const SPRAY_IMAGES = {
  red:  loadImage('09_shoot/player/spray1.png'),
  blue: loadImage('09_shoot/player/spray2.png'),
};
const SHOOT_IMAGES = [bgImg, SPRAY_IMAGES.red, SPRAY_IMAGES.blue];

function createGrainOverlay() {
  const noise = document.createElement('canvas');
  noise.width = W; noise.height = H;
  const nctx = noise.getContext('2d');
  for (let i = 0; i < 2600; i++) {
    const nx = Math.random() * W, ny = Math.random() * H;
    const shade = Math.random() < 0.5 ? 0 : 255;
    nctx.fillStyle = `rgba(${shade},${shade},${shade},${(0.03 + Math.random() * 0.05).toFixed(3)})`;
    nctx.fillRect(nx, ny, 1, 1);
  }
  return noise;
}
const grainOverlay = createGrainOverlay();

function cellNoise(cx, cy) {
  // 依格子座標算出固定的偽隨機值(0~1),讓地盤色塊有噴漆濃淡不均的質感,而不是每幀閃爍
  const v = Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

let sg = null; // module-level shoot-game state

function gridIndex(cx, cy) { return cy * COLS + cx; }

function paintAt(px, py, radius, owner) {
  const cx0 = Math.max(0, Math.floor((px - radius) / CELL));
  const cx1 = Math.min(COLS - 1, Math.floor((px + radius) / CELL));
  const cy0 = Math.max(0, Math.floor((py - radius) / CELL));
  const cy1 = Math.min(ROWS - 1, Math.floor((py + radius) / CELL));
  const r2 = radius * radius;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const ccx = cx * CELL + CELL / 2, ccy = cy * CELL + CELL / 2;
      const dx = ccx - px, dy = ccy - py;
      if (dx * dx + dy * dy <= r2) sg.grid[gridIndex(cx, cy)] = owner;
    }
  }
}

function ownerAt(px, py) {
  const cx = Math.min(COLS - 1, Math.max(0, Math.floor(px / CELL)));
  const cy = Math.min(ROWS - 1, Math.max(0, Math.floor(py / CELL)));
  return sg.grid[gridIndex(cx, cy)];
}

function pickupGainMultiplier() {
  const progress = 1 - (sg.timeLeft / MATCH_TIME);
  return 1 + progress * (PICKUP_GAIN_RAMP_MAX - 1);
}

function makePlayer(def, slot, x, y, deviceId, name) {
  return {
    ...def,
    slot, deviceId, name,
    x, y,
    dirX: 0, dirY: -1,
    charge: 0,
    charging: false,
    chargeCountdown: 0,
    dashCooldown: 0,
    dashActive: false,
    dashTimer: 0,
    dashHitSlots: new Set(),
    stunTimer: 0,
    isMoving: false,
    sprayEmitTimer: 0,
    trail: [],
    ctrl: { dx: 0, dy: 0, dashHeld: false },
  };
}

function spawnPickup() {
  sg.pickups.push({
    x: 30 + Math.random() * (W - 60),
    y: 30 + Math.random() * (H - 60),
    active: true,
    respawnTimer: 0,
  });
}

function triggerDash(p) {
  p.dashActive = true;
  p.dashTimer = DASH_DURATION;
  p.dashCooldown = DASH_COOLDOWN;
  p.dashHitSlots = new Set();
}

function updateDash(p, dt) {
  if (!p.dashActive) return;
  p.dashTimer -= dt;
  p.trail.push({ x: p.x, y: p.y, life: 1 });
  if (p.trail.length > 8) p.trail.shift();
  p.x += p.dirX * DASH_SPEED * dt;
  p.y += p.dirY * DASH_SPEED * dt;
  if (p.dashTimer <= 0) p.dashActive = false;
}

// 只對「對手」有效 — 原型說明文字寫的是撞對手,但程式碼漏了隊伍檢查,連自己
// 隊友都會被撞飛/清零蓄能,移植時順手補上。
function checkDashCollisions() {
  for (const p of sg.players) {
    if (!p.dashActive) continue;
    for (const other of sg.players) {
      if (other === p || other.team === p.team) continue;
      if (p.dashHitSlots.has(other.slot)) continue;
      const d = Math.hypot(p.x - other.x, p.y - other.y);
      if (d < PLAYER_RADIUS + PLAYER_RADIUS + 4) {
        p.dashHitSlots.add(other.slot);
        if (other.charging) {
          SFX.punch();
          other.charging = false;
          other.charge = 0;
          other.chargeCountdown = 0;
          other.stunTimer = STUN_DURATION;
          vibrate(other);
        } else {
          const dx = other.x - p.x, dy = other.y - p.y;
          const dist = Math.max(1, Math.hypot(dx, dy));
          other.x += (dx / dist) * 18;
          other.y += (dy / dist) * 18;
        }
      }
    }
  }
}

function spawnExplosionFX(x, y, team) {
  SFX.pop();
  sg.fx.push({ x, y, r: 6, maxR: EXPLODE_RADIUS + 25, team, alpha: 1, ring: 0 });
  sg.fx.push({ x, y, r: 6, maxR: EXPLODE_RADIUS - 20, team, alpha: 1, ring: 1 });
  sg.fx.push({ x, y, type: 'flash', r: 10, maxR: EXPLODE_RADIUS + 40, team, alpha: 0.9 });
  const count = 34;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.3;
    const speed = 180 + Math.random() * 320;
    sg.particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      size: 3 + Math.random() * 5,
      team,
    });
  }
  sg.screenShake = 0.35;
}

function triggerBlackSpray(x, y) {
  SFX.boom();
  paintAt(x, y, BLACK_SPRAY_RADIUS, NEUTRAL);
  sg.blackSplats.push({ x, y, r: BLACK_SPRAY_RADIUS, alpha: 0.85 });
  const count = 26;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.3;
    const speed = 120 + Math.random() * 220;
    sg.particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      size: 3 + Math.random() * 4,
      team: 'black',
    });
  }
  sg.screenShake = Math.max(sg.screenShake, 0.2);
}

function updatePickups(p, dt) {
  for (const pk of sg.pickups) {
    if (!pk.active) continue;
    const d = Math.hypot(pk.x - p.x, pk.y - p.y);
    if (d < PICKUP_RADIUS + PLAYER_RADIUS) {
      pk.active = false;
      pk.respawnTimer = PICKUP_RESPAWN_DELAY;
      SFX.ding();
      if (!p.charging) {
        const own = ownerAt(p.x, p.y) === p.slot;
        const mult = pickupGainMultiplier();
        p.charge += (own ? PICKUP_GAIN_OWN : PICKUP_GAIN_NEUTRAL) * mult;
        if (p.charge >= MAX_CHARGE) {
          p.charge = MAX_CHARGE;
          p.charging = true;
          p.chargeCountdown = CHARGE_COUNTDOWN;
        }
      }
    }
  }
}

function clampPos(p) {
  p.x = Math.max(PLAYER_RADIUS, Math.min(W - PLAYER_RADIUS, p.x));
  p.y = Math.max(PLAYER_RADIUS, Math.min(H - PLAYER_RADIUS, p.y));
}

function computePercentages() {
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < sg.grid.length; i++) {
    const o = sg.grid[i];
    if (o >= 0) counts[o]++;
  }
  return counts.map(c => (c / sg.cellCount) * 100);
}

function teamPercentages() {
  const pct = computePercentages();
  const teamPct = { red: 0, blue: 0 };
  sg.players.forEach((p, i) => { teamPct[p.team] += pct[i]; });
  return { pct, teamPct };
}

function vibrate(p) {
  if (!p.deviceId) return;
  const gs = sg?._globalState;
  if (!gs) return;
  if (!gs._pendingMessages) gs._pendingMessages = [];
  gs._pendingMessages.push({ type: 'hit_confirm', deviceId: String(p.deviceId) });
}

function _finish(globalState) {
  if (!sg || sg.done) return;
  sg.done = true;

  const { pct, teamPct } = teamPercentages();
  for (const p of sg.players) {
    if (!p.deviceId || !globalState.players?.[p.deviceId]) continue;
    globalState.players[p.deviceId].score =
      (globalState.players[p.deviceId].score || 0) + Math.round(pct[p.slot]);
  }

  const winnerTeam = teamPct.red === teamPct.blue ? null : (teamPct.red > teamPct.blue ? 'red' : 'blue');
  sg._endCb?.(winnerTeam, {
    label: '佔地率',
    red: `${teamPct.red.toFixed(1)}%`,
    blue: `${teamPct.blue.toFixed(1)}%`,
  });
}

// --- 繪製 ---------------------------------------------------------------------

function drawPlayer(ctx, p) {
  ctx.save();
  if (p.stunTimer > 0) ctx.translate((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4);

  ctx.save();
  ctx.translate(p.x, p.y);
  const angle = Math.atan2(p.dirY, p.dirX);
  ctx.rotate(angle - NOZZLE_BASE_ANGLE);

  let stretch = 1, squash = 1;
  if (p.dashActive) { stretch = 1.35; squash = 0.78; }
  else if (p.isMoving) { stretch = 1.12; squash = 0.92; }
  let pulse = 1;
  if (p.charging) pulse = 1 + 0.05 * Math.sin(Date.now() / 120);
  ctx.scale(stretch * pulse, squash * pulse);

  const sprite = SPRAY_IMAGES[p.spriteKey];
  const spriteSize = PLAYER_RADIUS * 3.2;
  if (sprite.complete && sprite.naturalWidth > 0) {
    ctx.filter = `brightness(${PLAYER_SHADE[p.slot]})`;
    ctx.drawImage(sprite, -spriteSize / 2, -spriteSize / 2, spriteSize, spriteSize);
    ctx.filter = 'none';
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = TEAM_UI[p.team].barFill;
    ctx.fill();
  }
  ctx.restore();

  ctx.translate(p.x, p.y);
  if (p.charging) {
    const ringPulse = 3 + Math.sin(Date.now() / 80) * 3;
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_RADIUS + 7 + ringPulse, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  if (p.stunTimer > 0) {
    ctx.font = '14px sans-serif';
    ctx.fillText('💫', -8, -18);
  }
  ctx.font = 'bold 11px "Noto Sans TC", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 3;
  ctx.fillText(p.name, 0, -PLAYER_RADIUS - 8);
  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawUI(ctx) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, W, 46);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`${Math.ceil(sg.timeLeft)}`, W / 2, 6);

  const { teamPct } = teamPercentages();

  ctx.font = "bold 12px 'Noto Sans TC', sans-serif";
  ctx.textAlign = 'left';
  ctx.fillStyle = TEAM_UI.red.text;
  ctx.fillText(`${TEAM_UI.red.label}  ${teamPct.red.toFixed(1)}%`, 12, 4);
  ctx.textAlign = 'right';
  ctx.fillStyle = TEAM_UI.blue.text;
  ctx.fillText(`${teamPct.blue.toFixed(1)}%  ${TEAM_UI.blue.label}`, W - 12, 4);

  // 拔河推拉條 — 以「紅佔地 /(紅佔地+藍佔地)」當拉繩比例,忽略中立區(黑色噴霧
  // 清空的地盤不算在拉扯裡),平手或都還沒佔地時指針停在正中央,哪隊佔地明顯
  // 領先就把指針往那隊推過去,直接呈現「誰目前拉贏誰」而不是各自的絕對佔比。
  const barW = 300, barH = 12;
  const barX = W / 2 - barW / 2, barY = 29;
  const contested = teamPct.red + teamPct.blue;
  const frac = contested > 0 ? teamPct.red / contested : 0.5;
  const splitX = barX + barW * frac;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, barH, barH / 2);
  ctx.clip();
  ctx.fillStyle = TEAM_UI.red.barFill;
  ctx.fillRect(barX, barY, splitX - barX, barH);
  ctx.fillStyle = TEAM_UI.blue.barFill;
  ctx.fillRect(splitX, barY, barX + barW - splitX, barH);
  ctx.restore();

  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, barH, barH / 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 50/50 中線參考
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(W / 2, barY - 3);
  ctx.lineTo(W / 2, barY + barH + 3);
  ctx.stroke();

  // 領先指針 — 白色小三角形,指向目前拉繩位置
  ctx.beginPath();
  ctx.moveTo(splitX - 6, barY - 8);
  ctx.lineTo(splitX + 6, barY - 8);
  ctx.lineTo(splitX, barY - 1);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.fill();

  if (sg.timeLeft <= FINAL_COUNTDOWN_START) {
    const flashPulse = 0.14 + Math.sin(Date.now() / 220) * 0.07;
    ctx.globalAlpha = Math.max(0, flashPulse);
    ctx.strokeStyle = '#ff4d5e';
    ctx.lineWidth = 14;
    ctx.strokeRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

// --- game module ------------------------------------------------------------

export default {
  id: 'shoot',
  name: '噴槍佔地',
  description: '2v2 佔地對決，移動噴漆搶地盤！',
  playersPerTeam: 2,
  requireFullTeams: true,
  color: '#e94057',
  emoji: '🎨',
  cover: '09_shoot/shoot_cover.png',

  tutorial: {
    pages: [
      '09_shoot/tutorial/1.png',
      '09_shoot/tutorial/2.png',
      '09_shoot/tutorial/3.png',
      '09_shoot/tutorial/4.png',
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
      const pos = START_POSITIONS[i];
      return makePlayer(def, i, pos.x, pos.y, deviceId, name);
    });

    sg = {
      grid: new Int8Array(COLS * ROWS).fill(NEUTRAL),
      cellCount: COLS * ROWS,
      players,
      pickups: [],
      fx: [],
      particles: [],
      blackSplats: [],
      screenShake: 0,
      timeLeft: MATCH_TIME,
      done: false,
      blackSprayTimer: BLACK_SPRAY_MIN_INTERVAL + Math.random() * (BLACK_SPRAY_MAX_INTERVAL - BLACK_SPRAY_MIN_INTERVAL),
      blackSpraySequence: null,
      blackSprayWarning: null,
      assetsReady: false,
      _endCb: endCb,
      _globalState: globalState,
    };
    for (let i = 0; i < PICKUP_COUNT; i++) spawnPickup();

    bgm.start();
    preloadImages(SHOOT_IMAGES).then(() => { if (sg) sg.assetsReady = true; });
  },

  preload() {
    return preloadImages(SHOOT_IMAGES);
  },

  update(dt, globalState) {
    if (!sg || sg.done || !sg.assetsReady) return;

    sg.timeLeft -= dt;
    if (sg.timeLeft <= 0) { sg.timeLeft = 0; _finish(globalState); return; }

    // 黑色噴霧事件:倒數 -> 警告預告 -> 一波連續噴發(3~4 個點,依序噴出)
    if (sg.blackSprayWarning) {
      sg.blackSprayWarning.timer -= dt;
      if (sg.blackSprayWarning.timer <= 0) {
        sg.blackSpraySequence = { points: sg.blackSprayWarning.points, index: 0, timer: 0 };
        sg.blackSprayWarning = null;
      }
    } else if (!sg.blackSpraySequence) {
      sg.blackSprayTimer -= dt;
      if (sg.blackSprayTimer <= 0 && sg.timeLeft > BLACK_SPRAY_DISABLE_LAST) {
        const count = BLACK_SPRAY_MIN_COUNT + Math.floor(Math.random() * (BLACK_SPRAY_MAX_COUNT - BLACK_SPRAY_MIN_COUNT + 1));
        const centerX = 60 + Math.random() * (W - 120);
        const centerY = 60 + Math.random() * (H - 120);
        const points = [];
        for (let i = 0; i < count; i++) {
          points.push({
            x: Math.max(30, Math.min(W - 30, centerX + (Math.random() - 0.5) * BLACK_SPRAY_CLUSTER_SPREAD * 2)),
            y: Math.max(30, Math.min(H - 30, centerY + (Math.random() - 0.5) * BLACK_SPRAY_CLUSTER_SPREAD * 2)),
          });
        }
        sg.blackSprayWarning = { points, timer: BLACK_SPRAY_WARNING_DURATION };
      }
    } else {
      sg.blackSpraySequence.timer -= dt;
      if (sg.blackSpraySequence.timer <= 0) {
        const pt = sg.blackSpraySequence.points[sg.blackSpraySequence.index];
        triggerBlackSpray(pt.x, pt.y);
        sg.blackSpraySequence.index++;
        sg.blackSpraySequence.timer = BLACK_SPRAY_GAP;
        if (sg.blackSpraySequence.index >= sg.blackSpraySequence.points.length) {
          sg.blackSpraySequence = null;
          sg.blackSprayTimer = BLACK_SPRAY_MIN_INTERVAL + Math.random() * (BLACK_SPRAY_MAX_INTERVAL - BLACK_SPRAY_MIN_INTERVAL);
        }
      }
    }
    for (let i = sg.blackSplats.length - 1; i >= 0; i--) {
      sg.blackSplats[i].alpha -= dt * 0.5;
      if (sg.blackSplats[i].alpha <= 0) sg.blackSplats.splice(i, 1);
    }

    // 能量點重生(取代原型的 setTimeout,改成跟著遊戲時間走)
    for (const pk of sg.pickups) {
      if (pk.active) continue;
      pk.respawnTimer -= dt;
      if (pk.respawnTimer <= 0) {
        pk.active = true;
        pk.x = 30 + Math.random() * (W - 60);
        pk.y = 30 + Math.random() * (H - 60);
      }
    }

    for (const p of sg.players) {
      if (p.stunTimer > 0) p.stunTimer -= dt;
      if (p.dashCooldown > 0) p.dashCooldown -= dt;
      for (let i = p.trail.length - 1; i >= 0; i--) {
        p.trail[i].life -= dt * 4;
        if (p.trail[i].life <= 0) p.trail.splice(i, 1);
      }

      if (p.charging) {
        p.chargeCountdown -= dt;
        if (p.chargeCountdown <= 0) {
          paintAt(p.x, p.y, EXPLODE_RADIUS, p.slot);
          p.charging = false;
          p.charge = 0;
          p.chargeCountdown = 0;
          spawnExplosionFX(p.x, p.y, p.team);
        }
      }

      const stunned = p.stunTimer > 0;
      if (!stunned) {
        const dx = p.ctrl.dx ?? 0, dy = p.ctrl.dy ?? 0;
        const len = Math.hypot(dx, dy);
        p.isMoving = len > 0.05;
        if (len > 0.05) {
          p.dirX = dx / len; p.dirY = dy / len;
          if (!p.dashActive) {
            p.x += dx * NORMAL_SPEED * dt;
            p.y += dy * NORMAL_SPEED * dt;
          }
        }
        if (p.ctrl.dashHeld && p.dashCooldown <= 0) triggerDash(p);
      }
      updateDash(p, dt);
      clampPos(p);

      if (!stunned) {
        paintAt(p.x, p.y, PAINT_RADIUS, p.slot);
        updatePickups(p, dt);
        if (p.isMoving || p.dashActive) {
          p.sprayEmitTimer -= dt;
          if (p.sprayEmitTimer <= 0) {
            p.sprayEmitTimer = p.dashActive ? 0.02 : 0.05;
            const backX = -p.dirX, backY = -p.dirY;
            const spread = 0.6;
            const spAngle = Math.atan2(backY, backX) + (Math.random() - 0.5) * spread;
            const speed = 30 + Math.random() * 50;
            sg.particles.push({
              x: p.x - p.dirX * PLAYER_RADIUS * 0.6,
              y: p.y - p.dirY * PLAYER_RADIUS * 0.6,
              vx: Math.cos(spAngle) * speed,
              vy: Math.sin(spAngle) * speed,
              life: 0.6,
              size: 2 + Math.random() * 2.5,
              team: p.team,
            });
          }
        }
      }
    }
    checkDashCollisions();

    for (let i = sg.fx.length - 1; i >= 0; i--) {
      const f = sg.fx[i];
      if (f.type === 'flash') {
        f.r += (f.maxR - f.r) * 0.4 + 4;
        f.alpha -= 0.12;
      } else {
        f.r += (f.maxR - f.r) * 0.22 + 3;
        f.alpha -= 0.045;
      }
      if (f.alpha <= 0) sg.fx.splice(i, 1);
    }

    for (let i = sg.particles.length - 1; i >= 0; i--) {
      const pt = sg.particles[i];
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vx *= 0.9;
      pt.vy *= 0.9;
      pt.life -= dt * 1.8;
      if (pt.life <= 0) sg.particles.splice(i, 1);
    }

    if (sg.screenShake > 0) sg.screenShake -= dt;
  },

  draw(ctx, w, h) {
    if (!sg) return;
    if (!sg.assetsReady) { drawAssetLoadingPlaceholder(ctx, w, h, '噴槍佔地'); return; }

    ctx.fillStyle = '#1e2128';
    ctx.fillRect(0, 0, w, h);
    const scale = Math.min(w / W, h / H);
    ctx.save();
    ctx.translate((w - W * scale) / 2, (h - H * scale) / 2);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    if (sg.screenShake > 0) {
      const mag = 9 * (sg.screenShake / 0.35);
      ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
    }

    if (bgImg.complete && bgImg.naturalWidth > 0) {
      ctx.globalAlpha = 0.8;
      ctx.drawImage(bgImg, 0, 0, W, H);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = '#1e2128';
      ctx.fillRect(0, 0, W, H);
    }

    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        const o = sg.grid[gridIndex(cx, cy)];
        if (o < 0) continue;
        ctx.fillStyle = TEAM_UI[sg.players[o].team].barFill;
        ctx.globalAlpha = 0.46 + cellNoise(cx, cy) * 0.22;
        ctx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
        ctx.globalAlpha = 1;
      }
    }

    for (const pk of sg.pickups) {
      if (!pk.active) continue;
      ctx.beginPath();
      ctx.ellipse(pk.x, pk.y + PICKUP_RADIUS * 0.55, PICKUP_RADIUS * 0.85, PICKUP_RADIUS * 0.4, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fill();

      const pulse = 1 + Math.sin(Date.now() / 200) * 0.15;
      const r = PICKUP_RADIUS * pulse;

      ctx.save();
      ctx.shadowColor = 'rgba(255, 215, 0, 0.8)';
      ctx.shadowBlur = 15;
      ctx.beginPath();
      ctx.arc(pk.x, pk.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#FFD700';
      ctx.fill();
      ctx.restore();
    }

    for (const b of sg.blackSplats) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = '#0a0a0d';
      ctx.globalAlpha = Math.max(0, b.alpha) * 0.7;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    if (sg.blackSprayWarning) {
      const pulse = 0.55 + Math.sin(Date.now() / 100) * 0.35;
      ctx.save();
      ctx.setLineDash([7, 7]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ff4d5e';
      for (const pt of sg.blackSprayWarning.points) {
        ctx.globalAlpha = Math.max(0.2, pulse);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, BLACK_SPRAY_RADIUS, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    for (const f of sg.fx) {
      if (f.type === 'flash') {
        const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r);
        grad.addColorStop(0, 'rgba(255,255,255,' + Math.max(0, f.alpha) + ')');
        grad.addColorStop(0.4, TEAM_UI[f.team].barFill);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = Math.max(0, f.alpha) * 0.8;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.strokeStyle = TEAM_UI[f.team].barFill;
        ctx.globalAlpha = Math.max(0, f.alpha);
        ctx.lineWidth = f.ring === 0 ? 7 : 3;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    for (const pt of sg.particles) {
      ctx.beginPath();
      ctx.globalAlpha = Math.max(0, pt.life);
      ctx.fillStyle = pt.team === 'black' ? '#15161a' : TEAM_UI[pt.team].barFill;
      ctx.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
      ctx.globalAlpha = 1;
    }

    for (const p of sg.players) {
      for (const t of p.trail) {
        ctx.beginPath();
        ctx.arc(t.x, t.y, PLAYER_RADIUS * Math.max(0.2, t.life), 0, Math.PI * 2);
        ctx.fillStyle = TEAM_UI[p.team].barFill;
        ctx.globalAlpha = Math.max(0, t.life) * 0.3;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    const { teamPct } = teamPercentages();
    const leaderTeam = teamPct.red === teamPct.blue ? null : (teamPct.red > teamPct.blue ? 'red' : 'blue');
    for (const p of sg.players) {
      drawPlayer(ctx, p);
      if (p.team === leaderTeam) {
        ctx.save();
        ctx.font = '18px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('👑', p.x, p.y - PLAYER_RADIUS - 26);
        ctx.restore();
      }
    }

    if (grainOverlay) ctx.drawImage(grainOverlay, 0, 0);

    drawUI(ctx);

    ctx.restore();
  },

  onInput(deviceId, data) {
    if (!sg) return;
    const did = String(deviceId);
    const p = sg.players.find(pl => pl.deviceId !== null && String(pl.deviceId) === did);
    if (!p) return;

    if (data.action === 'move') {
      p.ctrl.dx = data.dx ?? 0;
      p.ctrl.dy = data.dy ?? 0;
    } else if (data.action === 'dash') {
      p.ctrl.dashHeld = !!data.pressed;
    }
  },

  onEnd() {
    bgm.stop();
    sg = null;
  },
};
