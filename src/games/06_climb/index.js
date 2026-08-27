/**
 * 爬高派對 — 3v3 vertical climbing race ported from climb/index.html
 *
 * Red vs blue, 3 per team (playersPerTeam: 3); requireFullTeams means both
 * sides always field exactly 3 real players before the match can start. The
 * camera force-scrolls upward and zooms out to keep everyone framed; falling
 * below the screen (into the poison fog) eliminates you for good — no
 * respawns. A full team wipe ends
 * the match immediately, otherwise at 90s the team with fewer deaths wins,
 * ties broken by the higher team-best height.
 *
 * Physics runs in a fixed logical space (1280x720) so tuning is independent
 * of the screen resolution; draw() uniform-scales + letterboxes into the
 * actual canvas.
 */
import { truncateName } from '../../shared/nameDisplay.js';
import { preloadImages, drawAssetLoadingPlaceholder } from '../../shared/assetPreload.js';
import { bgm, SFX } from './audio.js';

const CANVAS_W = 1280;
const CANVAS_H = 720;

const GRAVITY = 1800;             // px/s^2
const MOVE_ACCEL = 3200;
const MAX_MOVE_SPEED = 340;
const FRICTION = 2600;
const JUMP_VELOCITY = -820;       // 最大跳躍上升高度 ~198px
const STOMP_BONUS_VELOCITY = -1020; // 借力跳:上升高度 ~438px,比一般跳躍高超過 2 倍
const STOMP_VICTIM_STUN = 0.6;

const PUSH_RANGE_X = 78;
const PUSH_RANGE_Y = 64;
const PUSH_FORCE_X = 620;
const PUSH_FORCE_Y = 340;            // 額外往下的衝量
const PUSH_SELF_LOCK = 0.45;         // 推人者自身定身時間
const PUSH_COOLDOWN = 1.0;           // 推人冷卻,避免無成本連續推人
const PUSH_KNOCKBACK_DURATION = 0.4; // 被推飛期間無法主動移動,速度不受一般上限限制
const PUSH_FLASH_DURATION = 0.4;     // 被推之後的閃動回饋時間
const PUSH_IMPACT_DURATION = 0.2;    // 被推當下的衝擊圈動畫時間

const HAZARD_STUN_DURATION = 1.1;

const CONVEYOR_SPEED = 160;   // 輸送帶額外帶動玩家的速度(px/s)
const ICE_FRICTION = 350;     // 濕地摩擦力,遠低於一般的 FRICTION,滑動感明顯
const ICE_ACCEL_MULT = 0.65;  // 濕地上加速也打折,更難即時煞停/轉向

const OFFSCREEN_BUFFER = 60;  // 甩出鏡頭底部多少緩衝距離才開始計時
const ELIMINATION_GRACE = 0.7; // 緩衝時間(秒)才判定淘汰
const TIME_LIMIT = 90;         // 秒
const CHUNK_HEIGHT = 800;
const START_HEIGHT = 100;

const PLAYER_W = 34, PLAYER_H = 46;

const CAMERA_SMOOTH = 5;
const CAMERA_SPEED_BASE = 54;
const CAMERA_SPEED_GROW = 1.07;
const CAMERA_SPEED_CAP = 150;
const CAMERA_ZOOM_MIN = 0.55;      // 最多縮小到 55%,距離拉太開時仍看得清楚
const CAMERA_FRAME_MARGIN_PX = 90; // 最高/最矮兩端在螢幕上下各留的邊界像素

const OBSTACLE_BOUNCE_X = 560;
const OBSTACLE_BOUNCE_Y = 640;
const OBSTACLE_COOLDOWN = 0.6;

const STEAM_SPAWN_RATE = 14;
const WALK_FRAME_DURATION = 0.05; // 走路每一格圖播放的秒數(4 張約 0.2 秒一輪)
const SPRITE_DRAW_HEIGHT = 130;   // 角色畫出的高度,比碰撞箱(46)大上不少,外星人圖本身留白較多

// --- 角色圖片素材(climb/alien~alien6,各是一張橫向排列 4 格的走路 sprite sheet,
// 沒有獨立的 stand/jump 圖 —— 站立借第 0 格、跳躍借第 1 格,見 pickPlayerSprite) ---
const ALIEN_KEYS = ['alien', 'alien2', 'alien3', 'alien4', 'alien5', 'alien6'];
const ALIEN_WALK_COUNT = 4;
const SPRITE_IMAGES = {};
function loadImage(path) {
  const img = new Image();
  img.src = path;
  return img;
}
for (const key of ALIEN_KEYS) {
  SPRITE_IMAGES[key] = { walk: loadImage(`06_climb/${key}/${key}_walk.webp`) };
}
const backgroundImg = loadImage('06_climb/climb_background.webp');
const CLIMB_IMAGES = [backgroundImg, ...ALIEN_KEYS.map(key => SPRITE_IMAGES[key].walk)];
const BG_PARALLAX = 0.35; // 背景捲動只有鏡頭的 35%,製造星空縱深感

// --- 平台區塊模板 (手寫座標,不做真程序生成) --------------------------------
function fullWidthPlatform(baseY, localOffset, extra) {
  return Object.assign({ x: -750, y: baseY - localOffset, w: CANVAS_W + 1500, h: 18, type: 'normal' }, extra || {});
}
function plat(baseY, localOffset, x, w, extra) {
  return Object.assign({ x, y: baseY - localOffset, w, h: 18, type: 'normal' }, extra || {});
}
function spinner(baseY, localOffset, cx, radius, speed) {
  return { type: 'spinner', cx, cyBase: baseY - localOffset, radius, angle: Math.random() * Math.PI * 2, speed };
}
function mine(baseY, localOffset, x) {
  return { type: 'mine', x, y: baseY - localOffset, radius: 30, phase: 'idle', timer: 1.2 + Math.random() * 0.8 };
}
function obstacle(baseY, localOffset, x, radius) {
  return { type: 'obstacle', x, y: baseY - localOffset, radius: radius || 24 };
}
function movingPlatform(baseY, localOffset, x, w, opts) {
  const y = baseY - localOffset;
  return {
    x, y, w, h: 18, type: 'moving',
    movingAxis: opts.axis, centerX: x, centerY: y,
    range: opts.range, speed: opts.speed,
    phase: Math.random() * Math.PI * 2, t: 0,
  };
}

