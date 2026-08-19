/**
 * 仿畫行動 — ported from painting_sticker/game.js.
 *
 * Red vs blue, 1 active cursor per team (playersPerTeam: 1). Each team grabs
 * torn-paper pieces from its own rack and drops them onto its own canvas,
 * racing to reproduce the reference painting before time runs out. Score is
 * a color-similarity comparison against the source painting, hidden until
 * the reveal at the end (matches the original's "don't peek at your score
 * mid-match" design).
 *
 * The original's AI opponent, random "干擾" events, and its standalone
 * WebSocket coop room are dropped — the hub already provides real opponents
 * and networking. The shared item pickup (stun/shake/peek) is kept, ported
 * from the original's ITEM_DEFS. See painting_sticker/GDD_定案.md for the
 * source design doc.
 *
 * Pieces are generated at runtime (not pre-cut PNGs) via tear.js's
 * Voronoi + torn-edge algorithm, so only one raw.png per painting ships.
 */
import { truncateName } from '../../shared/nameDisplay.js';
import { generatePieces, computeGridForCount, tearEdge, mulberry32 } from './tear.js';
import {
  LOGICAL_W, LOGICAL_H,
  PLAY_SECONDS, PIECES_PER_TEAM, RACK_SCALE, CURSOR_SIZE, MOVE_SPEED,
  ALPHA_HIT_THRESHOLD, SCORE_SAMPLE_W, BONUS_RATE, BONUS_CAP, RESULT_HOLD_SECONDS,
  TEAR_CONFIG,
  LEFT_X, MID_X, RIGHT_X, SIDE_W, MID_W,
  TIMER_Y, TIMER_H, CONTENT_TOP, CONTENT_BOTTOM,
  HEADER_H, RACK_Y, RACK_H, CANVAS_Y, CANVAS_H,
  PREVIEW_Y, PREVIEW_H, ITEMS_Y, ITEMS_H, SCORE_Y, SCORE_H,
  ITEM_DEFS, ITEM_EFFECT_SECONDS, ITEM_SHAKE_COUNT, ITEM_SPAWN_INTERVAL, ITEM_SPAWN_CUTOFF,
} from './config.js';
import { bgm, SFX } from './audio.js';

const TEAM_MAIN = { red: '#C4694A', blue: '#4A7C82' };
const TEAM_DIM  = { red: '#8B4A34', blue: '#33565A' };
const TEAM_LABEL = { red: '紅隊', blue: '藍隊' };
// Matches the phone controller's --btn-color for .btn-a/.btn-b (src/controller/style.css)
// so an on-screen "按 A/B" hint reads as the same color as the physical button.
const BTN_A_COLOR = '#e9908f';
const BTN_B_COLOR = '#f4d879';
const ITEM_BOX = { x: MID_X, y: ITEMS_Y, w: MID_W, h: ITEMS_H };

// ---- 牛皮紙拼貼美術主題 — ported from root game.js (the original single-device
// prototype this game was built from; see its drawPaperPanel/drawTapeCorner/
// getPaperPattern/getCorkPattern/drawConfetti/drawWinnerBanner). The torn-edge
// panels reuse tear.js's own midpoint-displacement recipe (tearEdge) so the
// UI's "ripped paper" look matches the pieces' actual torn edges. ----
const INK = '#33302A';
const KRAFT = '#E8D9BE';
const CREAM = '#F5EFE0';
const CARDBOARD = '#D9C9A8';
const TAPE = '#E8B94A';
const FONT_DISPLAY = '"Baloo 2", "Noto Sans TC", sans-serif';
const FONT_BODY = '"Nunito", "Noto Sans TC", sans-serif';

let pg = null; // module-level match state

// Unlike the other games' module-level Image singletons, this game's assets
// (which painting, how it's torn) are randomized fresh per match — so
// there's nothing to front-load until a match is actually about to happen.
// preload() kicks the random pick + tear off as early as game-select time
// and caches the in-flight promise; onStart() just awaits the same promise
// instead of starting over, so by the time PREP's reveal + ready-roster
// wait + the how-to-play card are done, the painting is very likely already
// torn and ready — often skipping the in-game "loading" phase entirely.
let _preloadPromise = null;
function ensurePreload() {
  if (!_preloadPromise) _preloadPromise = loadPaintingAndPieces();
  return _preloadPromise;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('載入失敗: ' + src));
    img.src = src;
  });
}

// ---- Asset loading (one painting shared by both teams' racks) -------------
async function loadPaintingAndPieces() {
  const manifest = await (await fetch('07_painting-sticker/paintings/manifest.json')).json();
  const paintingId = manifest[Math.floor(Math.random() * manifest.length)];
  const rawImage = await loadImage(`07_painting-sticker/paintings/${paintingId}/raw.png`);
  const seed = Math.floor(Math.random() * 2147483647);
  const grid = computeGridForCount(PIECES_PER_TEAM);
  const config = { ...TEAR_CONFIG, cols: grid.cols, rows: grid.rows, randomSeed: seed };

  const result = generatePieces(rawImage, config, seed);
  const assets = {
    paintingId,
    rawImage,
    srcW: result.sourceW,
    srcH: result.sourceH,
    pieceW: result.canvasW,
    pieceH: result.canvasH,
    pieces: result.pieces,
    pieceImages: result.pieceCanvases,
    pieceAlphaMasks: {},
    pieceCentroids: {},
    alphaMasksAvailable: true,
    emptyBaselineDiff: 1,
  };
  buildAlphaMasks(assets);
  assets.emptyBaselineDiff = computeEmptyBaselineDiff(assets.rawImage);
  return assets;
}

