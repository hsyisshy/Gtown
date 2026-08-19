/**
 * 農場卡車大亂鬥 — ported from truck_animal-main/index.html
 *
 * Red vs blue, 3 trucks per team (playersPerTeam: 3); requireFullTeams means
 * both sides always field exactly 3 real players before the match can start.
 *
 * Controls (one button): hold A to dash straight ahead, release to spin in
 * place hunting for a direction — the prototype's spin-dash player mode.
 *
 * Physics runs in a fixed logical space (1600x900) so tuning is independent
 * of the screen resolution; draw() uniform-scales + letterboxes into the
 * actual canvas. The arena ellipse itself is shrunk well inside that space
 * (see ARENA below) and trucks/animals drawn oversized relative to it, so
 * 3v3 stays cramped and collision-heavy instead of just scaling up 2v2.
 */
import { truncateName } from '../../shared/nameDisplay.js';
import { TEAM_COLOR } from '../../shared/constants.js';
import { preloadImages, drawAssetLoadingPlaceholder } from '../../shared/assetPreload.js';
import { bgm, SFX } from './audio.js';

const LOGICAL_W = 1600, LOGICAL_H = 900;
const ARENA = { cx: LOGICAL_W / 2, cy: LOGICAL_H / 2, rx: 580, ry: 300 };

const ROUND_TIME = 65;
const TRUCKS_PER_TEAM = 3;

const TRUCK_W = 64, TRUCK_H = 37, TRUCK_RADIUS = 34;
const MAX_SPEED = 320, ACCEL = 480, DECEL = 340;
const SPIN_RATE = 3.6;      // 沒按加速時原地自轉的角速度
const HIT_COOLDOWN = 0.6;
const MIN_HIT_DIFF = 90;    // 速度差(或撞牆時的速度)要超過這個值才算「撞到」

const WANDER_SPEED = 55;
const ANIMAL_DRAW_SIZE = 38;

const ANIMAL_IMAGE_NAMES = ['elephant', 'giraffe', 'hippo', 'monkey', 'panda', 'parrot', 'penguin', 'pig', 'rabbit', 'snake'];
let animalImages = null;
function loadAnimalImages() {
  if (animalImages) return;
  animalImages = ANIMAL_IMAGE_NAMES.map(name => {
    const img = new Image();
    img.src = `04_truck/animals/${name}.png`;
    return img;
  });
}

const arenaBgImg = new Image();
arenaBgImg.src = '04_truck/truck_bg.png';

const TRUCK_DRAW_W = 74; // slightly larger than the flat-rect footprint (64) — the art reads better a touch bigger
const TRUCK_SPRITES = {
  red: new Image(),
  blue: new Image(),
};
TRUCK_SPRITES.red.src = '04_truck/characters/truck2.png';
TRUCK_SPRITES.blue.src = '04_truck/characters/truck.png';
// The new art draws the cab on the left / bed on the right — backwards
// relative to angle=0 meaning "facing +x" — so flip 180° at draw time
// rather than re-export mirrored assets.
const TRUCK_SPRITE_ROTATION = Math.PI;

let tk = null; // module-level game state