// 物理參數下,單次跳躍最大上升高度約 198px,水平舒適可達距離約 180-230px。
// 以下座標皆刻意將垂直間距控制在 <=170px、水平位移 <=230px,確保一定爬得過去。
const CHUNK_TYPES = [
  // 1. 一般爬升:平緩之字形,沒有陷阱
  function normalChunk(baseY) {
    const platforms = [fullWidthPlatform(baseY, 70)];
    const xs = [300, 520, 320, 540, 420];
    const offs = [170, 320, 460, 600, 710];
    for (let i = 0; i < offs.length; i++) platforms.push(plat(baseY, offs[i], xs[i], 210));
    return { platforms, hazards: [], label: '一般爬升' };
  },
  // 2. 暈眩陷阱:同樣的之字形路線,但有旋轉障礙 / 噴發暗雷
  function hazardChunk(baseY) {
    const platforms = [fullWidthPlatform(baseY, 70)];
    const xs = [300, 520, 320, 540, 420];
    const offs = [170, 320, 460, 600, 710];
    for (let i = 0; i < offs.length; i++) platforms.push(plat(baseY, offs[i], xs[i], 110));
    const hazards = [
      spinner(baseY, 250, xs[1] + 105, 85, 1.8),
      mine(baseY, 390, xs[2] + 60),
      spinner(baseY, 530, xs[3] + 105, 90, -2.1),
      mine(baseY, 660, xs[4] + 60),
    ];
    return { platforms, hazards, label: '暈眩陷阱' };
  },
  // 3. 假平台:明顯好走的那條其實是假的,旁邊較不顯眼的才是真平台
  function fakePlatformChunk(baseY) {
    const platforms = [fullWidthPlatform(baseY, 70)];
    platforms.push(plat(baseY, 175, 520, 230, { type: 'fake' }));
    platforms.push(plat(baseY, 190, 250, 100));
    platforms.push(plat(baseY, 330, 460, 100));
    platforms.push(plat(baseY, 345, 680, 210, { type: 'fake' }));
    platforms.push(plat(baseY, 480, 420, 230, { type: 'fake' }));
    platforms.push(plat(baseY, 495, 640, 100));
    platforms.push(plat(baseY, 670, 460, 100));
    platforms.push(plat(baseY, 645, 260, 200, { type: 'fake' }));
    platforms.push(plat(baseY, 730, 660, 100));
    return { platforms, hazards: [], label: '假平台' };
  },
  // 4. 濕地:之字形路線但全是超滑的濕滑平台(白色)
  function iceChunk(baseY) {
    const platforms = [fullWidthPlatform(baseY, 70)];
    const xs = [300, 520, 320, 540, 420];
    const offs = [175, 330, 490, 640, 710];
    for (let i = 0; i < offs.length; i++) {
      platforms.push(plat(baseY, offs[i], xs[i], 120, { type: 'ice', slippery: true }));
    }
    return { platforms, hazards: [], label: '濕地' };
  },
  // 5. 輸送帶:靠左半邊就往左送,靠右半邊就往右送
  function conveyorChunk(baseY) {
    const platforms = [fullWidthPlatform(baseY, 70)];
    const xs = [190, 400, 610, 820, 650];
    const offs = [175, 330, 490, 640, 710];
    const w = 130;
    for (let i = 0; i < offs.length; i++) {
      const dir = (xs[i] + w / 2 < CANVAS_W / 2) ? -1 : 1;
      platforms.push(plat(baseY, offs[i], xs[i], w, { type: 'conveyor', conveyorDir: dir }));
    }
    return { platforms, hazards: [], label: '輸送帶' };
  },
  // 6. 移動板塊:2 塊水平移動 + 1 塊垂直移動,擺動範圍保證有安全上車時機
  function movingPlatformChunk(baseY) {
    const platforms = [fullWidthPlatform(baseY, 70)];
    platforms.push(movingPlatform(baseY, 180, 560, 150, { axis: 'x', range: 160, speed: 1.5 }));
    platforms.push(plat(baseY, 330, 650, 200));
    platforms.push(movingPlatform(baseY, 480, 700, 150, { axis: 'y', range: 95, speed: 1.2 }));
    platforms.push(movingPlatform(baseY, 710, 500, 150, { axis: 'x', range: 180, speed: 1.4 }));
    return { platforms, hazards: [], label: '移動板塊' };
  },
  // 7. 障礙物:鐵刺球擺在平台邊緣或跳躍路徑上,撞到直接被彈飛
  function obstacleChunk(baseY) {
    const platforms = [fullWidthPlatform(baseY, 70)];
    const xs = [300, 540, 340, 580, 600];
    const offs = [170, 320, 460, 600, 710];
    for (let i = 0; i < offs.length; i++) platforms.push(plat(baseY, offs[i], xs[i], 190));
    const hazards = [
      obstacle(baseY, 170, xs[0] + 190 + 20, 22),
      obstacle(baseY, 320, xs[1] - 25, 22),
      obstacle(baseY, 460, xs[2] + 190 + 25, 22),
      obstacle(baseY, 600, xs[3] - 20, 22),
      obstacle(baseY, 710, xs[4] + 95, 26),
    ];
    return { platforms, hazards, label: '障礙物' };
  },
  // 8. 窄板:平台又多又窄(60-72px),難度來源是落點誤差容忍度低
  function narrowChunk(baseY) {
    const platforms = [fullWidthPlatform(baseY, 70)];
    const xs = [280, 480, 260, 460, 660, 440, 240, 460];
    const offs = [150, 270, 390, 510, 610, 700, 780, 780];
    const ws = [70, 64, 68, 62, 66, 60, 64, 64];
    for (let i = 0; i < offs.length; i++) {
      platforms.push(plat(baseY, offs[i], xs[i], ws[i], { type: 'narrow' }));
      platforms.push(plat(baseY, offs[i], xs[i] + 300, ws[i], { type: 'narrow' }));
    }
    return { platforms, hazards: [], label: '窄板' };
  },
];

// --- 玩家 -------------------------------------------------------------------
// 紅隊 = alien/alien2/alien3(紅旗),藍隊 = alien4/alien5/alien6(藍旗) —— 每隻
// 外星人的身體顏色跟旗子顏色都已經烘焙進圖檔本身,不用像舊版 p1~p3 那樣套濾鏡分隊。
const SLOT_DEFS = [
  { spriteKey: 'alien',  color: '#ff6b6b', team: 'red' },
  { spriteKey: 'alien2', color: '#ff8f8f', team: 'red' },
  { spriteKey: 'alien3', color: '#ffb3b3', team: 'red' },
  { spriteKey: 'alien4', color: '#4da3ff', team: 'blue' },
  { spriteKey: 'alien5', color: '#6db8ff', team: 'blue' },
  { spriteKey: 'alien6', color: '#9ccdff', team: 'blue' },
];
const TEAM_UI = {
  red:  { label: '紅隊', text: '#ff8080', barBg: '#552222', barFill: '#ff4d4d' },
  blue: { label: '藍隊', text: '#80c0ff', barBg: '#223355', barFill: '#4da3ff' },
};

let cg = null; // module-level climb state

function makePlayer(def, startX) {
  return {
    ...def,
    x: startX, y: -PLAYER_H, // 站在世界 y=0 的地面上
    vx: 0, vy: 0,
    onGround: false,
    alive: true,
    stunTimer: 0,
    stompedTimer: 0,
    driftDir: 1,
    pushCooldown: 0,
    pushLockTimer: 0,
    pushFlashTimer: 0,
    knockbackTimer: 0,
    offscreenTimer: 0,
    facing: 1,
    animTimer: 0,
    maxHeight: 0,
    landedPlatform: null,
    deathCount: 0,
    obstacleCooldown: 0,
    ctrl: { dx: 0, jumpQueued: false, pushQueued: false },
  };
}

// 抽牌堆式隨機:洗牌後一個一個抽,抽空才重洗,保證全部出現過才會重複。
// 一般爬升(index 0)只保留給開局第一關,之後不會再被抽到。
function drawChunkType() {
  if (cg.chunkBag.length === 0) {
    cg.chunkBag = CHUNK_TYPES.map((_, i) => i).filter(i => i !== 0);
    for (let i = cg.chunkBag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cg.chunkBag[i], cg.chunkBag[j]] = [cg.chunkBag[j], cg.chunkBag[i]];
    }
    // 避免新一輪的第一張剛好跟上一輪結尾同一種
    const nextIdx = cg.chunkBag.length - 1;
    if (cg.chunkBag.length > 1 && cg.chunkBag[nextIdx] === cg.lastChunkType) {
      const swapWith = Math.floor(Math.random() * nextIdx);
      [cg.chunkBag[nextIdx], cg.chunkBag[swapWith]] = [cg.chunkBag[swapWith], cg.chunkBag[nextIdx]];
    }
  }
  return cg.chunkBag.pop();
}

function spawnNextChunk() {
  cg.highestChunkIndex++;
  const baseY = -(START_HEIGHT + (cg.highestChunkIndex - 1) * CHUNK_HEIGHT);
  const typeIdx = (cg.highestChunkIndex === 1) ? 0 : drawChunkType();
  cg.lastChunkType = typeIdx;
  const built = CHUNK_TYPES[typeIdx](baseY);
  cg.chunks.push({ index: cg.highestChunkIndex, baseY, platforms: built.platforms, hazards: built.hazards });
}