// Reads each piece's actual opaque-pixel footprint (not its square canvas)
// so grabbing/placing hit-tests the visible shape, not its bounding box —
// pieces overlap on purpose, so the bounding box would make adjacent pieces
// steal each other's clicks.
function buildAlphaMasks(assets) {
  try {
    for (const p of assets.pieces) {
      const octx = assets.pieceImages[p.id].getContext('2d');
      const data = octx.getImageData(0, 0, assets.pieceW, assets.pieceH).data;
      const alpha = new Uint8Array(assets.pieceW * assets.pieceH);
      let sumX = 0, sumY = 0, count = 0;
      for (let i = 0; i < alpha.length; i++) {
        const a = data[i * 4 + 3];
        alpha[i] = a;
        if (a > ALPHA_HIT_THRESHOLD) {
          sumX += i % assets.pieceW;
          sumY += (i / assets.pieceW) | 0;
          count++;
        }
      }
      assets.pieceAlphaMasks[p.id] = alpha;
      assets.pieceCentroids[p.id] = count > 0
        ? { x: sumX / count, y: sumY / count }
        : { x: assets.pieceW / 2, y: assets.pieceH / 2 };
    }
  } catch (err) {
    console.warn('[painting-sticker] cannot read piece alpha data, falling back to bounding-box hit-test', err);
    assets.alphaMasksAvailable = false;
  }
}

function isOpaqueAt(assets, pieceId, localX, localY) {
  if (localX < 0 || localX >= assets.pieceW || localY < 0 || localY >= assets.pieceH) return false;
  if (!assets.alphaMasksAvailable) return true;
  const idx = (localY | 0) * assets.pieceW + (localX | 0);
  return assets.pieceAlphaMasks[pieceId][idx] > ALPHA_HIT_THRESHOLD;
}

// ---- Layout -----------------------------------------------------------
function makeAreas(x) {
  return {
    header: { x, y: CONTENT_TOP, w: SIDE_W, h: HEADER_H },
    rack:   { x, y: RACK_Y,      w: SIDE_W, h: RACK_H },
    canvas: { x, y: CANVAS_Y,    w: SIDE_W, h: CANVAS_H },
  };
}

function computeFit(area, w, h) {
  const scale = Math.min(area.w / w, area.h / h);
  return {
    scale,
    offsetX: area.x + (area.w - w * scale) / 2,
    offsetY: area.y + (area.h - h * scale) / 2,
  };
}