function rand(a, b) { return a + Math.random() * (b - a); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function ellipseClamp(x, y, radius) {
  const dx = x - ARENA.cx, dy = y - ARENA.cy;
  const rx = Math.max(1, ARENA.rx - radius), ry = Math.max(1, ARENA.ry - radius);
  const u = dx / rx, v = dy / ry;
  const n = Math.hypot(u, v);
  if (n > 1 && n > 0.0001) {
    const k = 1 / n;
    const px = dx * k, py = dy * k;
    let gx = px / (rx * rx), gy = py / (ry * ry);
    const gl = Math.hypot(gx, gy) || 1;
    return { hit: true, x: ARENA.cx + px, y: ARENA.cy + py, nx: gx / gl, ny: gy / gl };
  }
  return { hit: false, x, y };
}

function makeTruck(x, y, angle, team, deviceId, name) {
  const cargo = [];
  const startN = Math.floor(rand(3, 6));
  for (let i = 0; i < startN; i++) cargo.push(animalImages[Math.floor(rand(0, animalImages.length))]);
  return {
    x, y, angle, speed: 0,
    team, deviceId, name,
    color: TEAM_COLOR[team],
    accel: false,           // controller holds A → true
    cargo,
    hitTimer: 0,
  };
}

function makeAnimal(x, y, img) {
  return {
    x, y, img,
    state: 'flying',
    vx: 0, vy: 0, z: 0, zVel: 0,
    spin: 0, rot: 0,
    wanderAngle: rand(0, Math.PI * 2),
    wanderTimer: rand(0.5, 1.5),
    flightTimer: 0,
    picked: false,
  };
}

function launchAnimal(a, dirAngle, power, mode) {
  const ang = mode === 'full' ? rand(0, Math.PI * 2) : dirAngle + rand(-0.6, 0.6);
  const speed = 120 + power * 1.4;
  a.vx = Math.cos(ang) * speed;
  a.vy = Math.sin(ang) * speed;
  a.zVel = 140 + power * 0.5;
  a.spin = rand(8, 16) * (Math.random() < 0.5 ? -1 : 1);
  a.flightTimer = rand(0.5, 0.9);
}

function ejectAnimals(truck, dirAngle, impactSpeed, mode, count) {
  const n = Math.min(count, truck.cargo.length);
  for (let i = 0; i < n; i++) {
    const img = truck.cargo.pop();
    const a = makeAnimal(truck.x, truck.y, img);
    launchAnimal(a, dirAngle, impactSpeed, mode);
    tk.animals.push(a);
  }
  if (n > 0 && truck.deviceId) _vibratePlayer(tk._globalState, truck.deviceId);
}

// --- per-frame systems --------------------------------------------------

function truckInput(t, dt) {
  if (t.accel) {
    t.speed = Math.min(MAX_SPEED, t.speed + ACCEL * dt);
  } else {
    t.angle += SPIN_RATE * dt;
    if (t.speed > 0) t.speed = Math.max(0, t.speed - DECEL * dt);
  }
}

function truckMove(t, dt) {
  t.x += Math.cos(t.angle) * t.speed * dt;
  t.y += Math.sin(t.angle) * t.speed * dt;

  const c = ellipseClamp(t.x, t.y, TRUCK_RADIUS);
  if (c.hit) {
    const impactSpeed = Math.abs(t.speed);
    t.x = c.x; t.y = c.y;
    t.speed *= -0.4;
    if (impactSpeed > MIN_HIT_DIFF && t.hitTimer <= 0 && t.cargo.length > 0) {
      const inwardAngle = Math.atan2(-c.ny, -c.nx);
      const n = Math.max(1, Math.round(t.cargo.length * 0.5)); // 撞牆固定掉一半
      ejectAnimals(t, inwardAngle, impactSpeed, 'cone', n);
      t.hitTimer = HIT_COOLDOWN;
      SFX.crash();
    }
  }
  if (t.hitTimer > 0) t.hitTimer -= dt;
}

function handleTruckCollisions() {
  const trucks = tk.trucks;
  for (let i = 0; i < trucks.length; i++) {
    for (let j = i + 1; j < trucks.length; j++) {
      const a = trucks[i], b = trucks[j];
      if (dist(a, b) > TRUCK_RADIUS * 1.5) continue;
      const sa = Math.abs(a.speed), sb = Math.abs(b.speed);
      const angleAB = Math.atan2(b.y - a.y, b.x - a.x);
      const overlap = TRUCK_RADIUS * 1.5 - dist(a, b);
      a.x -= Math.cos(angleAB) * overlap * 0.5;
      a.y -= Math.sin(angleAB) * overlap * 0.5;
      b.x += Math.cos(angleAB) * overlap * 0.5;
      b.y += Math.sin(angleAB) * overlap * 0.5;

      if (a.hitTimer > 0 || b.hitTimer > 0) continue;
      const diff = Math.abs(sa - sb);
      if (diff < MIN_HIT_DIFF) continue; // 速度差太小,輕輕碰不噴

      const impactSpeed = Math.max(sa, sb);
      const ratio = clamp(diff / MAX_SPEED, 0, 1); // 全速 vs 靜止 = 1 = 全噴
      SFX.crash();
      if (sa < sb) {
        if (a.cargo.length > 0) ejectAnimals(a, angleAB + Math.PI, impactSpeed, 'full', Math.max(1, Math.round(a.cargo.length * ratio)));
        a.speed = -sa * 0.6;
        a.hitTimer = HIT_COOLDOWN;
        b.hitTimer = HIT_COOLDOWN * 0.3;
      } else {
        if (b.cargo.length > 0) ejectAnimals(b, angleAB, impactSpeed, 'full', Math.max(1, Math.round(b.cargo.length * ratio)));
        b.speed = -sb * 0.6;
        b.hitTimer = HIT_COOLDOWN;
        a.hitTimer = HIT_COOLDOWN * 0.3;
      }
    }
  }
}

function updateAnimal(a, dt) {
  if (a.state === 'flying') {
    a.x += a.vx * dt;
    a.y += a.vy * dt;
    a.vx *= 0.985; a.vy *= 0.985;
    a.z += a.zVel * dt;
    a.zVel -= 260 * dt;
    a.rot += a.spin * dt;
    a.flightTimer -= dt;
    if (a.z <= 0 && a.flightTimer <= 0) {
      a.z = 0; a.state = 'wandering';
    }
  } else {
    a.wanderTimer -= dt;
    if (a.wanderTimer <= 0) {
      a.wanderAngle += rand(-1.2, 1.2);
      a.wanderTimer = rand(0.6, 1.8);
    }
    a.x += Math.cos(a.wanderAngle) * WANDER_SPEED * dt;
    a.y += Math.sin(a.wanderAngle) * WANDER_SPEED * dt;
  }

  const c = ellipseClamp(a.x, a.y, 6);
  if (c.hit) {
    a.x = c.x; a.y = c.y;
    if (a.state === 'flying') {
      const dot = a.vx * c.nx + a.vy * c.ny;
      a.vx -= 2 * dot * c.nx;
      a.vy -= 2 * dot * c.ny;
    } else {
      let vx = Math.cos(a.wanderAngle), vy = Math.sin(a.wanderAngle);
      const dot = vx * c.nx + vy * c.ny;
      vx -= 2 * dot * c.nx; vy -= 2 * dot * c.ny;
      a.wanderAngle = Math.atan2(vy, vx);
    }
  }
}

function handlePickups() {
  for (const truck of tk.trucks) {
    for (const a of tk.animals) {
      if (a.state !== 'wandering' || a.picked) continue;
      if (dist(truck, a) < TRUCK_RADIUS) {
        a.picked = true;
        truck.cargo.push(a.img);
      }
    }
  }
  tk.animals = tk.animals.filter(a => !a.picked);
}

// --- game module ----------------------------------------------------------

export default {
  id: 'truck',
  name: '卡車亂鬥',
  description: '衝撞對手，搶收噴飛的動物',
  playersPerTeam: TRUCKS_PER_TEAM,
  requireFullTeams: true,
  color: '#7ec850',
  emoji: '🚚',
  cover: '04_truck/truck_cover.png',

  tutorial: {
    pages: [
      '04_truck/tutorial/1.png',
      '04_truck/tutorial/2.png',
      '04_truck/tutorial/3.png',
    ],
  },

  preload() {
    loadAnimalImages();
    return preloadImages([arenaBgImg, TRUCK_SPRITES.red, TRUCK_SPRITES.blue, ...animalImages]);
  },

  onStart(globalState, endCb) {
    loadAnimalImages();
    bgm.start();

    // requireFullTeams guarantees exactly TRUCKS_PER_TEAM real players per side.
    const active = globalState.activePlayers || {};
    const teams  = globalState.teams || {};
    const playing = Object.entries(active)
      .filter(([, role]) => role === 'playing')
      .map(([id]) => id);
    const redIds  = playing.filter(id => teams[id] === 'red');
    const blueIds = playing.filter(id => teams[id] === 'blue');

    // Spawn corners: red team on the left, blue on the right, each side's
    // trucks stacked in an evenly-spaced vertical row.
    const { cx, cy, rx, ry } = ARENA;
    const ox = rx * 0.45, oy = ry * 0.5;
    const spawnRow = (x, angle) => Array.from({ length: TRUCKS_PER_TEAM }, (_, i) => ({
      x, y: cy - oy + (oy * 2 * i) / (TRUCKS_PER_TEAM - 1), a: angle,
    }));
    const spawns = {
      red:  spawnRow(cx - ox, 0),
      blue: spawnRow(cx + ox, Math.PI),
    };

    const trucks = [];
    for (const team of ['red', 'blue']) {
      const teamIds = team === 'red' ? redIds : blueIds;
      teamIds.forEach((deviceId, slot) => {
        const s = spawns[team][slot];
        trucks.push(makeTruck(s.x, s.y, s.a, team, deviceId, _name(globalState, deviceId)));
      });
    }

    tk = {
      trucks,
      animals: [],
      timeLeft: ROUND_TIME,
      finished: false,
      assetsReady: false,
      _endCb: endCb,
      _globalState: globalState,
    };
    preloadImages([arenaBgImg, TRUCK_SPRITES.red, TRUCK_SPRITES.blue, ...animalImages])
      .then(() => { if (tk) tk.assetsReady = true; });
  },

  update(dt, globalState) {
    if (!tk || tk.finished || !tk.assetsReady) return;

    for (const t of tk.trucks) truckInput(t, dt);
    for (const t of tk.trucks) truckMove(t, dt);
    handleTruckCollisions();
    for (const a of tk.animals) updateAnimal(a, dt);
    handlePickups();

    tk.timeLeft -= dt;
    if (tk.timeLeft <= 0) {
      tk.timeLeft = 0;
      _finish(globalState);
    }
  },

  draw(ctx, w, h) {
    if (!tk) return;
    if (!tk.assetsReady) { drawAssetLoadingPlaceholder(ctx, w, h, '卡車亂鬥'); return; }

    // Letterbox: uniform scale of the 1600x900 logical space
    const scale = Math.min(w / LOGICAL_W, h / LOGICAL_H);
    const offX = (w - LOGICAL_W * scale) / 2;
    const offY = (h - LOGICAL_H * scale) / 2;

    ctx.fillStyle = '#2b2f36';
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);

    drawArena(ctx);
    for (const a of tk.animals) drawAnimal(ctx, a);
    const leaderCargo = Math.max(0, ...tk.trucks.map(t => t.cargo.length));
    for (const t of tk.trucks) drawTruck(ctx, t, leaderCargo);
    drawHud(ctx);

    ctx.restore();
  },

  onInput(deviceId, data) {
    if (!tk) return;
    const did = String(deviceId);
    const truck = tk.trucks.find(t => t.deviceId != null && String(t.deviceId) === did);
    if (!truck) return;

    if (data.action === 'accel') truck.accel = !!data.pressed;
  },

  onEnd() {
    bgm.stop();
    tk = null;
  },
};