function allPlatforms() {
  const list = [];
  for (const c of cg.chunks) for (const p of c.platforms) if (p.state !== 'collapsed') list.push(p);
  return list;
}

// --- 物理更新 -----------------------------------------------------------------
function updatePlayer(p, dt, input) {
  if (!p.alive) return;

  const wasOnGround = p.onGround; // 冰面「剛落地打滑」偵測用
  const stunned = p.stunTimer > 0;
  const knockedBack = p.knockbackTimer > 0;
  const locked = p.pushLockTimer > 0;

  if (stunned) {
    p.vx = p.driftDir * 40; // 緩慢往一側漂移,無法主動移動
  } else if (knockedBack) {
    // 被推飛期間水平速度不套用一般上限,只靠較弱摩擦慢慢衰減,衝量才推得遠
    if (p.vx > 0) p.vx = Math.max(0, p.vx - FRICTION * 0.4 * dt);
    else if (p.vx < 0) p.vx = Math.min(0, p.vx + FRICTION * 0.4 * dt);
  } else if (locked) {
    p.vx *= Math.max(0, 1 - FRICTION * dt / MAX_MOVE_SPEED);
  } else {
    // 濕地:加速打折、摩擦大減,煞車與轉向都會明顯打滑
    const onIce = p.onGround && p.landedPlatform && p.landedPlatform.slippery;
    const accel = onIce ? MOVE_ACCEL * ICE_ACCEL_MULT : MOVE_ACCEL;
    const fric = onIce ? ICE_FRICTION : FRICTION;
    if (input.left && !input.right) { p.vx -= accel * dt; p.facing = -1; }
    else if (input.right && !input.left) { p.vx += accel * dt; p.facing = 1; }
    else {
      if (p.vx > 0) p.vx = Math.max(0, p.vx - fric * dt);
      else if (p.vx < 0) p.vx = Math.min(0, p.vx + fric * dt);
    }
    p.vx = Math.max(-MAX_MOVE_SPEED, Math.min(MAX_MOVE_SPEED, p.vx));

    if (input.jumpEdge && p.onGround) {
      // 假平台:站著安全,起跳離開的當下才塌陷(只能踩一次)
      if (p.landedPlatform && p.landedPlatform.type === 'fake' && !p.landedPlatform.state) {
        p.landedPlatform.state = 'collapsed';
        p.landedPlatform.fadeTimer = 0.15;
      }
      p.vy = JUMP_VELOCITY;
      p.onGround = false;
      SFX.jump();
    }
    if (input.pushEdge && p.pushCooldown <= 0) {
      tryPush(p);
    }
  }

  // 重力
  p.vy += GRAVITY * dt;
  if (p.vy > 1400) p.vy = 1400;

  const prevBottom = p.y + PLAYER_H;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.x = Math.max(0, Math.min(CANVAS_W - PLAYER_W, p.x));

  // 平台碰撞(單向,只能從上方站上去)
  p.onGround = false;
  p.landedPlatform = null;
  if (p.vy >= 0) {
    const newBottom = p.y + PLAYER_H;
    for (const pl of allPlatforms()) {
      if (p.x + PLAYER_W <= pl.x || p.x >= pl.x + pl.w) continue;
      if (prevBottom <= pl.y + 1 && newBottom >= pl.y) {
        p.y = pl.y - PLAYER_H;
        p.vy = 0;
        p.onGround = true;
        p.landedPlatform = pl;
        break;
      }
    }
  }

  // 濕地:剛落地的瞬間腳下打滑,隨機往一側小滑一下
  if (!wasOnGround && p.onGround && p.landedPlatform && p.landedPlatform.slippery) {
    p.vx += (Math.random() < 0.5 ? -1 : 1) * (70 + Math.random() * 90);
  }

  // 輸送帶:站上去就被帶著往箭頭方向移動
  if (p.onGround && p.landedPlatform && p.landedPlatform.conveyorDir) {
    p.x += p.landedPlatform.conveyorDir * CONVEYOR_SPEED * dt;
    p.x = Math.max(0, Math.min(CANVAS_W - PLAYER_W, p.x));
  }

  // 目前高度(數字越大爬越高)
  const h = Math.max(0, -(p.y + PLAYER_H));
  if (h > p.maxHeight) p.maxHeight = h;

  // 走路動畫:只有貼地且有明顯水平速度時才累積
  if (p.onGround && Math.abs(p.vx) > 15) p.animTimer += dt;
  else p.animTimer = 0;

  if (p.stunTimer > 0) p.stunTimer = Math.max(0, p.stunTimer - dt);
  if (p.stompedTimer > 0) p.stompedTimer = Math.max(0, p.stompedTimer - dt);
  if (p.pushCooldown > 0) p.pushCooldown = Math.max(0, p.pushCooldown - dt);
  if (p.pushLockTimer > 0) p.pushLockTimer = Math.max(0, p.pushLockTimer - dt);
  if (p.pushFlashTimer > 0) p.pushFlashTimer = Math.max(0, p.pushFlashTimer - dt);
  if (p.knockbackTimer > 0) p.knockbackTimer = Math.max(0, p.knockbackTimer - dt);
  if (p.obstacleCooldown > 0) p.obstacleCooldown = Math.max(0, p.obstacleCooldown - dt);
}

function tryPush(pusher) {
  let target = null, bestDist = Infinity;
  for (const o of cg.players) {
    if (o === pusher || !o.alive) continue;
    const dx = Math.abs((o.x + PLAYER_W / 2) - (pusher.x + PLAYER_W / 2));
    const dy = Math.abs((o.y + PLAYER_H / 2) - (pusher.y + PLAYER_H / 2));
    if (dx <= PUSH_RANGE_X && dy <= PUSH_RANGE_Y) {
      const d = dx + dy;
      if (d < bestDist) { bestDist = d; target = o; }
    }
  }
  if (!target) return; // 沒推到人:不設冷卻,可以馬上再試
  SFX.push(); // 任何人推到任何人都播放,推擠比跳躍少見很多,不會太吵
  pusher.pushCooldown = PUSH_COOLDOWN;
  pusher.pushLockTimer = PUSH_SELF_LOCK;
  const dir = (target.x >= pusher.x) ? 1 : -1;
  target.vx = dir * PUSH_FORCE_X; // 直接設定,確保每次擊退距離一致
  target.vy += PUSH_FORCE_Y;
  target.onGround = false;
  target.pushFlashTimer = PUSH_FLASH_DURATION;
  target.knockbackTimer = PUSH_KNOCKBACK_DURATION;
  vibrate(target);
}

function updateStomps() {
  for (const a of cg.players) {
    if (!a.alive || a.vy <= 40) continue;
    for (const b of cg.players) {
      if (a === b || !b.alive || a.team !== b.team) continue; // 只踩得到同隊隊友
      const aBottom = a.y + PLAYER_H;
      const bTop = b.y;
      const overlapX = (a.x + PLAYER_W > b.x) && (a.x < b.x + PLAYER_W);
      if (overlapX && aBottom >= bTop - 6 && aBottom <= bTop + 22) {
        a.vy = STOMP_BONUS_VELOCITY;
        a.onGround = false;
        SFX.jump(); // 借頭部彈跳也算一次跳躍,共用跳躍音效
        b.vx = 0;
        b.stunTimer = Math.max(b.stunTimer, STOMP_VICTIM_STUN);
        b.stompedTimer = STOMP_VICTIM_STUN;
        b.driftDir = Math.random() < 0.5 ? -1 : 1;
        break;
      }
    }
  }
}

