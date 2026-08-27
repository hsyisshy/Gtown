import { truncateName } from '../../shared/nameDisplay.js';

/* =========================================================================
   狂瘋醫院 2v2 — 紅隊(左→右) vs 藍隊(右→左)，共用殭屍池，同場對沖，
   60 秒計時賽，時間到送達數量較多的隊伍獲勝。
   ========================================================================= */

/* =========================================================================
   CONFIG
   ========================================================================= */
const CONFIG = {
  UNIT: 70, // px per "character height" unit

  PLAYER_SPEED: 3.2, // units/sec

  ZOMBIE_SPEED_RATIO: 0.65,
  ZOMBIE_TURN_INTERVAL: [2, 4],
  ZOMBIE_NO_REPEAT_TARGET: true,
  ZOMBIE_ATTACK_RANGE: 0.95, // units
  ZOMBIE_ATTACK_TELEGRAPH: 0.5, // sec
  ZOMBIE_ATTACK_COOLDOWN: 1.2, // sec
  ZOMBIE_ATTACK_RETREAT: 1.5, // units knocked back after landing a hit, so it can't camp next to the target

  DISTANCE_THRESHOLD_RATIO: 1.5, // max stretch of the rigid stretcher rod

  // Carrying more layers slows the whole team down — no desync/drop check,
  // just a flat speed multiplier keyed by current stack height.
  STACK_SPEED_MULTIPLIER: { 0: 1.0, 1: 0.92, 2: 0.82, 3: 0.7, 4: 0.56, 5: 0.4 },

  MADNESS_DURATION: 5,
  MADNESS_TYPES: ['SLOW_MOVEMENT', 'SLIPPERY'],
  MADNESS_SLOW_RATIO: 0.45,
  SLIPPERY_DIR_CHANGE_INTERVAL: [0.5, 1.0],

  NORMAL_STOP_TIME: 0.1,
  SLIPPERY_STOP_TIME: [0.4, 0.6],

  PLAYER_HIT_INVULN: 0.6,

  STACK_MAX: 5,
  STACK_CHARGE_TIME: 1.0, // sec per layer while in own start zone
};

const REST_LENGTH = CONFIG.UNIT * 1.0;
const MAX_STRETCH = CONFIG.UNIT * CONFIG.DISTANCE_THRESHOLD_RATIO;
const PLAYER_SPEED_PX = CONFIG.PLAYER_SPEED * CONFIG.UNIT;
const ZOMBIE_SPEED_PX = PLAYER_SPEED_PX * CONFIG.ZOMBIE_SPEED_RATIO;
const CHAR_RADIUS = CONFIG.UNIT * 0.34;

const PLAY_TOP = 130;
const PLAY_BOTTOM = 1080;
const PLAY_LEFT = 0;
const PLAY_RIGHT = 1920;

const MADNESS_ICON = {
  SLOW_MOVEMENT: { icon: '🐌', label: '變慢', color: '#5b9cff' },
  SLIPPERY: { icon: '💧', label: '打滑', color: '#5be3ff' },
};

// Compound player IDs: R = red team, B = blue team; A/B = front/back carrier
const ALL_PIDS = ['RA', 'RB', 'BA', 'BB'];
const PLAYER_LABEL = { RA: '紅1', RB: '紅2', BA: '藍1', BB: '藍2' };

// Real nicknames (AirConsole device name), keyed by pid — set via initGame.
// Falls back to the red/blue-number label when a player has no nickname.
let _playerNames = {};
function displayName(pid) {
  return truncateName(_playerNames[pid] || PLAYER_LABEL[pid]);
}

const TEAM_LABEL = { red: '🔴 紅隊', blue: '🔵 藍隊' };
const TEAM_TINT  = { red: '#ff6b6b', blue: '#4ecdc4' };

/* =========================================================================
   CANVAS / SCALING
   ========================================================================= */
let ctx = null;

/* =========================================================================
   UTIL
   ========================================================================= */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function randRange(lo, hi) { return lo + Math.random() * (hi - lo); }
function randPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function vecLen(v) { return Math.hypot(v.x, v.y); }
function rectContains(r, p) { return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; }

function circleRectPushOut(pos, radius, rect) {
  const closestX = clamp(pos.x, rect.x, rect.x + rect.w);
  const closestY = clamp(pos.y, rect.y, rect.y + rect.h);
  const dx = pos.x - closestX;
  const dy = pos.y - closestY;
  const d = Math.hypot(dx, dy);
  if (d < radius && d > 0.0001) {
    const push = (radius - d);
    pos.x += (dx / d) * push;
    pos.y += (dy / d) * push;
  } else if (d <= 0.0001) {
    // center inside rect: push out along shortest axis
    const left = pos.x - rect.x, right = rect.x + rect.w - pos.x;
    const top = pos.y - rect.y, bottom = rect.y + rect.h - pos.y;
    const m = Math.min(left, right, top, bottom);
    if (m === left) pos.x = rect.x - radius;
    else if (m === right) pos.x = rect.x + rect.w + radius;
    else if (m === top) pos.y = rect.y - radius;
    else pos.y = rect.y + rect.h + radius;
  }
}

/* =========================================================================
   AUDIO (simple synthesized beeps, no external assets)
   ========================================================================= */
let audioCtx = null;
let audioMuted = false;
function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
  }
}
function beep(freq, dur, type, gain) {
  if (audioMuted || !audioCtx) return;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type || 'sine';
  osc.frequency.value = freq;
  g.gain.value = gain != null ? gain : 0.11;
  osc.connect(g);
  g.connect(audioCtx.destination);
  osc.start();
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
  osc.stop(audioCtx.currentTime + dur);
}
// mp3 clips for the events that have real recordings; the rest stay as
// synthesized beeps until matching files exist.
function sfxClip(file, volume) {
  const el = new Audio(`01_hospital/audio/${file}`);
  el.preload = 'auto';
  el.volume = volume;
  return el;
}
const CLIPS = {
  hit:     sfxClip('zombie_hit.mp3', 0.84),
  roar:    sfxClip('zombie_roar.mp3', 0.63),
  add:     sfxClip('pollutant_add.mp3', 0.7),
  deliver: sfxClip('pollutant_deliver.mp3', 0.84),
};
function playClip(el) {
  if (audioMuted) return;
  el.currentTime = 0;
  el.play().catch(() => {});
}

const SFX = {
  hit: () => playClip(CLIPS.hit),
  roar: () => playClip(CLIPS.roar),
  madness: () => beep(300, 0.35, 'triangle', 0.14),
  layerUp: () => playClip(CLIPS.add),
  win: () => { beep(523, 0.15, 'sine'); setTimeout(() => beep(784, 0.25, 'sine'), 140); },
  deliver: () => playClip(CLIPS.deliver),
};