// --- drawing ---------------------------------------------------------------

function drawArena(ctx) {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(ARENA.cx, ARENA.cy, ARENA.rx, ARENA.ry, 0, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (arenaBgImg.complete && arenaBgImg.naturalWidth) {
    ctx.drawImage(arenaBgImg, 0, 0, LOGICAL_W, LOGICAL_H);
  } else {
    ctx.fillStyle = '#7ec850';
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
  }
  ctx.restore();

  ctx.strokeStyle = '#5a3d2b';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.ellipse(ARENA.cx, ARENA.cy, ARENA.rx, ARENA.ry, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawTruck(ctx, t, leaderCargo) {
  const sprite = TRUCK_SPRITES[t.team];
  ctx.save();
  ctx.translate(t.x, t.y);
  if (sprite.complete && sprite.naturalWidth) {
    ctx.rotate(t.angle + TRUCK_SPRITE_ROTATION);
    const drawW = TRUCK_DRAW_W;
    const drawH = drawW * (sprite.naturalHeight / sprite.naturalWidth);
    if (t.hitTimer > 0) ctx.filter = 'brightness(1.7) saturate(0.6)';
    ctx.drawImage(sprite, -drawW / 2, -drawH / 2, drawW, drawH);
  } else {
    ctx.rotate(t.angle);
    ctx.fillStyle = t.hitTimer > 0 ? '#ffffffaa' : t.color;
    ctx.fillRect(-TRUCK_W / 2, -TRUCK_H / 2, TRUCK_W, TRUCK_H);
    ctx.fillStyle = '#222';
    ctx.fillRect(TRUCK_W / 2 - 8, -TRUCK_H / 2, 8, TRUCK_H);
  }
  ctx.restore();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 15px "Noto Sans TC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${t.name} 🐾${t.cargo.length}`, t.x, t.y - 34);

  if (leaderCargo > 0 && t.cargo.length === leaderCargo) {
    ctx.font = '22px sans-serif';
    ctx.fillText('👑', t.x, t.y - 54);
  }
}

function drawAnimal(ctx, a) {
  ctx.save();
  ctx.translate(a.x, a.y - a.z);
  ctx.rotate(a.rot);
  ctx.globalAlpha = a.state === 'flying' ? 0.5 : 1;
  const s = ANIMAL_DRAW_SIZE;
  ctx.drawImage(a.img, -s / 2, -s / 2, s, s);
  ctx.restore();
  if (a.z > 2) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(a.x, a.y, 10, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHud(ctx) {
  const redTotal  = _teamTotal('red');
  const blueTotal = _teamTotal('blue');

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = 'bold 34px "Noto Sans TC", sans-serif';
  ctx.fillStyle = '#fff';
  ctx.fillText(`⏱ ${Math.ceil(tk.timeLeft)}`, LOGICAL_W / 2, 14);

  ctx.font = 'bold 26px "Noto Sans TC", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = TEAM_COLOR.red;
  ctx.fillText(`🔴 ${redTotal}`, 40, 18);
  ctx.textAlign = 'right';
  ctx.fillStyle = TEAM_COLOR.blue;
  ctx.fillText(`${blueTotal} 🔵`, LOGICAL_W - 40, 18);
}

// --- helpers ----------------------------------------------------------------

function _teamTotal(team) {
  return tk.trucks.filter(t => t.team === team)
    .reduce((sum, t) => sum + t.cargo.length, 0);
}

function _name(globalState, deviceId) {
  return truncateName(globalState.players?.[deviceId]?.name ?? `Player ${deviceId}`);
}

function _vibratePlayer(globalState, deviceId) {
  if (!deviceId) return;
  if (!globalState._pendingMessages) globalState._pendingMessages = [];
  globalState._pendingMessages.push({ type: 'hit_confirm', deviceId: String(deviceId) });
}

function _finish(globalState) {
  if (!tk || tk.finished) return;
  tk.finished = true;

  // Credit each human player's cargo count to the hub scoreboard
  for (const t of tk.trucks) {
    if (t.deviceId && globalState.players?.[t.deviceId]) {
      globalState.players[t.deviceId].score =
        (globalState.players[t.deviceId].score || 0) + t.cargo.length;
    }
  }

  const red = _teamTotal('red'), blue = _teamTotal('blue');
  const winnerTeam = red > blue ? 'red' : blue > red ? 'blue' : null;
  tk._endCb?.(winnerTeam);
}