// 移動板塊:先算板塊這一幀移動了多少,再把站在上面的玩家一起搬同樣距離,
// 才有「跟著板塊走」的騎乘感。要在玩家自己的物理更新「之前」執行,
// 用上一幀結算的 landedPlatform 判斷誰站在上面。
function updateMovingPlatforms(dt) {
  for (const c of cg.chunks) {
    for (const pl of c.platforms) {
      if (pl.type !== 'moving') continue;
      pl.t += dt;
      let dx = 0, dy = 0;
      if (pl.movingAxis === 'x') {
        const newX = pl.centerX + Math.sin(pl.t * pl.speed + pl.phase) * pl.range;
        dx = newX - pl.x;
        pl.x = newX;
      } else {
        const newY = pl.centerY + Math.sin(pl.t * pl.speed + pl.phase) * pl.range;
        dy = newY - pl.y;
        pl.y = newY;
      }
      if (dx !== 0 || dy !== 0) {
        for (const p of cg.players) {
          if (!p.alive || p.landedPlatform !== pl) continue;
          p.x = Math.max(0, Math.min(CANVAS_W - PLAYER_W, p.x + dx));
          p.y += dy;
        }
      }
    }
  }
}

function updateHazards(dt) {
  for (const c of cg.chunks) {
    for (const h of c.hazards) {
      if (h.type === 'spinner') {
        h.angle += h.speed * dt;
        const tipX = h.cx + Math.cos(h.angle) * h.radius;
        const tipY = h.cyBase + Math.sin(h.angle) * h.radius;
        for (const p of cg.players) {
          if (!p.alive || p.stunTimer > 0) continue;
          const cx = p.x + PLAYER_W / 2, cy = p.y + PLAYER_H / 2;
          if (Math.hypot(cx - tipX, cy - tipY) < 26) applyHazardStun(p);
        }
      } else if (h.type === 'mine') {
        h.timer -= dt;
        if (h.phase === 'idle' && h.timer <= 0) { h.phase = 'warn'; h.timer = 0.5; }
        else if (h.phase === 'warn' && h.timer <= 0) { h.phase = 'erupt'; h.timer = 0.3; }
        else if (h.phase === 'erupt' && h.timer <= 0) { h.phase = 'idle'; h.timer = 1.6 + Math.random() * 0.8; }
        if (h.phase === 'erupt') {
          for (const p of cg.players) {
            if (!p.alive || p.stunTimer > 0) continue;
            const cx = p.x + PLAYER_W / 2, cy = p.y + PLAYER_H / 2;
            if (Math.hypot(cx - h.x, cy - h.y) < h.radius + 16) applyHazardStun(p);
          }
        }
      } else if (h.type === 'obstacle') {
        // 實體鐵刺球:撞到直接被彈飛(反方向 + 往上),硬性擊退不是暈眩
        for (const p of cg.players) {
          if (!p.alive || p.obstacleCooldown > 0) continue;
          const cx = p.x + PLAYER_W / 2, cy = p.y + PLAYER_H / 2;
          if (Math.hypot(cx - h.x, cy - h.y) < h.radius + 18) {
            const nx = (cx - h.x) || (Math.random() < 0.5 ? -1 : 1);
            const dirX = nx >= 0 ? 1 : -1;
            p.vx = dirX * OBSTACLE_BOUNCE_X;
            p.vy = -OBSTACLE_BOUNCE_Y;
            p.onGround = false;
            p.landedPlatform = null;
            p.knockbackTimer = PUSH_KNOCKBACK_DURATION;
            p.pushFlashTimer = PUSH_FLASH_DURATION;
            p.obstacleCooldown = OBSTACLE_COOLDOWN;
            SFX.push(); // 撞到障礙物的擊退跟被人推是同一種效果,共用同一個音效
          }
        }
      }
    }
    // 假平台崩塌後的淡出(純視覺,碰撞早已在踩到當下移除)
    for (const pl of c.platforms) {
      if (pl.state === 'collapsed' && pl.fadeTimer > 0) {
        pl.fadeTimer = Math.max(0, pl.fadeTimer - dt);
      }
    }
  }
}

function applyHazardStun(p) {
  if (p.stunTimer <= 0) p.driftDir = Math.random() < 0.5 ? -1 : 1;
  p.stunTimer = HAZARD_STUN_DURATION;
}

// 底部毒霧粒子
function updateSteam(dt) {
  cg.steamSpawnAccum += dt * STEAM_SPAWN_RATE;
  while (cg.steamSpawnAccum >= 1) {
    cg.steamSpawnAccum -= 1;
    cg.steamParticles.push({
      x: Math.random() * CANVAS_W,
      y: CANVAS_H + 10 + Math.random() * 20,
      vx: (Math.random() - 0.5) * 20,
      vy: -(30 + Math.random() * 40),
      r: 14 + Math.random() * 22,
      life: 1.4 + Math.random() * 0.8,
      age: 0,
    });
  }
  for (const s of cg.steamParticles) {
    s.age += dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vx += (Math.random() - 0.5) * 6 * dt;
  }
  cg.steamParticles = cg.steamParticles.filter((s) => s.age < s.life);
}

// --- 鏡頭 ---------------------------------------------------------------------
function updateCamera(dt) {
  const alive = cg.players.filter((p) => p.alive);
  let highestY = 0, lowestY = 0;
  if (alive.length > 0) {
    highestY = Math.min(...alive.map((p) => p.y));
    lowestY = Math.max(...alive.map((p) => p.y + PLAYER_H));
  }

  cg.forcedTopWorldY -= cg.cameraForcedSpeed * dt;

  // 依最高/最矮存活玩家的高度差決定縮放,夾在 CAMERA_ZOOM_MIN ~ 1 之間
  const spreadRaw = Math.max(1, lowestY - highestY);
  const targetZoom = Math.max(CAMERA_ZOOM_MIN, Math.min(1, (CANVAS_H - CAMERA_FRAME_MARGIN_PX * 2) / spreadRaw));
  cg.cameraZoom += (targetZoom - cg.cameraZoom) * Math.min(1, CAMERA_SMOOTH * dt);
  cg.visibleRawTop = CANVAS_H / 2 - CANVAS_H / (2 * cg.cameraZoom);
  cg.visibleRawBottom = CANVAS_H / 2 + CANVAS_H / (2 * cg.cameraZoom);

  // 鏡頭中心對齊最高/最矮兩人的中點;仍受強制推進速度限制,不會往回退
  const centerY = (highestY + lowestY) / 2;
  const leaderBasedTop = centerY - CANVAS_H / 2;
  cg.cameraTopWorldYTarget = Math.min(cg.forcedTopWorldY, leaderBasedTop);

  cg.cameraTopWorldY += (cg.cameraTopWorldYTarget - cg.cameraTopWorldY) * Math.min(1, CAMERA_SMOOTH * dt);
  // 只在區塊切換時提升鏡頭基礎速度,同區塊內不會突然加速
  const passedChunks = Math.floor(Math.max(0, -cg.cameraTopWorldY - START_HEIGHT) / CHUNK_HEIGHT);
  if (passedChunks > cg.chunksPassedForSpeed) {
    cg.chunksPassedForSpeed = passedChunks;
    cg.cameraForcedSpeed = Math.min(CAMERA_SPEED_CAP, cg.cameraForcedSpeed * CAMERA_SPEED_GROW);
  }

  // 視需要生成更多區塊 / 回收畫面下方看不到的舊區塊
  const highestChunk = cg.chunks[cg.chunks.length - 1];
  if (highestChunk && (highestChunk.baseY - CHUNK_HEIGHT) > cg.cameraTopWorldY + cg.visibleRawTop - CANVAS_H * 0.5) {
    spawnNextChunk();
  }
  const bottomVisible = cg.cameraTopWorldY + cg.visibleRawBottom + 400;
  cg.chunks = cg.chunks.filter((c) => c.index === 0 || (c.baseY - CHUNK_HEIGHT < bottomVisible));
}