// Ambient zombie roars — pure atmosphere on a random timer, no gameplay tie
const ROAR_INTERVAL = [5, 10]; // seconds
let _roarTimer = ROAR_INTERVAL[0];

/* =========================================================================
   CHARACTER SPRITES (hue-shift recolor: shirt teal -> per-player tint)
   ========================================================================= */
const PLAYER_SPRITE_DRAW_H = CONFIG.UNIT * 2.3;
const ZOMBIE_SPRITE_DRAW_H = PLAYER_SPRITE_DRAW_H;

const PLAYER_SHIRT_HUE = 174; // hue of the reference teal scrubs
const HUE_WINDOW = 22;
const SAT_MIN = 0.15;
// red / orange / blue / purple — team side reads at a glance, teammates differ by warmth
const TINT_HUE = { RA: 0, RB: 30, BA: 220, BB: 262 };

function spriteDrawSize(sprite, targetH) {
  return { w: targetH * (sprite.width / sprite.height), h: targetH };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function recolorRegions(img, regions) {
  // Applies one or more independent hue-shift regions in a single pass, each
  // pixel classified once against the ORIGINAL colors. This avoids a region's
  // own output hue accidentally falling inside a later region's detection
  // window and getting re-recolored on top of.
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const cctx = c.getContext('2d');
  cctx.drawImage(img, 0, 0);
  const imgData = cctx.getImageData(0, 0, c.width, c.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue; // fully transparent, skip
    const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    for (const region of regions) {
      let hueDiff = Math.abs(h - region.sourceHue);
      if (hueDiff > 180) hueDiff = 360 - hueDiff;
      const satMin = region.satMin != null ? region.satMin : SAT_MIN;
      const hueWindow = region.hueWindow != null ? region.hueWindow : HUE_WINDOW;
      if (hueDiff <= hueWindow && s >= satMin) {
        const outS = region.satBoost != null ? Math.max(s, region.satBoost) : s;
        const [nr, ng, nb] = hslToRgb(region.targetHue, outS, l);
        d[i] = nr; d[i + 1] = ng; d[i + 2] = nb;
        break; // first matching region wins
      }
    }
  }
  cctx.putImageData(imgData, 0, 0);
  return c;
}

function recolorHueRegion(img, sourceHue, targetHue, satMin, hueWindow) {
  return recolorRegions(img, [{ sourceHue, targetHue, satMin, hueWindow, satBoost: 0.5 }]);
}

function flipHorizontal(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const cctx = c.getContext('2d');
  cctx.translate(img.width, 0);
  cctx.scale(-1, 1);
  cctx.drawImage(img, 0, 0);
  return c;
}

const CHARACTER_SOURCES = {
  idle: '01_hospital/characters/player_idle.webp',
  walk1: '01_hospital/characters/player_walk1.webp',
  walk2: '01_hospital/characters/player_walk2.webp',
};
const SPRITE_CACHE = { idle: {}, walk1: {}, walk2: {} };
let spritesReady = false;

(function loadCharacterSprites() {
  const keys = Object.keys(CHARACTER_SOURCES);
  let settled = 0;
  keys.forEach((key) => {
    const img = new Image();
    img.onload = () => {
      // Source art faces left; flip once at load time so the cached sprite
      // faces right by default, matching the facingRight=true convention.
      const rightFacing = flipHorizontal(img);
      for (const pid of ALL_PIDS) {
        SPRITE_CACHE[key][pid] = recolorHueRegion(rightFacing, PLAYER_SHIRT_HUE, TINT_HUE[pid]);
      }
      settled++;
      if (settled === keys.length) spritesReady = true;
    };
    img.onerror = () => { settled++; };
    img.src = CHARACTER_SOURCES[key];
  });
})();

/* =========================================================================
   ZOMBIE SPRITES
   ========================================================================= */
const ZOMBIE_CLOTH_HUE = 210;
const ZOMBIE_HAIR_HUE = 34;
const ZOMBIE_HAIR_SAT_MIN = 0.08;

const ZOMBIE_VARIANTS = [
  { cloth: 210, hair: 34 },
  { cloth: 20, hair: 280 },
  { cloth: 100, hair: 0 },
  { cloth: 265, hair: 150 },
];

const ZOMBIE_SOURCES = {
  idle: '01_hospital/zombies/zombie_idle.webp',
  walk1: '01_hospital/zombies/zombie_walk1.webp',
  walk2: '01_hospital/zombies/zombie_walk2.webp',
};
const ZOMBIE_SPRITE_CACHE = { idle: [], walk1: [], walk2: [] };
let zombieSpritesReady = false;

(function loadZombieSprites() {
  const keys = Object.keys(ZOMBIE_SOURCES);
  let settled = 0;
  keys.forEach((key) => {
    const img = new Image();
    img.onload = () => {
      const rightFacing = flipHorizontal(img);
      ZOMBIE_SPRITE_CACHE[key] = ZOMBIE_VARIANTS.map(variant => recolorRegions(rightFacing, [
        { sourceHue: ZOMBIE_CLOTH_HUE, targetHue: variant.cloth, satBoost: 0.55 },
        { sourceHue: ZOMBIE_HAIR_HUE, targetHue: variant.hair, satMin: ZOMBIE_HAIR_SAT_MIN, satBoost: 0.32 },
      ]));
      settled++;
      if (settled === keys.length) zombieSpritesReady = true;
    };
    img.onerror = () => { settled++; };
    img.src = ZOMBIE_SOURCES[key];
  });
})();

/* =========================================================================
   POLLUTANT SPRITE (1 row x 5 columns, frame N shows the stack at N layers)
   ========================================================================= */
const POLLUTANT_SOURCE = '01_hospital/pollutant/pollutant_stack.webp';
const POLLUTANT_DRAW_H = 150;
let pollutantSprite = null;
let pollutantFrameW = 0;
let pollutantFrameH = 0;
let pollutantScale = 1;
let POLLUTANT_BBOXES = null;

function computeAlphaBBox(imgData, x0, x1, height) {
  let minX = x1, maxX = x0, minY = height, maxY = 0, found = false;
  for (let y = 0; y < height; y++) {
    for (let x = x0; x < x1; x++) {
      const alpha = imgData.data[(y * imgData.width + x) * 4 + 3];
      if (alpha > 10) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return found ? { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 } : null;
}

(function loadPollutantSprite() {
  const img = new Image();
  img.onload = () => {
    pollutantSprite = img;
    pollutantFrameW = img.width / 5;
    pollutantFrameH = img.height;

    const off = document.createElement('canvas');
    off.width = img.width; off.height = img.height;
    const octx = off.getContext('2d');
    octx.drawImage(img, 0, 0);
    const data = octx.getImageData(0, 0, img.width, img.height);

    POLLUTANT_BBOXES = [];
    for (let i = 0; i < 5; i++) {
      const x0 = Math.round(i * pollutantFrameW);
      const x1 = Math.round((i + 1) * pollutantFrameW);
      POLLUTANT_BBOXES.push(computeAlphaBBox(data, x0, x1, img.height));
    }
    const maxContentH = Math.max(...POLLUTANT_BBOXES.map(b => b.bottom - b.top));
    pollutantScale = POLLUTANT_DRAW_H / maxContentH;
  };
  img.src = POLLUTANT_SOURCE;
})();

/* =========================================================================
   BACKGROUND
   ========================================================================= */
const BACKGROUND_SOURCE = '01_hospital/background.webp';
let backgroundImg = null;
(function loadBackground() {
  const img = new Image();
  img.onload = () => { backgroundImg = img; };
  img.src = BACKGROUND_SOURCE;
})();

/* =========================================================================
   INPUT
   ========================================================================= */
const _playerAxis = {
  RA: { x: 0, y: 0 }, RB: { x: 0, y: 0 },
  BA: { x: 0, y: 0 }, BB: { x: 0, y: 0 },
};
let _endCallback = null;
let _playerMap = {};

function getRawAxis(pid) {
  return _playerAxis[pid] || { x: 0, y: 0 };
}

/* =========================================================================
   MAP DEFINITIONS (was LEVELS — now host-selectable maps, one per match)
   ========================================================================= */
function rect(x, y, w, h) { return { x, y, w, h }; }

const MAPS = [
  {
    name: '開闊病房',
    goal: '無障礙地形，60 秒內盡量多送汙染物，比誰送得多',
    timeLimit: 60,
    obstacles: [],
    zombieCount: 4,
    zombieSpawns: [ { x: 700, y: 250 }, { x: 1050, y: 750 }, { x: 1350, y: 400 }, { x: 550, y: 850 }, { x: 1550, y: 950 } ],
  },
];

/* =========================================================================
   ZONES — left zone is red's start AND blue's drop; right zone the mirror
   ========================================================================= */
const ZONE_LEFT  = rect(40, PLAY_TOP + 20, 220, (PLAY_BOTTOM - PLAY_TOP) - 40);
const ZONE_RIGHT = rect(1660, PLAY_TOP + 20, 220, (PLAY_BOTTOM - PLAY_TOP) - 40);

const TEAM_CONFIG = {
  red:  { dir: 1,  startZone: ZONE_LEFT,  dropZone: ZONE_RIGHT },
  blue: { dir: -1, startZone: ZONE_RIGHT, dropZone: ZONE_LEFT },
};

/* =========================================================================
   GAME STATE
   ========================================================================= */
let game = {
  state: 'INTRO', // INTRO -> PLAYING -> GAME_OVER
  mapIndex: 0,
  timer: 0,
  transitionTimer: 0,
  winner: null,      // 'red' | 'blue' | null (draw)
  winReason: '',
  ended: false,      // endCallback fired
};

let teams = null; // { red: {...}, blue: {...} }

function makePlayer(pid, spawnPos) {
  return {
    pid,
    pos: { x: spawnPos.x, y: spawnPos.y },
    vel: { x: 0, y: 0 },
    madness: null, // { type, timer }
    invulnTimer: 0,
    slipAngle: 0,
    slipDirTimer: 0,
    facingRight: true,
    walkFrame: 0,
    walkAnimTimer: 0,
  };
}

function makeTeam(teamKey) {
  const cfg = TEAM_CONFIG[teamKey];
  const centerY = PLAY_TOP + (PLAY_BOTTOM - PLAY_TOP) / 2;
  const centerX = cfg.startZone.x + cfg.startZone.w / 2;
  // A is the front carrier (closer to the team's drop zone), B is the back
  const spawnA = { x: centerX + cfg.dir * REST_LENGTH / 2, y: centerY };
  const spawnB = { x: centerX - cfg.dir * REST_LENGTH / 2, y: centerY };
  const prefix = teamKey === 'red' ? 'R' : 'B';
  return {
    key: teamKey,
    dir: cfg.dir,
    startZone: cfg.startZone,
    dropZone: cfg.dropZone,
    players: { A: makePlayer(prefix + 'A', spawnA), B: makePlayer(prefix + 'B', spawnB) },
    stackLayers: 0,
    chargeAccum: 0,
    delivered: 0,
    toasts: { deliver: 0, deliverText: '' },
  };
}

// Shared world state (not per-team)
let world = {
  zombies: [],
};

function currentMap() { return MAPS[game.mapIndex]; }

function getPlayer(pid) {
  const team = pid[0] === 'R' ? teams.red : teams.blue;
  return { team, player: team.players[pid[1]] };
}

function spawnZombies(map) {
  const zs = [];
  for (let i = 0; i < map.zombieCount; i++) {
    const s = map.zombieSpawns[i % map.zombieSpawns.length];
    zs.push({
      pos: { x: s.x, y: s.y },
      dir: { x: randPick([-1, 1]), y: 0 },
      turnTimer: randRange(CONFIG.ZOMBIE_TURN_INTERVAL[0], CONFIG.ZOMBIE_TURN_INTERVAL[1]),
      state: 'WANDER', // WANDER, TELEGRAPH, COOLDOWN
      stateTimer: 0,
      target: null,     // compound pid
      lastTarget: null,
      variant: Math.floor(Math.random() * ZOMBIE_VARIANTS.length),
      facingRight: randPick([true, false]),
      walkFrame: 0,
      walkAnimTimer: 0,
    });
  }
  return zs;
}

function startMatch(mapIndex) {
  game.mapIndex = clamp(mapIndex ?? 0, 0, MAPS.length - 1);
  game.winner = null;
  game.winReason = '';
  game.ended = false;

  teams = { red: makeTeam('red'), blue: makeTeam('blue') };

  const map = currentMap();
  world.zombies = spawnZombies(map);
  game.timer = map.timeLimit;
  game.state = 'INTRO';
  game.transitionTimer = 3.0;
}

function goToGameOver(winner, reason) {
  if (game.state === 'GAME_OVER') return;
  game.state = 'GAME_OVER';
  game.winner = winner;
  game.winReason = reason;
  game.transitionTimer = 4.0;
  SFX.win();
}

/* =========================================================================
   UPDATE: PLAYER MOVEMENT (per team)
   ========================================================================= */
function updatePlayerMovement(team, dt) {
  const stackSpeedMult = CONFIG.STACK_SPEED_MULTIPLIER[team.stackLayers] ?? 1;
  for (const id of ['A', 'B']) {
    const p = team.players[id];
    let axis = getRawAxis(p.pid);
    const isSlippery = p.madness && p.madness.type === 'SLIPPERY';

    if (p.madness && p.madness.type === 'SLOW_MOVEMENT') {
      axis = { x: axis.x * CONFIG.MADNESS_SLOW_RATIO, y: axis.y * CONFIG.MADNESS_SLOW_RATIO };
    }

    const wasMoving = axis.x !== 0 || axis.y !== 0;

    if (isSlippery && wasMoving) {
      // Slipping sends you off in an unpredictable direction, not necessarily
      // the one you're pressing - the drift angle re-randomizes periodically.
      p.slipDirTimer -= dt;
      if (p.slipDirTimer <= 0) {
        p.slipAngle = randRange(0, Math.PI * 2);
        p.slipDirTimer = randRange(CONFIG.SLIPPERY_DIR_CHANGE_INTERVAL[0], CONFIG.SLIPPERY_DIR_CHANGE_INTERVAL[1]);
      }
      const mag = vecLen(axis);
      axis = { x: Math.cos(p.slipAngle) * mag, y: Math.sin(p.slipAngle) * mag };
    }

    const targetVel = { x: axis.x * PLAYER_SPEED_PX * stackSpeedMult, y: axis.y * PLAYER_SPEED_PX * stackSpeedMult };
    const moving = axis.x !== 0 || axis.y !== 0;

    if (moving) {
      const followRate = isSlippery ? 6 : 40;
      p.vel.x = lerp(p.vel.x, targetVel.x, Math.min(1, followRate * dt));
      p.vel.y = lerp(p.vel.y, targetVel.y, Math.min(1, followRate * dt));
    } else {
      const stopTime = isSlippery ? randRange(CONFIG.SLIPPERY_STOP_TIME[0], CONFIG.SLIPPERY_STOP_TIME[1]) : CONFIG.NORMAL_STOP_TIME;
      const decayRate = 1 / Math.max(stopTime, 0.01);
      p.vel.x = lerp(p.vel.x, 0, Math.min(1, decayRate * dt));
      p.vel.y = lerp(p.vel.y, 0, Math.min(1, decayRate * dt));
    }

    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;

    p.pos.x = clamp(p.pos.x, PLAY_LEFT + CHAR_RADIUS, PLAY_RIGHT - CHAR_RADIUS);
    p.pos.y = clamp(p.pos.y, PLAY_TOP + CHAR_RADIUS, PLAY_BOTTOM - CHAR_RADIUS);

    for (const ob of currentMap().obstacles) {
      circleRectPushOut(p.pos, CHAR_RADIUS, ob);
    }
  }
}

/* =========================================================================
   UPDATE: CROSS-TEAM BODY BLOCKING — opposing carriers physically collide
   ========================================================================= */
function resolveCrossTeamCollisions() {
  const reds  = [teams.red.players.A, teams.red.players.B];
  const blues = [teams.blue.players.A, teams.blue.players.B];
  const minD = CHAR_RADIUS * 2;
  for (const r of reds) {
    for (const b of blues) {
      const dx = b.pos.x - r.pos.x, dy = b.pos.y - r.pos.y;
      const d = Math.hypot(dx, dy) || 0.0001;
      if (d < minD) {
        const nx = dx / d, ny = dy / d;
        const push = (minD - d) * 0.5;
        r.pos.x -= nx * push; r.pos.y -= ny * push;
        b.pos.x += nx * push; b.pos.y += ny * push;
      }
    }
  }
}

/* =========================================================================
   UPDATE: STRETCHER ROD CONSTRAINT (per team)
   ========================================================================= */
function updateStretcherRod(team) {
  const a = team.players.A.pos, b = team.players.B.pos;
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 0.0001;

  if (d > MAX_STRETCH) {
    const excess = d - MAX_STRETCH;
    const nx = dx / d, ny = dy / d;
    const speedA = vecLen(team.players.A.vel);
    const speedB = vecLen(team.players.B.vel);
    const totalSpeed = speedA + speedB;
    // Whoever is moving faster absorbs more of the correction; a stationary
    // partner (speed 0) is never dragged along.
    const wA = totalSpeed > 0.01 ? speedA / totalSpeed : 0.5;
    const wB = totalSpeed > 0.01 ? speedB / totalSpeed : 0.5;
    a.x += nx * excess * wA; a.y += ny * excess * wA;
    b.x -= nx * excess * wB; b.y -= ny * excess * wB;
  }
  const minDist = CHAR_RADIUS * 1.6;
  const d2 = Math.hypot(b.x - a.x, b.y - a.y) || 0.0001;
  if (d2 < minDist) {
    const nx = (b.x - a.x) / d2, ny = (b.y - a.y) / d2;
    const push = (minDist - d2) * 0.5;
    a.x -= nx * push; a.y -= ny * push;
    b.x += nx * push; b.y += ny * push;
  }
}

/* =========================================================================
   UPDATE: STACK CHARGING AT OWN START ZONE
   ========================================================================= */
function updateStackCharging(team, dt) {
  const mid = teamMidpoint(team);
  const inZone = rectContains(team.startZone, mid);
  if (inZone && team.stackLayers < CONFIG.STACK_MAX) {
    team.chargeAccum += dt;
    if (team.chargeAccum >= CONFIG.STACK_CHARGE_TIME) {
      team.chargeAccum -= CONFIG.STACK_CHARGE_TIME;
      team.stackLayers = Math.min(CONFIG.STACK_MAX, team.stackLayers + 1);
      SFX.layerUp();
    }
  }
}

function teamMidpoint(team) {
  return {
    x: (team.players.A.pos.x + team.players.B.pos.x) / 2,
    y: (team.players.A.pos.y + team.players.B.pos.y) / 2,
  };
}

/* =========================================================================
   UPDATE: MADNESS TIMERS (per team)
   ========================================================================= */
function updateMadness(team, dt) {
  for (const id of ['A', 'B']) {
    const p = team.players[id];
    if (p.madness) {
      p.madness.timer -= dt;
      if (p.madness.timer <= 0) p.madness = null;
    }
    if (p.invulnTimer > 0) p.invulnTimer = Math.max(0, p.invulnTimer - dt);
  }
}

/* =========================================================================
   UPDATE: CHARACTER SPRITE ANIMATION (per team)
   ========================================================================= */
const WALK_FRAME_TIME = 0.14;
const WALK_SPEED_THRESHOLD = 8;

function updateCharacterAnimation(team, dt) {
  // Characters always face toward their partner (toward the stretcher):
  // whoever is on the left faces right, whoever is on the right faces left.
  const dx = team.players.A.pos.x - team.players.B.pos.x;
  if (Math.abs(dx) > 0.5) {
    team.players.A.facingRight = dx < 0;
    team.players.B.facingRight = dx > 0;
  }

  for (const id of ['A', 'B']) {
    const p = team.players[id];
    const moving = vecLen(p.vel) > WALK_SPEED_THRESHOLD;
    if (moving) {
      p.walkAnimTimer += dt;
      if (p.walkAnimTimer >= WALK_FRAME_TIME) {
        p.walkAnimTimer -= WALK_FRAME_TIME;
        p.walkFrame = p.walkFrame === 0 ? 1 : 0;
      }
    } else {
      p.walkAnimTimer = 0;
      p.walkFrame = 0;
    }
  }
}

function triggerMadness(pid) {
  const { player: p } = getPlayer(pid);
  if (p.madness) return; // immune while already afflicted
  const type = randPick(CONFIG.MADNESS_TYPES);
  p.madness = { type, timer: CONFIG.MADNESS_DURATION };
  SFX.madness();
}

/* =========================================================================
   UPDATE: ZOMBIES — shared pool, attack any of the 4 players
   ========================================================================= */
function isBeingTelegraphedByOther(pid, exceptZombie) {
  return world.zombies.some(oz => oz !== exceptZombie && oz.state === 'TELEGRAPH' && oz.target === pid);
}

function pickZombieTarget(z) {
  const candidates = ALL_PIDS.filter(pid => {
    const { player: p } = getPlayer(pid);
    if (p.invulnTimer > 0) return false;
    if (isBeingTelegraphedByOther(pid, z)) return false;
    return dist(p.pos, z.pos) <= CONFIG.ZOMBIE_ATTACK_RANGE * CONFIG.UNIT;
  });
  if (candidates.length === 0) return null;
  if (CONFIG.ZOMBIE_NO_REPEAT_TARGET && candidates.length > 1 && z.lastTarget) {
    const filtered = candidates.filter(pid => pid !== z.lastTarget);
    if (filtered.length > 0) return filtered[0];
  }
  return candidates[0];
}

function updateZombies(dt) {
  const map = currentMap();
  for (const z of world.zombies) {
    for (const ob of map.obstacles) {
      circleRectPushOut(z.pos, CHAR_RADIUS * 0.95, ob);
    }

    // Both teams' load/drop zones are zombie-free: shove out any zombie
    // that ended up inside (attack retreat, spawn drift, etc.)
    circleRectPushOut(z.pos, CHAR_RADIUS * 0.95, ZONE_LEFT);
    circleRectPushOut(z.pos, CHAR_RADIUS * 0.95, ZONE_RIGHT);

    // Never let a zombie rest inside the 40px wander dead-band along the
    // walls — attack retreat used to park them at wall+20 where every
    // wander step read as "out of bounds", leaving them twitching against
    // the wall forever.
    z.pos.x = clamp(z.pos.x, PLAY_LEFT + 40, PLAY_RIGHT - 40);
    z.pos.y = clamp(z.pos.y, PLAY_TOP + 40, PLAY_BOTTOM - 40);

    if (z.state === 'WANDER' || z.state === 'COOLDOWN') {
      z.turnTimer -= dt;
      const nextX = z.pos.x + z.dir.x * ZOMBIE_SPEED_PX * dt;
      const nextY = z.pos.y + z.dir.y * ZOMBIE_SPEED_PX * dt;
      const next = { x: nextX, y: nextY };
      const bumpedPlayer = ALL_PIDS.some(pid =>
        dist(getPlayer(pid).player.pos, next) < CHAR_RADIUS * 1.8);
      const blocked = bumpedPlayer ||
        map.obstacles.some(ob => rectContains(ob, next)) ||
        rectContains(ZONE_LEFT, next) || rectContains(ZONE_RIGHT, next);
      const outOfBounds =
        nextX < PLAY_LEFT + 40 || nextX > PLAY_RIGHT - 40 ||
        nextY < PLAY_TOP + 40 || nextY > PLAY_BOTTOM - 40;
      if (z.turnTimer <= 0 || blocked || outOfBounds) {
        // When actually blocked, steer back toward the field center (with
        // jitter) — a pure random angle can point straight back at the
        // wall/zone and leave the zombie thrashing in place for seconds.
        const ang = (blocked || outOfBounds)
          ? Math.atan2(
              (PLAY_TOP + PLAY_BOTTOM) / 2 - z.pos.y,
              (PLAY_LEFT + PLAY_RIGHT) / 2 - z.pos.x
            ) + randRange(-Math.PI / 3, Math.PI / 3)
          : randRange(0, Math.PI * 2);
        z.dir = { x: Math.cos(ang), y: Math.sin(ang) };
        z.turnTimer = randRange(CONFIG.ZOMBIE_TURN_INTERVAL[0], CONFIG.ZOMBIE_TURN_INTERVAL[1]);
      } else {
        z.pos.x = nextX; z.pos.y = nextY;
      }

      if (z.dir.x > 0.1) z.facingRight = true;
      else if (z.dir.x < -0.1) z.facingRight = false;

      z.walkAnimTimer += dt;
      if (z.walkAnimTimer >= WALK_FRAME_TIME) {
        z.walkAnimTimer -= WALK_FRAME_TIME;
        z.walkFrame = z.walkFrame === 0 ? 1 : 0;
      }
    } else {
      // TELEGRAPH: frozen in place, static pose
      z.walkAnimTimer = 0;
      z.walkFrame = 0;
    }

    if (z.state === 'WANDER') {
      const target = pickZombieTarget(z);
      if (target) {
        z.state = 'TELEGRAPH';
        z.stateTimer = CONFIG.ZOMBIE_ATTACK_TELEGRAPH;
        z.target = target;
      }
    } else if (z.state === 'TELEGRAPH') {
      z.stateTimer -= dt;
      if (z.stateTimer <= 0) {
        resolveZombieAttack(z);
        z.state = 'COOLDOWN';
        z.stateTimer = CONFIG.ZOMBIE_ATTACK_COOLDOWN;
      }
    } else if (z.state === 'COOLDOWN') {
      z.stateTimer -= dt;
      if (z.stateTimer <= 0) {
        z.state = 'WANDER';
        z.turnTimer = randRange(CONFIG.ZOMBIE_TURN_INTERVAL[0], CONFIG.ZOMBIE_TURN_INTERVAL[1]);
      }
    }
  }
}

function resolveZombieAttack(z) {
  const targetPid = z.target;
  const { player: p } = getPlayer(targetPid);
  if (!p || dist(p.pos, z.pos) > CONFIG.ZOMBIE_ATTACK_RANGE * CONFIG.UNIT * 1.4) {
    z.lastTarget = targetPid;
    z.target = null;
    return;
  }

  const dx = p.pos.x - z.pos.x, dy = p.pos.y - z.pos.y;
  const d = Math.hypot(dx, dy) || 1;
  const nx = dx / d, ny = dy / d;

  // Always retreat after landing a hit so it doesn't just sit there and
  // re-attack the instant invulnerability/cooldown wears off.
  z.pos.x -= nx * CONFIG.ZOMBIE_ATTACK_RETREAT * CONFIG.UNIT;
  z.pos.y -= ny * CONFIG.ZOMBIE_ATTACK_RETREAT * CONFIG.UNIT;
  SFX.hit();
  triggerMadness(targetPid);

  // Clamp into the wander-legal band (+40, matching updateZombies) — the
  // old +20 clamp could park the zombie inside the dead-band and stick it.
  z.pos.x = clamp(z.pos.x, PLAY_LEFT + 40, PLAY_RIGHT - 40);
  z.pos.y = clamp(z.pos.y, PLAY_TOP + 40, PLAY_BOTTOM - 40);
  p.invulnTimer = CONFIG.PLAYER_HIT_INVULN;
  z.lastTarget = targetPid;
  z.target = null;
}

/* =========================================================================
   UPDATE: DELIVERY / WIN / LOSE
   ========================================================================= */
function updateDelivery(team) {
  const mid = teamMidpoint(team);
  if (rectContains(team.dropZone, mid) && team.stackLayers > 0) {
    const delivering = team.stackLayers;
    team.delivered += delivering;
    team.stackLayers = 0;
    team.chargeAccum = 0;
    SFX.deliver();
    team.toasts.deliver = 1.6;
    team.toasts.deliverText = `${TEAM_LABEL[team.key]} 送達 ${delivering} 個！累計 ${team.delivered}`;
  }
}

function checkWinLose(dt) {
  game.timer -= dt;
  if (game.timer <= 0) {
    game.timer = 0;
    const r = teams.red.delivered, b = teams.blue.delivered;
    if (r > b)      goToGameOver('red',  `時間到！送達數 ${r} : ${b}`);
    else if (b > r) goToGameOver('blue', `時間到！送達數 ${r} : ${b}`);
    else            goToGameOver(null,   `時間到！${r} : ${b} 平手`);
    return;
  }

  for (const teamKey of ['red', 'blue']) {
    const t = teams[teamKey].toasts;
    if (t.deliver > 0) t.deliver -= dt;
  }
}

/* =========================================================================
   MAIN UPDATE
   ========================================================================= */
function update(dt) {
  if (game.state === 'INTRO') {
    game.transitionTimer -= dt;
    if (game.transitionTimer <= 0) game.state = 'PLAYING';
    return;
  }
  if (game.state === 'PLAYING') {
    _roarTimer -= dt;
    if (_roarTimer <= 0) {
      SFX.roar();
      _roarTimer = ROAR_INTERVAL[0] + Math.random() * (ROAR_INTERVAL[1] - ROAR_INTERVAL[0]);
    }
    for (const teamKey of ['red', 'blue']) {
      const team = teams[teamKey];
      updatePlayerMovement(team, dt);
      updateCharacterAnimation(team, dt);
      updateStretcherRod(team);
      updateStackCharging(team, dt);
      updateMadness(team, dt);
    }
    resolveCrossTeamCollisions();
    updateZombies(dt);
    for (const teamKey of ['red', 'blue']) updateDelivery(teams[teamKey]);
    checkWinLose(dt);
    return;
  }
  if (game.state === 'GAME_OVER') {
    game.transitionTimer -= dt;
    if (game.transitionTimer <= 0 && !game.ended) {
      game.ended = true;
      _endCallback?.(game.winner, {
        label: '送達數',
        red: String(teams.red.delivered),
        blue: String(teams.blue.delivered),
      });
    }
    return;
  }
}

/* =========================================================================
   RENDER
   ========================================================================= */
function drawZone(r, color, borderColor, label, sublabel) {
  ctx.fillStyle = color;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 3;
  ctx.setLineDash([12, 8]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([]);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 24px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, r.x + r.w / 2, r.y + 40);
  if (sublabel) {
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(sublabel, r.x + r.w / 2, r.y + 72);
  }
}

function drawObstacles() {
  for (const ob of currentMap().obstacles) {
    ctx.fillStyle = '#5a4a3a';
    ctx.fillRect(ob.x, ob.y, ob.w, ob.h);
    ctx.strokeStyle = '#3a2f24';
    ctx.lineWidth = 4;
    ctx.strokeRect(ob.x, ob.y, ob.w, ob.h);
    ctx.fillStyle = '#cbb89a';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.save();
    ctx.translate(ob.x + ob.w / 2, ob.y + ob.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('障礙物', 0, 0);
    ctx.restore();
  }
}

function drawZombies() {
  for (const z of world.zombies) {
    const spriteFrameKey = z.state === 'TELEGRAPH' ? 'idle' : (z.walkFrame === 0 ? 'walk1' : 'walk2');
    const sprite = zombieSpritesReady ? ZOMBIE_SPRITE_CACHE[spriteFrameKey][z.variant] : null;

    ctx.save();
    ctx.translate(z.pos.x, z.pos.y);

    if (sprite) {
      if (!z.facingRight) ctx.scale(-1, 1);
      const size = spriteDrawSize(sprite, ZOMBIE_SPRITE_DRAW_H);
      ctx.drawImage(sprite, -size.w / 2, -size.h / 2, size.w, size.h);
    } else {
      let color = '#3a8f3a';
      if (z.state === 'TELEGRAPH') {
        const pulse = 1 - z.stateTimer / CONFIG.ZOMBIE_ATTACK_TELEGRAPH;
        color = `rgb(${Math.floor(58 + pulse * 180)}, ${Math.floor(143 - pulse * 100)}, 40)`;
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, CHAR_RADIUS * 0.95, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#1d3d1d';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Z', 0, 6);
    }
    ctx.restore();

    if (z.state === 'TELEGRAPH') {
      ctx.fillStyle = '#ffdd33';
      ctx.font = 'bold 22px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('!', z.pos.x, z.pos.y - ZOMBIE_SPRITE_DRAW_H / 2 - 10);
    }
  }
}

function drawStretcher(team) {
  const a = team.players.A.pos, b = team.players.B.pos;
  ctx.strokeStyle = team.key === 'red' ? '#a06a6a' : '#6a8aa0';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();

  const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
  const layers = team.stackLayers;
  if (layers > 0) {
    if (pollutantSprite && POLLUTANT_BBOXES) {
      const frameIndex = layers - 1;
      const bbox = POLLUTANT_BBOXES[frameIndex];
      const contentW = bbox.right - bbox.left;
      const contentH = bbox.bottom - bbox.top;
      const drawW = contentW * pollutantScale;
      const drawH = contentH * pollutantScale;
      ctx.drawImage(
        pollutantSprite,
        bbox.left, bbox.top, contentW, contentH,
        midX - drawW / 2, midY - drawH, drawW, drawH
      );
    } else {
      for (let i = 0; i < layers; i++) {
        const s = 22;
        ctx.fillStyle = `hsl(${90 - i * 8}, 55%, ${40 + i * 4}%)`;
        ctx.fillRect(midX - s / 2, midY - 30 - i * (s - 4), s, s - 4);
        ctx.strokeStyle = '#2a2a2a';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(midX - s / 2, midY - 30 - i * (s - 4), s, s - 4);
      }
    }
  }

  const labelTopY = midY - POLLUTANT_DRAW_H - 10;

  ctx.fillStyle = TEAM_TINT[team.key];
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`疊放 ${layers}/${CONFIG.STACK_MAX}`, midX, labelTopY - 22);
}

const FALLBACK_COLOR = { RA: '#e04040', RB: '#e08b3f', BA: '#3f7fe0', BB: '#9b59e0' };

function drawPlayerChar(p) {
  const moving = vecLen(p.vel) > WALK_SPEED_THRESHOLD;
  const spriteKey = moving ? (p.walkFrame === 0 ? 'walk1' : 'walk2') : 'idle';
  const sprite = spritesReady ? SPRITE_CACHE[spriteKey][p.pid] : null;
  const halfH = PLAYER_SPRITE_DRAW_H / 2;

  ctx.save();
  ctx.globalAlpha = p.invulnTimer > 0 ? 0.55 : 1;
  ctx.translate(p.pos.x, p.pos.y);

  if (sprite) {
    if (!p.facingRight) ctx.scale(-1, 1);
    const size = spriteDrawSize(sprite, PLAYER_SPRITE_DRAW_H);
    ctx.drawImage(sprite, -size.w / 2, -halfH, size.w, size.h);
  } else {
    ctx.fillStyle = FALLBACK_COLOR[p.pid];
    ctx.beginPath();
    ctx.arc(0, 0, CHAR_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.restore();

  // Nameplate: real nickname (not just "紅1"/"藍1") so a player can spot
  // themselves among 4 characters, with a dark backing chip + bigger bold
  // text so it stays legible over the busy hospital background. Teammates
  // share a stretcher and stand only ~40-100px apart, so the front (A) and
  // back (B) carrier's nameplates are staggered onto separate rows —
  // otherwise two names centered on nearly the same x just merge together.
  const name = displayName(p.pid);
  const rowShift = p.pid.endsWith('A') ? 0 : 28;
  const nameY = p.pos.y - halfH - 10 - rowShift;
  ctx.font = 'bold 22px "Noto Sans TC", sans-serif';
  ctx.textAlign = 'center';
  const textW = ctx.measureText(name).width;
  const padX = 10;
  ctx.fillStyle = 'rgba(10, 8, 6, 0.6)';
  ctx.fillRect(p.pos.x - textW / 2 - padX, nameY - 20, textW + padX * 2, 27);
  ctx.fillStyle = p.pid[0] === 'R' ? TEAM_TINT.red : TEAM_TINT.blue;
  ctx.fillText(name, p.pos.x, nameY);

  if (p.madness) {
    const info = MADNESS_ICON[p.madness.type];
    ctx.font = '20px sans-serif';
    ctx.fillText(info.icon, p.pos.x, nameY - 30);
  }
}

function drawToasts() {
  // Red team toasts on the upper slot, blue on the lower slot
  const slots = { red: 440, blue: 560 };
  for (const teamKey of ['red', 'blue']) {
    const team = teams[teamKey];
    const t = team.toasts;
    const y = slots[teamKey];
    let msg = null, color = '#fff';

    if (t.deliver > 0) {
      msg = t.deliverText;
      color = '#7fffb0';
    }

    if (msg) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(510, y, 900, 60);
      ctx.fillStyle = color;
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(msg, 960, y + 40);
    }
  }
}

function drawWorld() {
  if (backgroundImg) {
    ctx.drawImage(backgroundImg, PLAY_LEFT, PLAY_TOP, PLAY_RIGHT - PLAY_LEFT, PLAY_BOTTOM - PLAY_TOP);
  } else {
    ctx.fillStyle = '#3d3f45';
    ctx.fillRect(PLAY_LEFT, PLAY_TOP, PLAY_RIGHT - PLAY_LEFT, PLAY_BOTTOM - PLAY_TOP);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x < 1920; x += 80) { ctx.beginPath(); ctx.moveTo(x, PLAY_TOP); ctx.lineTo(x, PLAY_BOTTOM); ctx.stroke(); }
    for (let y = PLAY_TOP; y < PLAY_BOTTOM; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1920, y); ctx.stroke(); }
  }

  // Left zone: red start + blue drop. Right zone: blue start + red drop.
  drawZone(ZONE_LEFT,  'rgba(200,70,70,0.24)',  '#ff6b6b', '🔴 起點', '🔵 丟棄區');
  drawZone(ZONE_RIGHT, 'rgba(70,150,200,0.24)', '#4ecdc4', '🔵 起點', '🔴 丟棄區');

  // Travel direction arrows
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = TEAM_TINT.red;
  ctx.fillText('→', ZONE_RIGHT.x - 40, ZONE_RIGHT.y + 120);
  ctx.fillStyle = TEAM_TINT.blue;
  ctx.fillText('←', ZONE_LEFT.x + ZONE_LEFT.w + 40, ZONE_LEFT.y + ZONE_LEFT.h - 100);

  drawObstacles();
  drawZombies();

  // Draw stretchers first, then all characters sorted by y for correct overlap
  drawStretcher(teams.red);
  drawStretcher(teams.blue);
  const allPlayers = ALL_PIDS.map(pid => getPlayer(pid).player)
    .sort((a, b) => a.pos.y - b.pos.y);
  for (const p of allPlayers) drawPlayerChar(p);

  drawToasts();
}

/* ---- "hospital biohazard alert system" HUD styling helpers ---- */
const MONO_FONT_STACK = "'Share Tech Mono', 'Orbitron', monospace";

function chamferedRectPath(x, y, w, h, cut) {
  ctx.beginPath();
  ctx.moveTo(x + cut, y);
  ctx.lineTo(x + w - cut, y);
  ctx.lineTo(x + w, y + cut);
  ctx.lineTo(x + w, y + h - cut);
  ctx.lineTo(x + w - cut, y + h);
  ctx.lineTo(x + cut, y + h);
  ctx.lineTo(x, y + h - cut);
  ctx.lineTo(x, y + cut);
  ctx.closePath();
}

function octagonPath(cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = Math.PI / 8 + i * (Math.PI / 4);
    const px = cx + r * Math.cos(angle);
    const py = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawCountdownTimer() {
  const cx = 960, cy = 48, r = 26;
  const low = game.timer <= 10;
  const pulse = (Math.sin(performance.now() / 200) + 1) / 2; // 0..1

  const borderColor = low
    ? `rgb(255, ${Math.floor(50 + pulse * 70)}, ${Math.floor(50 + pulse * 70)})`
    : '#5fd0ff';
  const glowColor = low
    ? `rgba(255,70,70,${(0.55 + pulse * 0.45).toFixed(2)})`
    : 'rgba(80,200,255,0.5)';

  octagonPath(cx, cy, r);
  ctx.fillStyle = 'rgba(8,14,18,0.85)';
  ctx.fill();

  ctx.save();
  ctx.shadowBlur = low ? 8 + pulse * 6 : 5;
  ctx.shadowColor = glowColor;
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = borderColor;
  ctx.stroke();
  ctx.restore();

  octagonPath(cx, cy, r - 5);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.font = `11px ${MONO_FONT_STACK}`;
  ctx.fillStyle = '#9fd8ff';
  ctx.fillText('剩餘時間', cx, cy - r - 8);

  ctx.fillStyle = low ? borderColor : '#fff';
  ctx.font = `bold 26px ${MONO_FONT_STACK}`;
  ctx.fillText(Math.ceil(game.timer).toString(), cx, cy + 9);
}

function drawHUD() {
  ctx.fillStyle = 'rgba(10,10,14,0.85)';
  ctx.fillRect(0, 0, 1920, PLAY_TOP);

  drawCountdownTimer();

  // Delivered scores flanking the timer
  ctx.font = 'bold 26px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = TEAM_TINT.red;
  ctx.fillText(`🔴 ${teams.red.delivered}`, 880, 58);
  ctx.textAlign = 'left';
  ctx.fillStyle = TEAM_TINT.blue;
  ctx.fillText(`${teams.blue.delivered} 🔵`, 1040, 58);

  ctx.textAlign = 'center';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillStyle = '#ffdd66';
  ctx.fillText(currentMap().name, 960, 112);
}

function drawHazardCornerStripes(x, y, w, h, cut) {
  const corners = [
    { cx: x, cy: y, flip: [1, 1] },
    { cx: x + w, cy: y, flip: [-1, 1] },
    { cx: x, cy: y + h, flip: [1, -1] },
    { cx: x + w, cy: y + h, flip: [-1, -1] },
  ];
  corners.forEach(({ cx, cy, flip }) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(flip[0], flip[1]);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(cut, 0);
    ctx.lineTo(0, cut);
    ctx.closePath();
    ctx.clip();
    for (let i = -cut; i < cut * 2; i += 8) {
      ctx.strokeStyle = (Math.round(i / 8) % 2 === 0) ? '#f2c94c' : '#111';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(i, -cut);
      ctx.lineTo(i + cut * 2, cut);
      ctx.stroke();
    }
    ctx.restore();
  });
}

function drawDecoratedPanel(x, y, w, h) {
  const cut = 26;

  chamferedRectPath(x, y, w, h, cut);
  ctx.fillStyle = 'rgba(8,16,16,0.55)';
  ctx.fill();

  ctx.save();
  ctx.shadowBlur = 14;
  ctx.shadowColor = 'rgba(80,200,255,0.5)';
  chamferedRectPath(x, y, w, h, cut);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#5fd0ff';
  ctx.stroke();
  ctx.restore();

  chamferedRectPath(x + 5, y + 5, w - 10, h - 10, Math.max(1, cut - 7));
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.stroke();

  drawHazardCornerStripes(x, y, w, h, cut);
}

function drawOverlay(title, lines, promptLine, decorated, titleColor) {
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(0, 0, 1920, 1080);

  if (decorated) {
    const panelW = 1140;
    const panelTop = 330;
    const contentBottom = promptLine
      ? 490 + lines.length * 40 + 50 + 30
      : 490 + lines.length * 40 + 20;
    drawDecoratedPanel(960 - panelW / 2, panelTop, panelW, contentBottom - panelTop);
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = titleColor || '#fff';
  ctx.font = 'bold 56px sans-serif';
  ctx.fillText(title, 960, 420);
  ctx.fillStyle = '#fff';
  ctx.font = '26px sans-serif';
  lines.forEach((line, i) => ctx.fillText(line, 960, 490 + i * 40));
  if (promptLine) {
    ctx.font = '22px sans-serif';
    ctx.fillStyle = '#ffdd66';
    ctx.fillText(promptLine, 960, 490 + lines.length * 40 + 50);
  }
}

function render() {
  ctx.clearRect(0, 0, 1920, 1080);

  if (!teams) { return; }

  drawWorld();
  drawHUD();

  if (game.state === 'INTRO') {
    const map = currentMap();
    drawOverlay(map.name, [
      map.goal,
      `🔴 紅隊 左→右　vs　🔵 藍隊 右→左`,
      `限時 ${map.timeLimit} 秒，時間到比送達數量！`,
    ], '即將開始...', true);
  } else if (game.state === 'GAME_OVER') {
    if (game.winner) {
      drawOverlay(
        `${TEAM_LABEL[game.winner]} 獲勝！`,
        [game.winReason, `送達數　🔴 ${teams.red.delivered} : ${teams.blue.delivered} 🔵`],
        '', true,
        TEAM_TINT[game.winner]
      );
    } else {
      drawOverlay('平手！', [game.winReason], '', true);
    }
  }
}

/* =========================================================================
   EXPORTS
   ========================================================================= */
export function initGame(endCallback, playerMap, mapIndex, playerNames) {
  _endCallback = endCallback;
  _playerMap = playerMap;
  _playerNames = playerNames ?? {};
  ensureAudio();
  startMatch(mapIndex ?? 0);
}

export function updateGame(dt) {
  update(dt);
}

export function drawGame(newCtx, w, h) {
  ctx = newCtx;
  ctx.save();
  const scale = Math.min(w / 1920, h / 1080);
  const offsetX = (w - 1920 * scale) / 2;
  const offsetY = (h - 1080 * scale) / 2;
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  render();
  ctx.restore();
}

export function setPlayerInput(deviceId, data) {
  const pid = _playerMap[String(deviceId)];
  if (!pid) return;
  if (data.action === 'move') {
    _playerAxis[pid] = { x: data.dx ?? 0, y: data.dy ?? 0 };
  }
}

export function cleanupGame() {
  teams = null;
  world.zombies = [];
  _endCallback = null;
  _playerMap = {};
  _playerNames = {};
  for (const pid of ALL_PIDS) _playerAxis[pid] = { x: 0, y: 0 };
  game.state = 'INTRO';
  game.ended = false;
  game.winner = null;
}
