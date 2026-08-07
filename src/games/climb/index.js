/**
 * 太空上樓 — 3v3 vertical climbing race ported from climb/index.html
 *
 * Red vs blue, 3 per team (playersPerTeam: 3); short teams are filled with
 * AI climbers so both sides always field 3. The camera force-scrolls upward
 * and zooms out to keep everyone framed; falling below the screen (into the
 * poison fog) eliminates you for good — no respawns. A full team wipe ends
 * the match immediately, otherwise at 90s the team with fewer deaths wins,
 * ties broken by the higher team-best height.
 *
 * Physics runs in a fixed logical space (1280x720) so tuning is independent
 * of the screen resolution; draw() uniform-scales + letterboxes into the
 * actual canvas.
 */
import { truncateName } from '../../shared/nameDisplay.js';

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
const WALK_FRAME_DURATION = 0.05; // 走路每一格圖播放的秒數(11 張約 0.55 秒一輪)
const SPRITE_DRAW_HEIGHT = 66;    // 角色畫出的高度,比碰撞箱(46)略大,腳底對齊

// --- 角色圖片素材(climb/p1~p3,各有 stand / jump / walk01~11) --------------
const SPRITE_KEYS = ['p1', 'p2', 'p3'];
const SPRITE_IMAGES = {};
function loadImage(path) {
  const img = new Image();
  img.src = path;
  return img;
}
for (const key of SPRITE_KEYS) {
  SPRITE_IMAGES[key] = {
    stand: loadImage(`climb/${key}/${key}_stand.png`),
    jump: loadImage(`climb/${key}/${key}_jump.png`),
    walk: Array.from({ length: 11 }, (_, i) =>
      loadImage(`climb/${key}/${key}_walk${String(i + 1).padStart(2, '0')}.png`)),
  };
}
const backgroundImg = loadImage('climb/climb_background.png');
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
// 紅隊 = 原圖 P1~P3,藍隊 = 同套圖用濾鏡區分(黃 / 深灰 / 淺灰)
const SLOT_DEFS = [
  { spriteKey: 'p1', hueShift: 0, color: '#ff6b6b', team: 'red' },
  { spriteKey: 'p2', hueShift: 0, color: '#ff8f8f', team: 'red' },
  { spriteKey: 'p3', hueShift: 0, color: '#ffb3b3', team: 'red' },
  { spriteKey: 'p1', hueShift: 250, color: '#4da3ff', team: 'blue' },
  { spriteKey: 'p2', colorMode: 'dark', hueShift: 0, color: '#6db8ff', team: 'blue' },
  { spriteKey: 'p3', colorMode: 'light', hueShift: 0, color: '#9ccdff', team: 'blue' },
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
    ai: { targetX: startX, targetPlatform: undefined, decisionTimer: 0, pushTimer: Math.random() * 1.5 },
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

// --- AI (補滿隊伍缺額的電腦角色) ---------------------------------------------
function updateAI(p, dt) {
  const ai = p.ai;
  ai.decisionTimer -= dt;
  if (ai.decisionTimer <= 0 || ai.targetPlatform === undefined) {
    ai.decisionTimer = 0.35 + Math.random() * 0.25;
    const candidates = allPlatforms().filter((pl) => {
      const dy = p.y - pl.y; // 平台在上方 => dy > 0
      return dy > 10 && dy < 210;
    });
    let best = null, bestScore = Infinity;
    for (const pl of candidates) {
      const platCenterX = pl.x + pl.w / 2;
      const dx = Math.abs(platCenterX - (p.x + PLAYER_W / 2));
      if (dx > 260) continue;
      const dy = p.y - pl.y;
      const score = dx * 1.0 + dy * 0.4;
      if (score < bestScore) { bestScore = score; best = pl; }
    }
    if (best) {
      ai.targetPlatform = best;
      ai.targetX = best.x + best.w / 2 - PLAYER_W / 2 + (Math.random() * 40 - 20);
    } else {
      ai.targetPlatform = null;
      ai.targetX = Math.max(10, Math.min(CANVAS_W - PLAYER_W - 10, p.x + (Math.random() * 240 - 120)));
    }
  }

  const dx = ai.targetX - p.x;
  const input = { left: false, right: false, jumpEdge: false, pushEdge: false };
  if (Math.abs(dx) > 8) {
    if (dx > 0) input.right = true; else input.left = true;
  }
  if (ai.targetPlatform && p.onGround) {
    const platCenterX = ai.targetPlatform.x + ai.targetPlatform.w / 2;
    if (Math.abs(platCenterX - (p.x + PLAYER_W / 2)) < 130) input.jumpEdge = true;
  } else if (!ai.targetPlatform && p.onGround && Math.random() < 0.01) {
    input.jumpEdge = true; // 隨機遊走時偶爾跳一下探路
  }

  // 偶爾推附近的敵方角色(不推隊友)
  ai.pushTimer -= dt;
  if (ai.pushTimer <= 0 && p.pushCooldown <= 0) {
    const enemyNear = cg.players.some((o) => o !== p && o.alive && o.team !== p.team &&
      Math.abs(o.x - p.x) < PUSH_RANGE_X && Math.abs(o.y - p.y) < PUSH_RANGE_Y);
    if (enemyNear && Math.random() < 0.5) input.pushEdge = true;
    ai.pushTimer = 0.8 + Math.random() * 1.2;
  }
  return input;
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
  cg._endCb?.(winnerTeam);
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
  let color = '#e8daca';
  let dashed = false;
  let baseAlpha = 1;
  if (pl.type === 'fake') { baseAlpha = 0.5; dashed = true; }
  else if (pl.type === 'ice') color = '#ffffff';
  else if (pl.type === 'conveyor') color = '#FFD23F';
  else if (pl.type === 'moving') color = '#FF8C42';
  else if (pl.type === 'narrow') color = '#c9a8e0';

  ctx.save();
  ctx.globalAlpha = baseAlpha;
  if (pl.state === 'collapsed') ctx.globalAlpha = baseAlpha * Math.max(0, pl.fadeTimer / 0.15);
  if (dashed) ctx.setLineDash([6, 4]);
  ctx.fillStyle = color;
  ctx.fillRect(pl.x, sy, pl.w, pl.h);
  ctx.strokeStyle = pl.type === 'ice' ? 'rgba(90,160,220,0.6)' : 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(pl.x, sy, pl.w, pl.h);
  ctx.restore();

  if (pl.type === 'conveyor') drawConveyorArrows(ctx, pl, sy);
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

function drawHazard(ctx, h) {
  if (h.type === 'spinner') {
    const sy = worldToScreenY(h.cyBase);
    if (sy < cg.visibleRawTop - 120 || sy > cg.visibleRawBottom + 120) return;
    const tipX = h.cx + Math.cos(h.angle) * h.radius;
    const tipYs = sy + Math.sin(h.angle) * h.radius;
    ctx.save();
    ctx.strokeStyle = '#e34d4d';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(h.cx, sy);
    ctx.lineTo(tipX, tipYs);
    ctx.stroke();
    ctx.fillStyle = '#ff8a8a';
    ctx.beginPath();
    ctx.arc(tipX, tipYs, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#553333';
    ctx.beginPath();
    ctx.arc(h.cx, sy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (h.type === 'mine') {
    const sy = worldToScreenY(h.y);
    if (sy < cg.visibleRawTop - 60 || sy > cg.visibleRawBottom + 60) return;
    ctx.save();
    let color = '#5a3d2b';
    if (h.phase === 'warn') color = (Math.floor(performance.now() / 100) % 2 === 0) ? '#ff5050' : '#5a3d2b';
    if (h.phase === 'erupt') color = '#ffcf40';
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(h.x, sy, h.phase === 'erupt' ? h.radius : h.radius * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (h.type === 'obstacle') {
    const sy = worldToScreenY(h.y);
    if (sy < cg.visibleRawTop - 60 || sy > cg.visibleRawBottom + 60) return;
    ctx.save();
    // 灰色鐵球 + 尖刺,跟暈眩系的紅色陷阱區隔開
    ctx.fillStyle = '#6b6f76';
    ctx.beginPath();
    ctx.arc(h.x, sy, h.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b0b4bb';
    const spikeCount = 8;
    for (let i = 0; i < spikeCount; i++) {
      const a = (i / spikeCount) * Math.PI * 2 + performance.now() / 900;
      const baseA = a - 0.12, baseB = a + 0.12;
      const tipR = h.radius + 10;
      ctx.beginPath();
      ctx.moveTo(h.x + Math.cos(baseA) * h.radius, sy + Math.sin(baseA) * h.radius);
      ctx.lineTo(h.x + Math.cos(a) * tipR, sy + Math.sin(a) * tipR);
      ctx.lineTo(h.x + Math.cos(baseB) * h.radius, sy + Math.sin(baseB) * h.radius);
      ctx.closePath();
      ctx.fill();
    }
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

// 依目前狀態(跳躍中/走路中/站立)挑這一幀該畫的圖
function pickPlayerSprite(p) {
  const sprites = SPRITE_IMAGES[p.spriteKey];
  if (!p.onGround) return sprites.jump;
  if (Math.abs(p.vx) > 15) {
    const frameIdx = Math.floor(p.animTimer / WALK_FRAME_DURATION) % sprites.walk.length;
    return sprites.walk[frameIdx];
  }
  return sprites.stand;
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
  const img = pickPlayerSprite(p);
  const imgReady = img && img.complete && img.naturalWidth > 0;

  ctx.save();
  ctx.translate(feetX, feetY);
  if (p.facing < 0) ctx.scale(-1, 1);
  ctx.globalAlpha = p.pushLockTimer > 0 ? 0.75 : 1;

  if (imgReady) {
    if (p.colorMode === 'dark') ctx.filter = 'grayscale(1) brightness(0.8)';
    if (p.colorMode === 'light') ctx.filter = 'grayscale(1) brightness(1.7) contrast(0.85)';
    if (p.hueShift) ctx.filter = `hue-rotate(${p.hueShift}deg) saturate(1.4)`;
    const drawH = SPRITE_DRAW_HEIGHT;
    const drawW = drawH * (img.naturalWidth / img.naturalHeight);
    ctx.drawImage(img, -drawW / 2, -drawH, drawW, drawH);
    if (blinkOn) {
      // 只把角色本體(不透明像素)蓋成白色,不影響透明背景
      ctx.filter = 'none';
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
  name: '太空上樓',
  description: '3v3 往上爬，別被毒霧吞沒',
  playersPerTeam: 3,
  color: '#8f7ee0',
  emoji: '🧗',
  cover: 'climb/climb_cover.png',

  tutorial: {
    comic: 'climb/climb_intro.png',
    goal: '3v3 往上爬！鏡頭會不斷上升，掉出畫面下方就被毒霧吞掉。淘汰對方全隊，或撐到時間結束時死得比對方少、爬得比對方高！',
    controls: [
      { key: '⬅➡', text: '左右移動' },
      { key: 'Ⓐ', text: '跳躍' },
      { key: 'Ⓑ', text: '推人（靠近任何人時把他推飛，自己會短暫定身）' },
    ],
    tips: [
      '從上方踩「同隊隊友」的頭會自動借力跳，比一般跳高兩倍以上！',
      '小心假平台、噴發地雷、旋轉鎚、鐵刺球、輸送帶和滑溜溜的濕地',
      '時間到時先比陣亡人數，一樣多才比隊伍最高高度',
    ],
  },

  onStart(globalState, endCb) {
    const active = globalState.activePlayers || {};
    const teams = globalState.teams || {};
    const playing = Object.entries(active)
      .filter(([, role]) => role === 'playing')
      .map(([id]) => id);
    const redIds = playing.filter(id => teams[id] === 'red');
    const blueIds = playing.filter(id => teams[id] !== 'red');

    // 真人玩家填進該隊的前幾個名額,剩下的由 AI 補滿
    let aiCount = 0;
    const players = SLOT_DEFS.map((def, i) => {
      const deviceId = (def.team === 'red' ? redIds[i] : blueIds[i - 3]) ?? null;
      const p = makePlayer(def, 200 + i * 160);
      p.deviceId = deviceId;
      p.isBot = deviceId === null;
      p.name = deviceId
        ? truncateName(globalState.players?.[deviceId]?.name ?? `Player ${deviceId}`)
        : `AI-${++aiCount}`;
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
      _endCb: endCb,
      _globalState: globalState,
    };

    // 地面 / 起始安全區塊,再預生成前 3 個區塊(第一個必為一般爬升)
    cg.chunks.push({ index: 0, baseY: 0, platforms: [fullWidthPlatform(0, 0)], hazards: [] });
    for (let i = 0; i < 3; i++) spawnNextChunk();
  },

  update(dt, globalState) {
    if (!cg || cg.done) return;

    cg.timeLeft -= dt;
    if (cg.timeLeft <= 0) { cg.timeLeft = 0; checkTimeUp(globalState); return; }

    updateMovingPlatforms(dt);
    for (const p of cg.players) {
      if (!p.alive) continue;
      // 真人玩家中途斷線的話,座位交給 AI 接手
      if (!p.isBot && !globalState.players?.[p.deviceId]) p.isBot = true;
      let input;
      if (p.isBot) {
        input = updateAI(p, dt);
      } else {
        input = {
          left: p.ctrl.dx < -0.3,
          right: p.ctrl.dx > 0.3,
          jumpEdge: p.ctrl.jumpQueued,
          pushEdge: p.ctrl.pushQueued,
        };
        p.ctrl.jumpQueued = false;
        p.ctrl.pushQueued = false;
      }
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
    cg = null;
  },
};