function worldToScreenY(worldY) { return worldY - cg.cameraTopWorldY; }
function worldToScaledScreenY(worldY) {
  const raw = worldToScreenY(worldY);
  return CANVAS_H / 2 + (raw - CANVAS_H / 2) * cg.cameraZoom;
}

// --- 淘汰 / 勝負判定 -----------------------------------------------------------
function updateEliminations(dt, globalState) {
  for (const p of cg.players) {
    if (!p.alive) continue;
    const screenY = worldToScaledScreenY(p.y);
    if (screenY > CANVAS_H + OFFSCREEN_BUFFER) {
      p.offscreenTimer += dt;
      if (p.offscreenTimer >= ELIMINATION_GRACE) {
        p.alive = false;
        p.deathCount++;
        vibrate(p);
      }
    } else {
      p.offscreenTimer = 0;
    }
  }
  // 一隊全員淘汰,比賽立即結束
  for (const team of ['red', 'blue']) {
    if (cg.players.filter((p) => p.team === team).every((p) => !p.alive)) {
      _finish(globalState, team === 'red' ? 'blue' : 'red');
      return;
    }
  }
}

function teamBestHeight(team) {
  return Math.max(0, ...cg.players.filter((p) => p.team === team).map((p) => p.maxHeight));
}
function teamDeaths(team) {
  return cg.players.filter((p) => p.team === team).reduce((s, p) => s + p.deathCount, 0);
}

function checkTimeUp(globalState) {
  // 判定順序:先比陣亡人數(少的贏),相同才比隊伍代表高度
  const deathsRed = teamDeaths('red');
  const deathsBlue = teamDeaths('blue');
  if (deathsRed !== deathsBlue) {
    _finish(globalState, deathsRed < deathsBlue ? 'red' : 'blue');
    return;
  }
  const hRed = teamBestHeight('red');
  const hBlue = teamBestHeight('blue');
  if (Math.abs(hRed - hBlue) < 1) _finish(globalState, null); // 平手
  else _finish(globalState, hRed > hBlue ? 'red' : 'blue');
}

function _finish(globalState, winnerTeam) {
  if (!cg || cg.done) return;
  cg.done = true;
  // 每位真人玩家把個人爬到的高度折算進大廳計分板(每 500 高度 1 分)
  for (const p of cg.players) {
    if (!p.deviceId || !globalState.players?.[p.deviceId]) continue;
    globalState.players[p.deviceId].score =
      (globalState.players[p.deviceId].score || 0) + Math.round(p.maxHeight / 500);
  }
  const aliveRed = cg.players.filter((p) => p.team === 'red' && p.alive).length;
  const aliveBlue = cg.players.filter((p) => p.team === 'blue' && p.alive).length;
  cg._endCb?.(winnerTeam, { label: '存活人數', red: String(aliveRed), blue: String(aliveBlue) });
}

function vibrate(p) {
  if (!p.deviceId) return;
  const gs = cg?._globalState;
  if (!gs) return;
  if (!gs._pendingMessages) gs._pendingMessages = [];
  gs._pendingMessages.push({ type: 'hit_confirm', deviceId: String(p.deviceId) });
}

// --- 繪製(全部在 1280x720 邏輯座標,draw() 再統一縮放) -------------------------
function drawBackground(ctx) {
  if (!backgroundImg.complete || !backgroundImg.naturalWidth) {
    ctx.fillStyle = '#1a1f2b';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    return;
  }
  const scale = CANVAS_W / backgroundImg.naturalWidth;
  const tileH = backgroundImg.naturalHeight * scale;
  // 鏡頭往上時背景以視差速度往下捲,垂直無縫重複貼滿
  const shiftDown = -cg.cameraTopWorldY * BG_PARALLAX;
  const offset = ((shiftDown % tileH) + tileH) % tileH;
  for (let y = offset - tileH; y < CANVAS_H; y += tileH) {
    ctx.drawImage(backgroundImg, 0, y, CANVAS_W, tileH);
  }
}