function rectContains(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function scatterRackPieces(pieces, rackArea, pieceW, pieceH) {
  const thumbW = pieceW * RACK_SCALE;
  const thumbH = pieceH * RACK_SCALE;
  const margin = 6;
  const minCenterDist = Math.min(thumbW, thumbH) * 1.15;
  const placedCenters = [];
  return pieces.map((p) => {
    let x, y, cx, cy, tries = 0;
    do {
      x = rackArea.x + margin + Math.random() * (rackArea.w - thumbW - margin * 2);
      y = rackArea.y + margin + Math.random() * (rackArea.h - thumbH - margin * 2);
      cx = x + thumbW / 2;
      cy = y + thumbH / 2;
      tries++;
    } while (tries < 40 && placedCenters.some((c) => Math.hypot(cx - c.x, cy - c.y) < minCenterDist));
    placedCenters.push({ x: cx, y: cy });
    return { ...p, taken: false, rackX: x, rackY: y };
  });
}

function createTeam(key, x, deviceId, name, assets) {
  const areas = makeAreas(x);
  const rackPieces = scatterRackPieces(assets.pieces, areas.rack, assets.pieceW, assets.pieceH);
  const canvasFit = computeFit(areas.canvas, assets.srcW, assets.srcH);
  return {
    key,
    deviceId,
    name,
    areas,
    canvasFit,
    rackPieces,
    placedPieces: [],
    carrying: null,
    cursor: { x: areas.rack.x + areas.rack.w / 2, y: areas.rack.y + areas.rack.h / 2 },
    move: { dx: 0, dy: 0 },
    score: 0,
    finished: false,
    finishBonus: 0,
    stunTimer: 0,
    peekTimer: 0,
  };
}

// ---- Grab / place -----------------------------------------------------
function findRackPieceAt(assets, team, x, y) {
  let best = null, bestDist = Infinity;
  const w = assets.pieceW * RACK_SCALE, h = assets.pieceH * RACK_SCALE;
  for (const p of team.rackPieces) {
    if (p.taken) continue;
    const localX = (x - p.rackX) / RACK_SCALE;
    const localY = (y - p.rackY) / RACK_SCALE;
    if (!isOpaqueAt(assets, p.id, localX, localY)) continue;
    const cx = p.rackX + w / 2, cy = p.rackY + h / 2;
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

function findPlacedPieceAt(assets, team, x, y) {
  const { scale, offsetX, offsetY } = team.canvasFit;
  const relX = (x - offsetX) / scale, relY = (y - offsetY) / scale;
  for (let i = team.placedPieces.length - 1; i >= 0; i--) {
    const pp = team.placedPieces[i];
    if (isOpaqueAt(assets, pp.id, relX - pp.source_x, relY - pp.source_y)) return i;
  }
  return -1;
}

function handleAction(assets, team) {
  const { x: cx, y: cy } = team.cursor;
  if (!team.carrying) {
    if (rectContains(team.areas.rack, cx, cy)) {
      const p = findRackPieceAt(assets, team, cx, cy);
      if (p) { p.taken = true; team.carrying = { id: p.id }; SFX.grab(); }
    } else if (rectContains(team.areas.canvas, cx, cy)) {
      const idx = findPlacedPieceAt(assets, team, cx, cy);
      if (idx >= 0) {
        const [pp] = team.placedPieces.splice(idx, 1);
        team.carrying = { id: pp.id };
        SFX.grab();
      }
    }
  } else if (rectContains(team.areas.canvas, cx, cy)) {
    const { scale, offsetX, offsetY } = team.canvasFit;
    const source_x = (cx - offsetX) / scale - assets.pieceW / 2;
    const source_y = (cy - offsetY) / scale - assets.pieceH / 2;
    team.placedPieces.push({ id: team.carrying.id, source_x, source_y });
    team.carrying = null;
  } else {
    const rp = team.rackPieces.find((p) => p.id === team.carrying.id);
    if (rp) rp.taken = false;
    team.carrying = null;
  }
}

function moveCursor(team, dt) {
  if (team.stunTimer > 0) return;
  const { dx, dy } = team.move;
  if (!dx && !dy) return;
  // Full content width (not just this team's own side) — the shared item
  // box sits in the middle strip, so either cursor needs to be able to
  // travel there to race for it.
  const bounds = {
    x: LEFT_X,
    y: team.areas.header.y,
    w: RIGHT_X + SIDE_W - LEFT_X,
    h: team.areas.canvas.y + team.areas.canvas.h - team.areas.header.y,
  };
  team.cursor.x = Math.max(bounds.x, Math.min(bounds.x + bounds.w, team.cursor.x + dx * MOVE_SPEED * dt));
  team.cursor.y = Math.max(bounds.y, Math.min(bounds.y + bounds.h, team.cursor.y + dy * MOVE_SPEED * dt));
}

// ---- Shared item pickup — spawns in the middle strip, either team can grab it ----
function spawnRandomItem() {
  const def = ITEM_DEFS[Math.floor(Math.random() * ITEM_DEFS.length)];
  pg.activeItem = { type: def.type };
}

function tryClaimItem(team) {
  if (!pg.activeItem) return;
  if (!rectContains(ITEM_BOX, team.cursor.x, team.cursor.y)) return;
  applyItemEffect(pg.activeItem.type, team);
  SFX.grab();
  pg.activeItem = null;
}

function applyItemEffect(type, grabber) {
  const opponent = grabber === pg.teams.red ? pg.teams.blue : pg.teams.red;
  // A team that already locked in its score can't be un-finished by stun/shake.
  if (opponent.finished && (type === 'stun' || type === 'shake')) return;
  if (type === 'stun') {
    opponent.stunTimer = ITEM_EFFECT_SECONDS;
  } else if (type === 'shake') {
    const shuffled = opponent.placedPieces.slice().sort(() => Math.random() - 0.5);
    for (const pp of shuffled.slice(0, ITEM_SHAKE_COUNT)) {
      const idx = opponent.placedPieces.indexOf(pp);
      if (idx >= 0) opponent.placedPieces.splice(idx, 1);
      const rp = opponent.rackPieces.find((p) => p.id === pp.id);
      if (rp) rp.taken = false;
    }
  } else if (type === 'peek') {
    grabber.peekTimer = ITEM_EFFECT_SECONDS;
  }
}

// ---- Scoring: composite each team's canvas, compare average color diff
// against the source painting. Hidden from the players until the reveal. ----
function averageColorDiff(canvasA, canvasB, w, h) {
  const dataA = canvasA.getContext('2d').getImageData(0, 0, w, h).data;
  const dataB = canvasB.getContext('2d').getImageData(0, 0, w, h).data;
  let total = 0;
  for (let i = 0; i < dataA.length; i += 4) {
    const dr = dataA[i] - dataB[i], dg = dataA[i + 1] - dataB[i + 1], db = dataA[i + 2] - dataB[i + 2];
    total += Math.sqrt(dr * dr + dg * dg + db * db);
  }
  return total / (w * h);
}

function drawRefSample(img, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c;
}

function computeEmptyBaselineDiff(img) {
  const w = SCORE_SAMPLE_W;
  const h = Math.round((w * img.naturalHeight) / img.naturalWidth);
  const empty = document.createElement('canvas');
  empty.width = w; empty.height = h;
  const ectx = empty.getContext('2d');
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, w, h);
  return Math.max(1, averageColorDiff(empty, drawRefSample(img, w, h), w, h));
}

function renderTeamComposite(assets, team, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cctx = c.getContext('2d');
  cctx.fillStyle = '#000';
  cctx.fillRect(0, 0, w, h);
  const scale = w / assets.srcW;
  for (const pp of team.placedPieces) {
    cctx.drawImage(assets.pieceImages[pp.id], pp.source_x * scale, pp.source_y * scale, assets.pieceW * scale, assets.pieceH * scale);
  }
  return c;
}

function computeColorSimilarity(assets, team) {
  const w = SCORE_SAMPLE_W;
  const h = Math.round((w * assets.srcH) / assets.srcW);
  const teamCanvas = renderTeamComposite(assets, team, w, h);
  const refCanvas = drawRefSample(assets.rawImage, w, h);
  const avgDiff = averageColorDiff(teamCanvas, refCanvas, w, h);
  return Math.max(0, Math.min(100, 100 * (1 - avgDiff / assets.emptyBaselineDiff)));
}

function computeEarlyFinishBonus(remainingSeconds) {
  return Math.min(BONUS_CAP, BONUS_RATE * Math.sqrt(Math.max(0, remainingSeconds)));
}

function finishTeamEarly(assets, team, remainingSeconds) {
  if (team.finished) return;
  const bonus = computeEarlyFinishBonus(remainingSeconds);
  team.score = Math.min(100, computeColorSimilarity(assets, team) + bonus);
  team.finished = true;
  team.finishBonus = bonus;
}

// ---- 牛皮紙拼貼美術主題：撕紙面板 + 紙膠帶 + 材質紋理 ---------------------

// 每個面板的位置/大小/seed 都是固定的，撕紙路徑只要算一次就能快取起來，不必
// 每一幀都重新跑 tearEdge。
const tornRectCache = new Map();
function getTornRectPoints(x, y, w, h, seed) {
  const key = `${x}|${y}|${w}|${h}|${seed}`;
  let pts = tornRectCache.get(key);
  if (pts) return pts;
  const rand = mulberry32(seed);
  const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  pts = [];
  for (let i = 0; i < corners.length; i++) {
    const segPts = tearEdge(corners[i], corners[(i + 1) % corners.length], 2.4, 3, 0.55, rand);
    for (let k = 0; k < segPts.length - 1; k++) pts.push(segPts[k]);
  }
  tornRectCache.set(key, pts);
  return pts;
}

function tornRectPath(ctx, x, y, w, h, seed) {
  const pts = getTornRectPoints(x, y, w, h, seed);
  ctx.beginPath();
  pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
  ctx.closePath();
}

// 一塊撕紙面板：陰影只套在填色上（讓紙看起來微微浮起），邊緣再疊一道細墨線描邊
function drawPaperPanel(ctx, x, y, w, h, seed, fillStyle) {
  ctx.save();
  ctx.shadowColor = 'rgba(51, 48, 42, 0.35)';
  ctx.shadowBlur = 9;
  ctx.shadowOffsetX = 3;
  ctx.shadowOffsetY = 4;
  tornRectPath(ctx, x, y, w, h, seed);
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.restore();
  tornRectPath(ctx, x, y, w, h, seed);
  ctx.strokeStyle = 'rgba(51, 48, 42, 0.4)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

// 面板角落斜貼一小塊紙膠帶，強化隊伍色識別（取代整片實色填滿）
function drawTapeCorner(ctx, cx, cy, color, rotation) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = color;
  ctx.fillRect(-19, -7, 38, 14);
  ctx.globalAlpha = 1;
  ctx.restore();
}

// 牛皮紙紋跟軟木板紋都只需要畫一次小磁磚再用 createPattern 重複貼，避免每一幀重算噪點
let paperPatternCache = null;
function getPaperPattern(ctx) {
  if (paperPatternCache) return paperPatternCache;
  const tile = document.createElement('canvas');
  tile.width = 48; tile.height = 48;
  const tctx = tile.getContext('2d');
  tctx.fillStyle = KRAFT;
  tctx.fillRect(0, 0, 48, 48);
  const rand = mulberry32(4242);
  for (let i = 0; i < 180; i++) {
    tctx.fillStyle = rand() < 0.5 ? 'rgba(51,48,42,0.05)' : 'rgba(255,255,255,0.06)';
    tctx.fillRect(rand() * 48, rand() * 48, 1, 1);
  }
  paperPatternCache = ctx.createPattern(tile, 'repeat');
  return paperPatternCache;
}

let corkPatternCache = null;
function getCorkPattern(ctx) {
  if (corkPatternCache) return corkPatternCache;
  const tile = document.createElement('canvas');
  tile.width = 56; tile.height = 56;
  const tctx = tile.getContext('2d');
  tctx.fillStyle = '#BFA36E';
  tctx.fillRect(0, 0, 56, 56);
  const rand = mulberry32(99);
  for (let i = 0; i < 90; i++) {
    tctx.fillStyle = rand() < 0.5 ? 'rgba(51,48,42,0.1)' : 'rgba(255,236,200,0.1)';
    const r = 1 + rand() * 1.6;
    tctx.beginPath();
    tctx.arc(rand() * 56, rand() * 56, r, 0, Math.PI * 2);
    tctx.fill();
  }
  corkPatternCache = ctx.createPattern(tile, 'repeat');
  return corkPatternCache;
}

// ---- 結算慶祝：紙膠帶橫幅彈入 + 紙屑飄落（都是純函式，吃經過的時間，不用累加狀態）----
function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function generateConfetti(originX, originY) {
  const rand = mulberry32(7331);
  const colors = [TEAM_MAIN.red, TEAM_MAIN.blue, TAPE, CREAM];
  const pieces = [];
  for (let i = 0; i < 26; i++) {
    pieces.push({
      x: originX + (rand() - 0.5) * MID_W * 0.85,
      y: originY - rand() * 30,
      w: 5 + rand() * 5,
      h: 8 + rand() * 6,
      rot: rand() * Math.PI * 2,
      vRot: (rand() - 0.5) * 5,
      vx: (rand() - 0.5) * 40,
      vy: 60 + rand() * 60,
      color: colors[(rand() * colors.length) | 0],
      delay: rand() * 250,
    });
  }
  return pieces;
}

function drawConfetti(ctx, pieces, elapsedMs) {
  if (!pieces || elapsedMs > 2600) return;
  const fade = elapsedMs > 1900 ? Math.max(0, 1 - (elapsedMs - 1900) / 700) : 1;
  if (fade <= 0) return;
  ctx.save();
  ctx.globalAlpha = fade;
  for (const p of pieces) {
    const t = Math.max(0, (elapsedMs - p.delay) / 1000);
    ctx.save();
    ctx.translate(p.x + p.vx * t, p.y + p.vy * t + 70 * t * t);
    ctx.rotate(p.rot + p.vRot * t);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
  ctx.restore();
}

function drawWinnerBanner(ctx, cx, cy, text, elapsedMs) {
  const t = Math.min(1, elapsedMs / 450);
  const scale = elapsedMs >= 450 ? 1 : easeOutBack(t);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.rotate(-0.03);
  ctx.save();
  ctx.shadowColor = 'rgba(51,48,42,0.35)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 3;
  tornRectPath(ctx, -110, -22, 220, 44, 606);
  ctx.fillStyle = TAPE;
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = INK;
  ctx.font = `700 22px ${FONT_DISPLAY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 1);
  ctx.restore();
}

// ---- Drawing ------------------------------------------------------------
function formatTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function drawTeamPanel(ctx, assets, team, reveal) {
  const { header, rack, canvas: canvasArea } = team.areas;
  const main = TEAM_MAIN[team.key];
  const seedBase = team.key === 'red' ? 0 : 500;

  // Header：整條染上隊伍色的撕紙標籤，狀態徽章做成右側的紙膠帶小貼片
  ctx.save();
  ctx.shadowColor = 'rgba(51, 48, 42, 0.3)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 3;
  tornRectPath(ctx, header.x, header.y, header.w, header.h, seedBase + 1);
  ctx.fillStyle = main;
  ctx.fill();
  ctx.restore();

  ctx.textBaseline = 'middle';
  ctx.fillStyle = CREAM;
  ctx.font = `700 20px ${FONT_DISPLAY}`;
  ctx.textAlign = 'left';
  ctx.fillText(`${TEAM_LABEL[team.key]}碎片架　${team.name}`, header.x + 12, header.y + header.h / 2);

  if (team.finished) {
    const badgeText = `✅ 已提早完成 +${team.finishBonus.toFixed(1)}%`;
    ctx.font = `700 13px ${FONT_BODY}`;
    const badgeW = ctx.measureText(badgeText).width + 18;
    ctx.fillStyle = TAPE;
    ctx.beginPath();
    ctx.roundRect(header.x + header.w - badgeW - 6, header.y + 4, badgeW, header.h - 8, (header.h - 8) / 2);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.fillText(badgeText, header.x + header.w - badgeW + 3, header.y + header.h / 2);
  }
  ctx.textBaseline = 'alphabetic';

  // Rack：牛皮紙紋撕紙面板，角落貼一小塊隊伍色紙膠帶
  const rackSeed = seedBase + 2;
  drawPaperPanel(ctx, rack.x, rack.y, rack.w, rack.h, rackSeed, getPaperPattern(ctx));
  ctx.save();
  tornRectPath(ctx, rack.x, rack.y, rack.w, rack.h, rackSeed);
  ctx.clip();
  for (const p of team.rackPieces) {
    if (p.taken) continue;
    ctx.drawImage(assets.pieceImages[p.id], p.rackX, p.rackY, assets.pieceW * RACK_SCALE, assets.pieceH * RACK_SCALE);
  }
  ctx.restore();
  drawTapeCorner(ctx, rack.x + 24, rack.y, main, -0.12);

  // Canvas：淺色紙面板，實際作畫區
  const canvasSeed = seedBase + 3;
  drawPaperPanel(ctx, canvasArea.x, canvasArea.y, canvasArea.w, canvasArea.h, canvasSeed, CREAM);
  ctx.save();
  tornRectPath(ctx, canvasArea.x, canvasArea.y, canvasArea.w, canvasArea.h, canvasSeed);
  ctx.clip();

  const { scale, offsetX, offsetY } = team.canvasFit;
  ctx.strokeStyle = 'rgba(51, 48, 42, 0.4)';
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  ctx.strokeRect(offsetX, offsetY, assets.srcW * scale, assets.srcH * scale);
  ctx.setLineDash([]);

  for (const pp of team.placedPieces) {
    ctx.drawImage(
      assets.pieceImages[pp.id],
      offsetX + pp.source_x * scale,
      offsetY + pp.source_y * scale,
      assets.pieceW * scale,
      assets.pieceH * scale,
    );
  }
  ctx.restore();
  drawTapeCorner(ctx, canvasArea.x + canvasArea.w - 24, canvasArea.y, main, 0.12);

  // Cursor / carried piece
  if (team.carrying) {
    ctx.globalAlpha = 0.85;
    ctx.drawImage(
      assets.pieceImages[team.carrying.id],
      team.cursor.x - (assets.pieceW * scale) / 2,
      team.cursor.y - (assets.pieceH * scale) / 2,
      assets.pieceW * scale,
      assets.pieceH * scale,
    );
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = team.carrying ? CREAM : main;
  ctx.lineWidth = 3;
  ctx.strokeRect(team.cursor.x - CURSOR_SIZE / 2, team.cursor.y - CURSOR_SIZE / 2, CURSOR_SIZE, CURSOR_SIZE);
  ctx.lineWidth = 1;

  // 偷窺道具效果：畫布疊一層原畫殘影
  if (team.peekTimer > 0) {
    ctx.save();
    tornRectPath(ctx, canvasArea.x, canvasArea.y, canvasArea.w, canvasArea.h, canvasSeed);
    ctx.clip();
    ctx.globalAlpha = 0.4;
    ctx.drawImage(assets.rawImage, offsetX, offsetY, assets.srcW * scale, assets.srcH * scale);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // 暈眩道具效果：整個碎片架＋畫布蓋一層，暫停操作
  if (team.stunTimer > 0) {
    const top = rack.y;
    const bottom = canvasArea.y + canvasArea.h;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(rack.x, top, rack.w, bottom - top, 10);
    ctx.clip();
    ctx.fillStyle = 'rgba(20,15,10,0.65)';
    ctx.fillRect(rack.x, top, rack.w, bottom - top);
    ctx.fillStyle = CREAM;
    ctx.font = `700 20px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`😵 暈眩中 ${team.stunTimer.toFixed(1)}s`, rack.x + rack.w / 2, (top + bottom) / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  let line = '', curY = y;
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line.length > 0) {
      ctx.fillText(line, x, curY);
      line = ch;
      curY += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, curY);
}

// Draws a single-line, center-aligned hint with one substring (a button
// letter) recolored to match that button's physical color on the phone
// controller — e.g. "...按 A 提早完成" renders its "A" in BTN_A_COLOR so the
// on-screen instruction visually matches the button players actually press.
// Assumes ctx.textAlign === 'center' going in, and restores it after.
function drawHintWithButtonColor(ctx, text, letter, letterColor, baseColor, cx, y) {
  const idx = text.indexOf(letter);
  if (idx < 0) { ctx.fillStyle = baseColor; ctx.fillText(text, cx, y); return; }
  const before = text.slice(0, idx);
  const after = text.slice(idx + letter.length);
  let x = cx - ctx.measureText(text).width / 2;
  ctx.textAlign = 'left';
  ctx.fillStyle = baseColor;
  ctx.fillText(before, x, y);
  x += ctx.measureText(before).width;
  ctx.fillStyle = letterColor;
  ctx.fillText(letter, x, y);
  x += ctx.measureText(letter).width;
  ctx.fillStyle = baseColor;
  ctx.fillText(after, x, y);
  ctx.textAlign = 'center';
}

function drawPreviewPanel(ctx, assets) {
  const area = { x: MID_X, y: PREVIEW_Y, w: MID_W, h: PREVIEW_H };
  drawPaperPanel(ctx, area.x, area.y, area.w, area.h, 901, CREAM);
  ctx.fillStyle = INK;
  ctx.font = `700 15px ${FONT_BODY}`;
  ctx.fillText('原畫參考', area.x + 10, area.y + 24);
  if (!assets?.rawImage) return;
  const imgArea = { x: area.x + 8, y: area.y + 32, w: area.w - 16, h: area.h - 40 };
  const { scale, offsetX, offsetY } = computeFit(imgArea, assets.rawImage.width, assets.rawImage.height);
  ctx.drawImage(assets.rawImage, offsetX, offsetY, assets.rawImage.width * scale, assets.rawImage.height * scale);
}

function drawItemsPanel(ctx, activeItem) {
  const area = { x: MID_X, y: ITEMS_Y, w: MID_W, h: ITEMS_H };

  if (activeItem) {
    const info = ITEM_DEFS.find((d) => d.type === activeItem.type);
    drawPaperPanel(ctx, area.x, area.y, area.w, area.h, 902, CREAM);
    tornRectPath(ctx, area.x, area.y, area.w, area.h, 902);
    ctx.strokeStyle = TAPE;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineWidth = 1;

    ctx.fillStyle = INK;
    ctx.font = `700 13px ${FONT_BODY}`;
    ctx.textAlign = 'center';
    ctx.fillText('道具出現了！移過去搶！', area.x + area.w / 2, area.y + 20);

    const stickerCx = area.x + area.w / 2;
    const stickerCy = area.y + area.h / 2 - 12;
    tornRectPath(ctx, stickerCx - 30, stickerCy - 30, 60, 60, 903);
    ctx.fillStyle = CARDBOARD;
    ctx.fill();

    ctx.textBaseline = 'middle';
    ctx.font = '42px sans-serif';
    ctx.fillStyle = INK; // 圖示不全是彩色 emoji（例如「〜」是純文字字元），要重設 fillStyle 才不會跟貼紙同色看不見
    ctx.fillText(info.icon, stickerCx, stickerCy + 1);

    ctx.font = `700 16px ${FONT_DISPLAY}`;
    ctx.fillStyle = INK;
    ctx.fillText(info.name, area.x + area.w / 2, area.y + area.h / 2 + 34);
    ctx.textBaseline = 'alphabetic';

    ctx.font = `13px ${FONT_BODY}`;
    ctx.fillStyle = 'rgba(51,48,42,0.7)';
    wrapText(ctx, info.desc, area.x + area.w / 2, area.y + area.h / 2 + 54, area.w - 40, 15);
    ctx.textAlign = 'left';
    return;
  }

  drawPaperPanel(ctx, area.x, area.y, area.w, area.h, 902, getPaperPattern(ctx));
  ctx.fillStyle = INK;
  ctx.font = `700 14px ${FONT_BODY}`;
  ctx.fillText('道具說明（每 30 秒隨機出現一個）', area.x + 10, area.y + 20);

  const rowH = (area.h - 28) / ITEM_DEFS.length;
  ITEM_DEFS.forEach((item, i) => {
    const rowY = area.y + 26 + i * rowH;
    tornRectPath(ctx, area.x + 8, rowY, 28, 28, 910 + i);
    ctx.fillStyle = CARDBOARD;
    ctx.fill();
    ctx.font = 'bold 16px sans-serif';
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.icon, area.x + 8 + 14, rowY + 14 + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    ctx.font = `700 13px ${FONT_DISPLAY}`;
    ctx.fillStyle = INK;
    ctx.fillText(item.name, area.x + 44, rowY + 12);
    ctx.font = `12px ${FONT_BODY}`;
    ctx.fillStyle = 'rgba(51,48,42,0.7)';
    wrapText(ctx, item.desc, area.x + 44, rowY + 25, area.w - 52, 13);
  });
}

function drawScorePanel(ctx, teams, reveal, timeRemaining, holdSecondsLeft, confetti, endedElapsedMs) {
  const area = { x: MID_X, y: SCORE_Y, w: MID_W, h: SCORE_H };
  drawPaperPanel(ctx, area.x, area.y, area.w, area.h, 904, getPaperPattern(ctx));

  ctx.fillStyle = INK;
  ctx.font = `700 15px ${FONT_BODY}`;
  ctx.fillText(reveal ? '相似度' : '相似度（時間到才公布）', area.x + 10, area.y + 26);

  ctx.textAlign = 'center';
  ctx.font = `700 30px ${FONT_DISPLAY}`;
  ctx.fillStyle = TEAM_MAIN.red;
  ctx.fillText(reveal ? `${teams.red.score.toFixed(0)}%` : '？', area.x + area.w * 0.28, area.y + 70);
  ctx.font = `700 15px ${FONT_DISPLAY}`;
  ctx.fillStyle = 'rgba(51,48,42,0.55)';
  ctx.fillText('VS', area.x + area.w * 0.5, area.y + 64);
  ctx.font = `700 30px ${FONT_DISPLAY}`;
  ctx.fillStyle = TEAM_MAIN.blue;
  ctx.fillText(reveal ? `${teams.blue.score.toFixed(0)}%` : '？', area.x + area.w * 0.72, area.y + 70);

  ctx.font = `13px ${FONT_BODY}`;
  ctx.fillStyle = 'rgba(51,48,42,0.65)';
  ctx.fillText('已放置碎片數', area.x + area.w / 2, area.y + 98);
  ctx.font = `700 16px ${FONT_BODY}`;
  ctx.fillStyle = TEAM_MAIN.red;
  ctx.fillText(`${teams.red.placedPieces.length} / ${PIECES_PER_TEAM}`, area.x + area.w * 0.28, area.y + 122);
  ctx.fillStyle = TEAM_MAIN.blue;
  ctx.fillText(`${teams.blue.placedPieces.length} / ${PIECES_PER_TEAM}`, area.x + area.w * 0.72, area.y + 122);

  if (reveal) {
    const winnerText = teams.red.score === teams.blue.score
      ? '平手！'
      : teams.red.score > teams.blue.score ? '🏆 紅隊獲勝！' : '🏆 藍隊獲勝！';
    drawConfetti(ctx, confetti, endedElapsedMs ?? 0);
    drawWinnerBanner(ctx, area.x + area.w / 2, area.y + 155, winnerText, endedElapsedMs ?? 0);
    if (holdSecondsLeft != null) {
      ctx.font = `13px ${FONT_BODY}`;
      ctx.fillStyle = 'rgba(51,48,42,0.65)';
      ctx.fillText(`${Math.ceil(holdSecondsLeft)} 秒後返回大廳`, area.x + area.w / 2, area.y + 196);
    }
  } else {
    ctx.font = `13px ${FONT_BODY}`;
    drawHintWithButtonColor(ctx, '搖桿移動游標／B 抓取或放下碎片', 'B', BTN_B_COLOR, 'rgba(51,48,42,0.7)', area.x + area.w / 2, area.y + 158);

    ['red', 'blue'].forEach((key, i) => {
      const team = teams[key];
      const y = area.y + 200 + i * 22;
      ctx.font = `700 13px ${FONT_BODY}`;
      if (team.finished) {
        ctx.fillStyle = TEAM_DIM.blue;
        wrapText(ctx, `${TEAM_LABEL[key]}已提早完成（+${team.finishBonus.toFixed(1)}%），等待結算`, area.x + area.w / 2, y, area.w - 24, 16);
      } else {
        const text = `${TEAM_LABEL[key]}按 A 提早完成：+${computeEarlyFinishBonus(timeRemaining).toFixed(1)}% 加成`;
        drawHintWithButtonColor(ctx, text, 'A', BTN_A_COLOR, 'rgba(51,48,42,0.65)', area.x + area.w / 2, y);
      }
    });
  }
  ctx.textAlign = 'left';
}

function drawTimer(ctx, remaining) {
  const text = formatTime(remaining);
  const w = 160;
  const x = LOGICAL_W / 2 - w / 2;
  const urgent = remaining <= 30;
  ctx.save();
  ctx.shadowColor = 'rgba(51, 48, 42, 0.3)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  ctx.roundRect(x, TIMER_Y, w, TIMER_H, 20);
  ctx.fillStyle = urgent ? TAPE : CREAM;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.roundRect(x, TIMER_Y, w, TIMER_H, 20);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = INK;
  ctx.font = `700 26px ${FONT_DISPLAY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`⏱ ${text}`, LOGICAL_W / 2, TIMER_Y + TIMER_H / 2 + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawLoading(ctx, w, h) {
  ctx.fillStyle = getCorkPattern(ctx);
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = CREAM;
  ctx.font = `700 28px ${FONT_DISPLAY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('載入畫作中…', w / 2, h / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function _name(globalState, deviceId) {
  return deviceId != null
    ? truncateName(globalState.players?.[deviceId]?.name ?? `Player ${deviceId}`)
    : '（尚無玩家）';
}

function _finish(globalState) {
  if (!pg.teams.red.finished) pg.teams.red.score = computeColorSimilarity(pg.assets, pg.teams.red);
  if (!pg.teams.blue.finished) pg.teams.blue.score = computeColorSimilarity(pg.assets, pg.teams.blue);

  const winnerTeam = pg.teams.red.score === pg.teams.blue.score
    ? null
    : pg.teams.red.score > pg.teams.blue.score ? 'red' : 'blue';

  if (winnerTeam) {
    const winner = pg.teams[winnerTeam];
    if (winner.deviceId != null && globalState.players?.[winner.deviceId]) {
      globalState.players[winner.deviceId].score =
        (globalState.players[winner.deviceId].score || 0) + Math.round(winner.score);
    }
  }

  pg.phase = 'ended';
  pg.holdSecondsLeft = RESULT_HOLD_SECONDS;
  pg.endedElapsed = 0;
  pg.confetti = generateConfetti(MID_X + MID_W / 2, SCORE_Y + 40);
  pg._pendingWinner = winnerTeam;
}

export default {
  id: 'painting-sticker',
  name: '仿畫行動',
  description: '搶碎片、拼出原畫，比比看誰的畫布更像！',
  playersPerTeam: 1,
  color: '#d9895a',
  emoji: '🖼️',
  cover: '07_painting-sticker/painting_cover.png',

  tutorial: {
    pages: [
      '07_painting-sticker/tutorial/1.png',
      '07_painting-sticker/tutorial/2.png',
      '07_painting-sticker/tutorial/3.png',
      '07_painting-sticker/tutorial/4.png',
    ],
  },

  onStart(globalState, endCb) {
    bgm.start();
    const active = globalState.activePlayers || {};
    const teams = globalState.teams || {};
    const playing = Object.entries(active).filter(([, role]) => role === 'playing').map(([id]) => id);
    const ids = playing.length >= 2 ? playing : Object.keys(globalState.players || {});
    const redId = ids.find((id) => teams[id] === 'red') ?? ids[0] ?? null;
    const blueId = ids.find((id) => teams[id] === 'blue' && id !== redId) ?? ids.find((id) => id !== redId) ?? null;

    pg = {
      phase: 'loading',
      timeRemaining: PLAY_SECONDS,
      holdSecondsLeft: 0,
      assets: null,
      teams: null,
      redId,
      blueId,
      activeItem: null,
      itemSpawnSlot: 0,
      _endCb: endCb,
      _pendingWinner: null,
    };

    ensurePreload()
      .then((assets) => {
        if (!pg) return; // onEnd already fired before the load finished
        pg.assets = assets;
        pg.teams = {
          red: createTeam('red', LEFT_X, redId, _name(globalState, redId), assets),
          blue: createTeam('blue', RIGHT_X, blueId, _name(globalState, blueId), assets),
        };
        pg.phase = 'playing';
      })
      .catch((err) => {
        console.error('[painting-sticker] failed to load painting/pieces', err);
      });
  },

  preload() {
    return ensurePreload().catch(() => {});
  },

  update(dt, globalState) {
    if (!pg) return;

    if (pg.phase === 'playing') {
      pg.timeRemaining -= dt;
      for (const team of Object.values(pg.teams)) {
        if (team.stunTimer > 0) team.stunTimer = Math.max(0, team.stunTimer - dt);
        if (team.peekTimer > 0) team.peekTimer = Math.max(0, team.peekTimer - dt);
        if (team.finished) continue;
        moveCursor(team, dt);
      }

      const elapsed = PLAY_SECONDS - pg.timeRemaining;
      const spawnSlot = Math.floor(elapsed / ITEM_SPAWN_INTERVAL);
      if (spawnSlot > pg.itemSpawnSlot) {
        pg.itemSpawnSlot = spawnSlot;
        // Stop spawning fresh items near the end so a late grab can't scramble
        // a team's canvas with no time left to recover.
        if (pg.timeRemaining > ITEM_SPAWN_CUTOFF) spawnRandomItem();
      }

      const bothFinished = pg.teams.red.finished && pg.teams.blue.finished;
      if (pg.timeRemaining <= 0 || bothFinished) {
        pg.timeRemaining = Math.max(0, pg.timeRemaining);
        _finish(globalState);
      }
      return;
    }

    if (pg.phase === 'ended') {
      pg.endedElapsed += dt;
      pg.holdSecondsLeft -= dt;
      if (pg.holdSecondsLeft <= 0) {
        const winner = pg._pendingWinner;
        pg._endCb?.(winner);
      }
    }
  },

  draw(ctx, w, h) {
    if (!pg) return;

    const scale = Math.min(w / LOGICAL_W, h / LOGICAL_H);
    const offX = (w - LOGICAL_W * scale) / 2;
    const offY = (h - LOGICAL_H * scale) / 2;

    ctx.fillStyle = '#14141a';
    ctx.fillRect(0, 0, w, h);

    if (pg.phase === 'loading') {
      drawLoading(ctx, w, h);
      return;
    }

    ctx.save();
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);

    ctx.fillStyle = getCorkPattern(ctx);
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

    const reveal = pg.phase === 'ended';
    drawTeamPanel(ctx, pg.assets, pg.teams.red, reveal);
    drawTeamPanel(ctx, pg.assets, pg.teams.blue, reveal);
    drawTimer(ctx, pg.timeRemaining);
    drawPreviewPanel(ctx, pg.assets);
    drawItemsPanel(ctx, pg.activeItem);
    drawScorePanel(
      ctx, pg.teams, reveal, pg.timeRemaining,
      reveal ? pg.holdSecondsLeft : null,
      pg.confetti, pg.endedElapsed * 1000,
    );

    ctx.restore();
  },

  onInput(deviceId, data) {
    if (!pg || pg.phase !== 'playing') return;
    const did = String(deviceId);
    const team = String(pg.teams.red.deviceId) === did ? pg.teams.red
      : String(pg.teams.blue.deviceId) === did ? pg.teams.blue
        : null;
    if (!team || team.finished) return;

    if (data.action === 'move') {
      team.move.dx = data.dx ?? 0;
      team.move.dy = data.dy ?? 0;
    } else if (data.action === 'grab') {
      if (team.stunTimer > 0) return;
      handleAction(pg.assets, team);
      tryClaimItem(team);
    } else if (data.action === 'finish') {
      finishTeamEarly(pg.assets, team, pg.timeRemaining);
    }
  },

  onEnd() {
    bgm.stop();
    pg = null;
    _preloadPromise = null; // next match should randomize a fresh painting, not replay this one
  },
};