function drawPlatform(ctx, pl) {
  if (pl.state === 'collapsed' && (!pl.fadeTimer || pl.fadeTimer <= 0)) return;
  const sy = worldToScreenY(pl.y);
  if (sy < cg.visibleRawTop - 60 || sy > cg.visibleRawBottom + 60) return;

  if (pl.type === 'fake') { drawFakePlatform(ctx, pl, sy); return; }

  // 太空站科幻風:冷色系金屬 + 發光飾邊,跟背景深紅/紫星雲互補
  let colorTop = '#c9d2ff', colorBottom = '#4b4a86', edgeColor = '#2a2850', glowColor = '#8fe9ff';
  let dashed = false;
  let baseAlpha = 1;
  if (pl.type === 'ice') {
    colorTop = '#eafdff'; colorBottom = '#8ed3ea'; edgeColor = '#3f7f96'; glowColor = '#c8f6ff'; // 濕地:冰晶藍白
  } else if (pl.type === 'conveyor') {
    colorTop = '#ffeb9c'; colorBottom = '#cf8a12'; edgeColor = '#7a4d08'; glowColor = '#ffd24a';
  } else if (pl.type === 'moving') {
    colorTop = '#ffa3d6'; colorBottom = '#b3417e'; edgeColor = '#6e1f4d'; glowColor = '#ff7fd0';
  } else if (pl.type === 'narrow') {
    colorTop = '#ddbcff'; colorBottom = '#7c3fc9'; edgeColor = '#48226f'; glowColor = '#cf93ff';
  }

  ctx.save();
  ctx.globalAlpha = baseAlpha;
  if (pl.state === 'collapsed') ctx.globalAlpha = baseAlpha * Math.max(0, pl.fadeTimer / 0.15);
  if (dashed) ctx.setLineDash([6, 4]);

  const r = Math.min(6, pl.h / 2, pl.w / 2);
  const thick = 5; // 側邊厚度,做出立體感

  // 1) 底部厚度色塊(較暗),同時是陰影投射來源,讓平台感覺懸浮在星空中
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = edgeColor;
  ctx.beginPath();
  ctx.roundRect(pl.x, sy, pl.w, pl.h + thick, r);
  ctx.fill();
  ctx.restore();

  // 2) 主體:上淺下深漸層
  const grad = ctx.createLinearGradient(0, sy, 0, sy + pl.h);
  grad.addColorStop(0, colorTop);
  grad.addColorStop(1, colorBottom);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(pl.x, sy, pl.w, pl.h, r);
  ctx.fill();

  // 3) 頂部高光
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pl.x + r, sy + 1.4);
  ctx.lineTo(pl.x + pl.w - r, sy + 1.4);
  ctx.stroke();

  ctx.strokeStyle = edgeColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(pl.x, sy, pl.w, pl.h, r);
  ctx.stroke();

  // 4) 兩端發光鉚釘,呼應太空站風格
  if (pl.w > 30) {
    const midY = sy + pl.h / 2;
    const capInset = Math.min(9, pl.w / 4);
    ctx.fillStyle = glowColor;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 6;
    [pl.x + capInset, pl.x + pl.w - capInset].forEach((cx) => {
      ctx.beginPath();
      ctx.arc(cx, midY, 2.6, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  ctx.restore();

  if (pl.type === 'conveyor') drawConveyorArrows(ctx, pl, sy);
}

function drawFakePlatform(ctx, pl, sy) {
  const r = Math.min(6, pl.h / 2, pl.w / 2);
  // 呼吸感透明度:填色跟邊框強度隨時間緩緩浮動,暗示「這塊怪怪的、可能會消失」
  const breathe = 0.5 + 0.5 * Math.sin(performance.now() / 450);
  let fillAlpha = 0.12 + breathe * 0.10;
  let strokeAlpha = 0.55 + breathe * 0.35;
  if (pl.state === 'collapsed') {
    const fade = Math.max(0, pl.fadeTimer / 0.15);
    fillAlpha *= fade;
    strokeAlpha *= fade;
  }
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(pl.x, sy, pl.w, pl.h, r);
  ctx.fillStyle = `rgba(255,255,255,${fillAlpha.toFixed(3)})`;
  ctx.fill();
  ctx.strokeStyle = `rgba(255,255,255,${strokeAlpha.toFixed(3)})`;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawConveyorArrows(ctx, pl, sy) {
  // 沿平台畫一排隨時間捲動的箭頭,標示輸送方向
  ctx.save();
  ctx.beginPath();
  ctx.rect(pl.x, sy, pl.w, pl.h);
  ctx.clip();
  const arrowSpacing = 26;
  const scroll = ((performance.now() / 1000) * CONVEYOR_SPEED * pl.conveyorDir) % arrowSpacing;
  ctx.fillStyle = 'rgba(60,40,0,0.7)';
  for (let ax = -arrowSpacing; ax < pl.w + arrowSpacing; ax += arrowSpacing) {
    const cx = pl.x + ax + scroll;
    const cy = sy + pl.h / 2;
    ctx.beginPath();
    if (pl.conveyorDir > 0) {
      ctx.moveTo(cx - 5, cy - 6); ctx.lineTo(cx + 6, cy); ctx.lineTo(cx - 5, cy + 6);
    } else {
      ctx.moveTo(cx + 5, cy - 6); ctx.lineTo(cx - 6, cy); ctx.lineTo(cx + 5, cy + 6);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// 暈眩系陷阱(旋轉錘 / 地雷)共用的「迷幻核心」畫法:錐形漸層掃出青→紫→洋紅的
// 循環色彩製造暈眩感,疊加放射狀明暗做出球體感,外圍再加脈動發光與反向旋轉的
// 虛線光圈,讓玩家在碰到之前就能感受到「這裡會讓人頭暈」的視覺語言。
function drawHypnoticOrb(ctx, cx, cy, radius, hueBase, t, pulseDivisor, opts) {
  opts = opts || {};
  const swirlSpeedDivisor = opts.swirlSpeed || 900;
  const glowBoost = opts.glowBoost || 0;
  const flash = opts.flash || 0; // 0~1,愈高愈偏向攻擊瞬間的白/紅閃光

  const pulse = 0.5 + 0.5 * Math.sin(t / (pulseDivisor || 260));

  ctx.save();
  ctx.shadowColor = `hsla(${hueBase}, 90%, 70%, 0.9)`;
  ctx.shadowBlur = 10 + pulse * 12 + glowBoost;
  ctx.fillStyle = `hsla(${hueBase}, 85%, 60%, ${0.55 + flash * 0.25})`;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  const swirlRot = (t / swirlSpeedDivisor) % (Math.PI * 2);
  const swirl = ctx.createConicGradient(swirlRot, cx, cy);
  swirl.addColorStop(0, '#7fe9ff');
  swirl.addColorStop(0.33, '#b389ff');
  swirl.addColorStop(0.66, '#ff7fe0');
  swirl.addColorStop(1, '#7fe9ff');
  ctx.fillStyle = swirl;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  ctx.globalCompositeOperation = 'overlay';
  const shade = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.3, radius * 0.05, cx, cy, radius);
  shade.addColorStop(0, 'rgba(255,255,255,0.9)');
  shade.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  shade.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = shade;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  if (flash > 0) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(255,225,225,${flash * 0.65})`;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = `hsla(${hueBase + 25}, 90%, 75%, 0.55)`;
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 2; i++) {
    const ringR = radius * (1.8 + i * 0.6);
    const dir = i === 0 ? 1 : -1;
    ctx.setLineDash([ringR * 0.35, ringR * 0.55]);
    ctx.lineDashOffset = dir * (t / 15);
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// 地雷進入「攻擊(erupt)」瞬間的一次性衝擊波:一圈向外擴散淡出的震波環,加上
// 幾道飛散的能量碎片,讓玩家不用看數值也能一眼看出「這裡剛剛炸開了」。
function drawEruptBurst(ctx, cx, cy, baseRadius, age) {
  const duration = 0.35;
  if (age < 0 || age > duration) return;
  const p = age / duration;

  ctx.save();
  ctx.strokeStyle = `rgba(255,235,245,${(1 - p) * 0.9})`;
  ctx.lineWidth = 3 * (1 - p) + 1;
  ctx.shadowColor = 'rgba(255,255,255,0.9)';
  ctx.shadowBlur = 14 * (1 - p);
  ctx.beginPath();
  ctx.arc(cx, cy, baseRadius * (0.6 + p * 2.2), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  const sparkCount = 6;
  for (let i = 0; i < sparkCount; i++) {
    const a = (i / sparkCount) * Math.PI * 2 + i * 0.7;
    const dist = baseRadius * (0.8 + p * 2.6);
    const sx = cx + Math.cos(a) * dist;
    const sy2 = cy + Math.sin(a) * dist;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - p * 1.3);
    ctx.fillStyle = '#fff2fb';
    ctx.shadowColor = '#ff9ce8';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(sx, sy2, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawHazard(ctx, h) {
  if (h.type === 'spinner') {
    const sy = worldToScreenY(h.cyBase);
    if (sy < cg.visibleRawTop - 120 || sy > cg.visibleRawBottom + 120) return;
    const tipX = h.cx + Math.cos(h.angle) * h.radius;
    const tipYs = sy + Math.sin(h.angle) * h.radius;
    const t = performance.now();
    // 色相限制在青→紫→洋紅之間來回擺盪,維持冷色調迷幻感,避開暖色系
    const hueBase = 190 + (Math.sin(t / 3000) * 0.5 + 0.5) * 110;

    ctx.save();
    ctx.strokeStyle = 'rgba(190,150,255,0.85)';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(160,120,255,0.8)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(h.cx, sy);
    ctx.lineTo(tipX, tipYs);
    ctx.stroke();

    ctx.shadowBlur = 8;
    ctx.shadowColor = '#b98bff';
    ctx.fillStyle = '#e8dcff';
    ctx.beginPath();
    ctx.arc(h.cx, sy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    drawHypnoticOrb(ctx, tipX, tipYs, 13, hueBase, t);
  } else if (h.type === 'mine') {
    const sy = worldToScreenY(h.y);
    if (sy < cg.visibleRawTop - 60 || sy > cg.visibleRawBottom + 60) return;
    const t = performance.now();
    const hueBase = 190 + (Math.sin(t / 3000) * 0.5 + 0.5) * 110;
    // 隨階段放大核心、加快脈動與漩渦轉速,越接近噴發越有壓迫感;進入 erupt 的
    // 瞬間額外記錄時間點,播放一次性衝擊波 + 閃光,而不只是單純變大
    let displayR = h.radius * 0.55, pulseDivisor = 260, orbOpts;
    if (h.phase === 'warn') {
      displayR = h.radius * 0.75; pulseDivisor = 90;
    } else if (h.phase === 'erupt') {
      displayR = h.radius; pulseDivisor = 45;
      if (h._eruptStartT == null) h._eruptStartT = t;
      const age = (t - h._eruptStartT) / 1000;
      orbOpts = { swirlSpeed: 220, glowBoost: 16, flash: Math.max(0, 1 - age / 0.25) };
      drawEruptBurst(ctx, h.x, sy, h.radius, age);
    }
    if (h.phase !== 'erupt') h._eruptStartT = null;
    drawHypnoticOrb(ctx, h.x, sy, displayR, hueBase, t, pulseDivisor, orbOpts);
  } else if (h.type === 'obstacle') {
    const sy = worldToScreenY(h.y);
    if (sy < cg.visibleRawTop - 60 || sy > cg.visibleRawBottom + 60) return;
    ctx.save();
    ctx.translate(h.x, sy);
    const rot = (performance.now() / 5000) % (Math.PI * 2); // 緩慢自轉,強化威脅感
    ctx.rotate(rot);

    const R = h.radius;
    const tipR = R + 10;
    const spikeCount = 8;

    // 尖刺:根部金屬灰到尖端發光紫藍的漸層,做出金屬立體感
    for (let i = 0; i < spikeCount; i++) {
      const a = (i / spikeCount) * Math.PI * 2;
      const baseA = a - 0.12, baseB = a + 0.12;
      const bx1 = Math.cos(baseA) * R, by1 = Math.sin(baseA) * R;
      const bx2 = Math.cos(baseB) * R, by2 = Math.sin(baseB) * R;
      const tx = Math.cos(a) * tipR, ty = Math.sin(a) * tipR;

      const spikeGrad = ctx.createLinearGradient(0, 0, tx, ty);
      spikeGrad.addColorStop(0, '#454a5c');
      spikeGrad.addColorStop(0.6, '#aeb4c9');
      spikeGrad.addColorStop(1, '#eef0ff');
      ctx.fillStyle = spikeGrad;
      ctx.beginPath();
      ctx.moveTo(bx1, by1);
      ctx.lineTo(tx, ty);
      ctx.lineTo(bx2, by2);
      ctx.closePath();
      ctx.fill();

      ctx.save();
      ctx.shadowColor = '#8f6fff';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#d9c9ff';
      ctx.beginPath();
      ctx.arc(tx, ty, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 球體核心:放射狀漸層做出立體球感,配色走電漿紫/警示藍
    const coreGrad = ctx.createRadialGradient(-R * 0.35, -R * 0.35, R * 0.1, 0, 0, R);
    coreGrad.addColorStop(0, '#f4ecff');
    coreGrad.addColorStop(0.35, '#9b7bff');
    coreGrad.addColorStop(0.75, '#4b2f8f');
    coreGrad.addColorStop(1, '#1a0f3d');
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();

    // 表面能量接縫:幾條淡淡發光弧線,增添科幻細節
    ctx.save();
    ctx.shadowColor = '#c8b6ff';
    ctx.shadowBlur = 5;
    ctx.strokeStyle = 'rgba(220,200,255,0.55)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 3; i++) {
      const seamA = (i / 3) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.62, seamA, seamA + 1.6);
      ctx.stroke();
    }
    ctx.restore();

    ctx.restore();
  }
}

function drawDizzyIcon(ctx, cx, topY) {
  ctx.save();
  ctx.translate(cx, topY - 14);
  for (let i = 0; i < 3; i++) {
    const a = performance.now() / 200 + (i * Math.PI * 2) / 3;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * 8, Math.sin(a) * 4, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ffe066';
    ctx.fill();
  }
  ctx.restore();
}

function drawPushImpactRing(ctx, cx, cy, elapsed) {
  const progress = elapsed / PUSH_IMPACT_DURATION;
  ctx.save();
  ctx.strokeStyle = `rgba(255,255,255,${1 - progress})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, 14 + progress * 34, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// 依目前狀態(跳躍中/走路中/站立)挑這一幀該畫的走路 sheet 格子索引 —— 外星人
// 沒有獨立 stand/jump 圖,站立借第 0 格、跳躍借第 1 格
function pickPlayerSprite(p) {
  if (!p.onGround) return 1;
  if (Math.abs(p.vx) > 15) return Math.floor(p.animTimer / WALK_FRAME_DURATION) % ALIEN_WALK_COUNT;
  return 0;
}

function drawPlayer(ctx, p) {
  if (!p.alive) return;
  const sy = worldToScreenY(p.y);
  if (sy < cg.visibleRawTop - 100 - SPRITE_DRAW_HEIGHT || sy > cg.visibleRawBottom + 150) return;
  const stunned = p.stunTimer > 0;
  const flashing = p.pushFlashTimer > 0;
  // 被推的瞬間白色/本色快速交替閃動
  const blinkOn = flashing && Math.floor(p.pushFlashTimer / 0.07) % 2 === 0;

  const feetX = p.x + PLAYER_W / 2;
  const feetY = sy + PLAYER_H;
  const sheet = SPRITE_IMAGES[p.spriteKey].walk;
  const imgReady = sheet && sheet.complete && sheet.naturalWidth > 0;
  const frameIndex = pickPlayerSprite(p);

  ctx.save();
  ctx.translate(feetX, feetY);
  if (p.facing < 0) ctx.scale(-1, 1);
  ctx.globalAlpha = p.pushLockTimer > 0 ? 0.75 : 1;

  if (imgReady) {
    // 身體/旗子顏色已經烘焙進每隻外星人的圖檔,不用濾鏡分隊 —— 橫向切出這一格
    const sw = sheet.naturalWidth / ALIEN_WALK_COUNT;
    const sh = sheet.naturalHeight;
    const sx = frameIndex * sw;
    const drawH = SPRITE_DRAW_HEIGHT;
    const drawW = drawH * (sw / sh);
    ctx.drawImage(sheet, sx, 0, sw, sh, -drawW / 2, -drawH, drawW, drawH);
    if (blinkOn) {
      // 只把角色本體(不透明像素)蓋成白色,不影響透明背景
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-drawW / 2, -drawH, drawW, drawH);
      ctx.globalCompositeOperation = 'source-over';
    }
  } else {
    // 圖片載入完成前的備用色塊
    ctx.fillStyle = blinkOn ? '#ffffff' : (stunned ? '#8899aa' : p.color);
    ctx.fillRect(-PLAYER_W / 2, -PLAYER_H, PLAYER_W, PLAYER_H);
  }
  ctx.restore();

  // 推人定身中的小圈
  if (p.pushLockTimer > 0) {
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(feetX, feetY - SPRITE_DRAW_HEIGHT - 8, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // 被推當下(前 0.2 秒)的擴散衝擊圈
  const flashElapsed = PUSH_FLASH_DURATION - p.pushFlashTimer;
  if (flashing && flashElapsed < PUSH_IMPACT_DURATION) {
    drawPushImpactRing(ctx, feetX, feetY - SPRITE_DRAW_HEIGHT / 2, flashElapsed);
  }

  if (stunned) drawDizzyIcon(ctx, feetX, feetY - SPRITE_DRAW_HEIGHT);

  // 名稱 + 隊伍色點(頭頂上方)
  ctx.save();
  ctx.font = "bold 13px 'Noto Sans TC', sans-serif";
  ctx.textAlign = 'center';
  const labelY = feetY - SPRITE_DRAW_HEIGHT - 16;
  ctx.fillStyle = p.color;
  ctx.fillRect(feetX - 30, labelY - 9, 9, 9);
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 3;
  ctx.strokeText(p.name, feetX + 4, labelY);
  ctx.fillStyle = '#eee';
  ctx.fillText(p.name, feetX + 4, labelY);
  ctx.restore();
}

function drawSteam(ctx) {
  ctx.save();
  for (const s of cg.steamParticles) {
    const t = s.age / s.life;
    const alpha = Math.sin(Math.min(1, t) * Math.PI) * 0.18;
    ctx.fillStyle = `rgba(220,225,235,${alpha})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * (0.6 + t * 0.6), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawDangerVignette(ctx) {
  let maxDanger = 0;
  for (const p of cg.players) {
    if (!p.alive) continue;
    const sy = worldToScaledScreenY(p.y);
    const dangerStart = CANVAS_H * 0.68;
    const dangerFull = CANVAS_H + OFFSCREEN_BUFFER;
    const ratio = (sy - dangerStart) / (dangerFull - dangerStart);
    maxDanger = Math.max(maxDanger, Math.max(0, Math.min(1, ratio)));
  }
  if (maxDanger <= 0) return;
  const g = ctx.createRadialGradient(
    CANVAS_W / 2, CANVAS_H / 2, CANVAS_H * 0.35,
    CANVAS_W / 2, CANVAS_H / 2, CANVAS_H * 0.75
  );
  g.addColorStop(0, 'rgba(255,0,0,0)');
  g.addColorStop(1, `rgba(255,0,0,${0.55 * maxDanger})`);
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.restore();
}

function drawUI(ctx) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, CANVAS_W, 64);

  // 計時器
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  const secs = Math.ceil(cg.timeLeft);
  ctx.fillText(`${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`, CANVAS_W / 2, 30);

  // 隊伍高度長條
  const hRed = teamBestHeight('red');
  const hBlue = teamBestHeight('blue');
  const maxRef = Math.max(hRed, hBlue, 1);
  const barW = 260, barH = 14;

  ctx.textAlign = 'left';
  ctx.font = "bold 13px 'Noto Sans TC', sans-serif";
  ctx.fillStyle = TEAM_UI.red.text;
  ctx.fillText(`${TEAM_UI.red.label}  高度 ${Math.round(hRed)}`, 16, 20);
  ctx.fillStyle = TEAM_UI.red.barBg;
  ctx.fillRect(16, 26, barW, barH);
  ctx.fillStyle = TEAM_UI.red.barFill;
  ctx.fillRect(16, 26, barW * Math.min(1, hRed / maxRef), barH);

  ctx.textAlign = 'right';
  ctx.fillStyle = TEAM_UI.blue.text;
  ctx.fillText(`${TEAM_UI.blue.label}  高度 ${Math.round(hBlue)}`, CANVAS_W - 16, 20);
  ctx.fillStyle = TEAM_UI.blue.barBg;
  ctx.fillRect(CANVAS_W - 16 - barW, 26, barW, barH);
  ctx.fillStyle = TEAM_UI.blue.barFill;
  ctx.fillRect(CANVAS_W - 16 - barW + barW * (1 - Math.min(1, hBlue / maxRef)), 26, barW * Math.min(1, hBlue / maxRef), barH);

  // 玩家狀態列(存活亮色、淘汰灰色)
  ctx.font = "12px 'Noto Sans TC', sans-serif";
  ctx.textAlign = 'left';
  let px = 16;
  for (const p of cg.players) {
    ctx.fillStyle = p.color;
    ctx.fillRect(px, 46, 12, 12);
    const label = p.alive ? p.name : `${p.name} ✕`;
    ctx.fillStyle = p.alive ? '#ddd' : '#888';
    ctx.fillText(label, px + 16, 56);
    px += ctx.measureText(label).width + 40;
  }
  ctx.restore();
}

// --- game module ----------------------------------------------------------

export default {
  id: 'climb',
  name: '爬高派對',
  description: '3v3 往上爬，別被毒霧吞沒',
  playersPerTeam: 3,
  requireFullTeams: true,
  color: '#8f7ee0',
  emoji: '🧗',
  cover: '06_climb/climb_cover.webp',

  tutorial: {
    pages: [
      '06_climb/tutorial/1.webp',
      '06_climb/tutorial/2.webp',
      '06_climb/tutorial/3.webp',
    ],
  },

  onStart(globalState, endCb) {
    // requireFullTeams guarantees exactly 3 real players per side.
    const active = globalState.activePlayers || {};
    const teams = globalState.teams || {};
    const playing = Object.entries(active)
      .filter(([, role]) => role === 'playing')
      .map(([id]) => id);
    const redIds = playing.filter(id => teams[id] === 'red');
    const blueIds = playing.filter(id => teams[id] === 'blue');

    const players = SLOT_DEFS.map((def, i) => {
      const deviceId = def.team === 'red' ? redIds[i] : blueIds[i - 3];
      const p = makePlayer(def, 200 + i * 160);
      p.deviceId = deviceId;
      p.name = truncateName(globalState.players?.[deviceId]?.name ?? `Player ${deviceId}`);
      return p;
    });

    cg = {
      players,
      chunks: [],
      highestChunkIndex: 0,
      lastChunkType: -1,
      chunkBag: [],
      cameraTopWorldY: -CANVAS_H + 40,
      cameraTopWorldYTarget: -CANVAS_H + 40,
      forcedTopWorldY: -CANVAS_H + 40,
      cameraForcedSpeed: CAMERA_SPEED_BASE,
      cameraZoom: 1,
      visibleRawTop: 0,
      visibleRawBottom: CANVAS_H,
      chunksPassedForSpeed: 0,
      timeLeft: TIME_LIMIT,
      steamParticles: [],
      steamSpawnAccum: 0,
      done: false,
      assetsReady: false,
      _endCb: endCb,
      _globalState: globalState,
    };

    // 地面 / 起始安全區塊,再預生成前 3 個區塊(第一個必為一般爬升)
    cg.chunks.push({ index: 0, baseY: 0, platforms: [fullWidthPlatform(0, 0)], hazards: [] });
    for (let i = 0; i < 3; i++) spawnNextChunk();

    bgm.start();
    preloadImages(CLIMB_IMAGES).then(() => { if (cg) cg.assetsReady = true; });
  },

  preload() {
    return preloadImages(CLIMB_IMAGES);
  },

  update(dt, globalState) {
    if (!cg || cg.done || !cg.assetsReady) return;

    cg.timeLeft -= dt;
    if (cg.timeLeft <= 0) { cg.timeLeft = 0; checkTimeUp(globalState); return; }

    updateMovingPlatforms(dt);
    for (const p of cg.players) {
      if (!p.alive) continue;
      const input = {
        left: p.ctrl.dx < -0.3,
        right: p.ctrl.dx > 0.3,
        jumpEdge: p.ctrl.jumpQueued,
        pushEdge: p.ctrl.pushQueued,
      };
      p.ctrl.jumpQueued = false;
      p.ctrl.pushQueued = false;
      updatePlayer(p, dt, input);
    }
    updateStomps();
    updateHazards(dt);
    updateCamera(dt);
    updateSteam(dt);
    updateEliminations(dt, globalState);
  },

  draw(ctx, w, h) {
    if (!cg) return;
    if (!cg.assetsReady) { drawAssetLoadingPlaceholder(ctx, w, h, '爬高派對'); return; }

    // 等比縮放 + 上下/左右留黑邊,把 1280x720 邏輯畫面放進實際 canvas
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const scale = Math.min(w / CANVAS_W, h / CANVAS_H);
    ctx.save();
    ctx.translate((w - CANVAS_W * scale) / 2, (h - CANVAS_H * scale) / 2);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.rect(0, 0, CANVAS_W, CANVAS_H);
    ctx.clip();

    drawBackground(ctx);

    ctx.save();
    ctx.translate(CANVAS_W / 2, CANVAS_H / 2);
    ctx.scale(cg.cameraZoom, cg.cameraZoom);
    ctx.translate(-CANVAS_W / 2, -CANVAS_H / 2);
    for (const c of cg.chunks) for (const pl of c.platforms) drawPlatform(ctx, pl);
    for (const c of cg.chunks) for (const h2 of c.hazards) drawHazard(ctx, h2);
    for (const p of cg.players) drawPlayer(ctx, p);
    ctx.restore();

    drawDangerVignette(ctx);
    drawSteam(ctx);
    drawUI(ctx);

    ctx.restore();
  },

  onInput(deviceId, data) {
    if (!cg) return;
    const did = String(deviceId);
    const p = cg.players.find(pl => pl.deviceId !== null && String(pl.deviceId) === did);
    if (!p) return;

    if (data.action === 'move') p.ctrl.dx = data.dx ?? 0;
    else if (data.action === 'jump') p.ctrl.jumpQueued = true;
    else if (data.action === 'push') p.ctrl.pushQueued = true;
  },

  onEnd() {
    bgm.stop();
    cg = null;
  },
};
