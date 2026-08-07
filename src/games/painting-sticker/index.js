/**
 * 仿畫大作戰 — ported from painting_sticker/game.js.
 *
 * Red vs blue, 1 active cursor per team (playersPerTeam: 1). Each team grabs
 * torn-paper pieces from its own rack and drops them onto its own canvas,
 * racing to reproduce the reference painting before time runs out. Score is
 * a color-similarity comparison against the source painting, hidden until
 * the reveal at the end (matches the original's "don't peek at your score
 * mid-match" design).
 *
 * The original's AI opponent, item pickups, random "干擾" events, and its
 * standalone WebSocket coop room are dropped — the hub already provides real
 * opponents and networking. See painting_sticker/GDD_定案.md for the source
 * design doc.
 *
 * Pieces are generated at runtime (not pre-cut PNGs) via tear.js's
 * Voronoi + torn-edge algorithm, so only one raw.png per painting ships.
 */
import { truncateName } from '../../shared/nameDisplay.js';
import { generatePieces, computeGridForCount } from './tear.js';
import {
  LOGICAL_W, LOGICAL_H,
  PLAY_SECONDS, PIECES_PER_TEAM, RACK_SCALE, CURSOR_SIZE, MOVE_SPEED,
  ALPHA_HIT_THRESHOLD, SCORE_SAMPLE_W, BONUS_RATE, BONUS_CAP, RESULT_HOLD_SECONDS,
  TEAR_CONFIG,
  LEFT_X, MID_X, RIGHT_X, SIDE_W, MID_W,
  TIMER_Y, TIMER_H, CONTENT_TOP, CONTENT_BOTTOM,
  HEADER_H, RACK_Y, RACK_H, CANVAS_Y, CANVAS_H,
  PREVIEW_Y, PREVIEW_H, SCORE_Y, SCORE_H,
} from './config.js';

const TEAM_MAIN = { red: '#ff6b6b', blue: '#4ecdc4' };
const TEAM_DIM  = { red: '#5a2b2f', blue: '#254a49' };
const TEAM_LABEL = { red: '紅隊', blue: '藍隊' };

let pg = null; // module-level match state

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
  const manifest = await (await fetch('painting-sticker/paintings/manifest.json')).json();
  const paintingId = manifest[Math.floor(Math.random() * manifest.length)];
  const rawImage = await loadImage(`painting-sticker/paintings/${paintingId}/raw.png`);
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
      if (p) { p.taken = true; team.carrying = { id: p.id }; }
    } else if (rectContains(team.areas.canvas, cx, cy)) {
      const idx = findPlacedPieceAt(assets, team, cx, cy);
      if (idx >= 0) {
        const [pp] = team.placedPieces.splice(idx, 1);
        team.carrying = { id: pp.id };
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
  const { dx, dy } = team.move;
  if (!dx && !dy) return;
  const bounds = {
    x: team.areas.header.x,
    y: team.areas.header.y,
    w: team.areas.header.w,
    h: team.areas.canvas.y + team.areas.canvas.h - team.areas.header.y,
  };
  team.cursor.x = Math.max(bounds.x, Math.min(bounds.x + bounds.w, team.cursor.x + dx * MOVE_SPEED * dt));
  team.cursor.y = Math.max(bounds.y, Math.min(bounds.y + bounds.h, team.cursor.y + dy * MOVE_SPEED * dt));
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
  const dim = TEAM_DIM[team.key];

  ctx.textBaseline = 'middle';
  ctx.fillStyle = main;
  ctx.font = 'bold 22px "Noto Sans TC", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${TEAM_LABEL[team.key]}碎片架　${team.name}`, header.x + 4, header.y + header.h / 2);

  if (team.finished) {
    const badgeText = `✅ 已提早完成 +${team.finishBonus.toFixed(1)}%`;
    ctx.font = '15px "Noto Sans TC", sans-serif';
    const badgeW = ctx.measureText(badgeText).width + 20;
    ctx.fillStyle = dim;
    ctx.beginPath();
    ctx.roundRect(header.x + header.w - badgeW, header.y + 4, badgeW, header.h - 8, 10);
    ctx.fill();
    ctx.fillStyle = '#eee';
    ctx.fillText(badgeText, header.x + header.w - badgeW + 10, header.y + header.h / 2);
  }
  ctx.textBaseline = 'alphabetic';

  // Rack
  ctx.strokeStyle = main;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(rack.x, rack.y, rack.w, rack.h, 10);
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(rack.x, rack.y, rack.w, rack.h, 10);
  ctx.clip();
  ctx.fillStyle = '#20202a';
  ctx.fillRect(rack.x, rack.y, rack.w, rack.h);
  for (const p of team.rackPieces) {
    if (p.taken) continue;
    ctx.drawImage(assets.pieceImages[p.id], p.rackX, p.rackY, assets.pieceW * RACK_SCALE, assets.pieceH * RACK_SCALE);
  }
  ctx.restore();

  // Canvas
  ctx.strokeStyle = main;
  ctx.beginPath();
  ctx.roundRect(canvasArea.x, canvasArea.y, canvasArea.w, canvasArea.h, 10);
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(canvasArea.x, canvasArea.y, canvasArea.w, canvasArea.h, 10);
  ctx.clip();
  ctx.fillStyle = '#2b2b35';
  ctx.fillRect(canvasArea.x, canvasArea.y, canvasArea.w, canvasArea.h);

  const { scale, offsetX, offsetY } = team.canvasFit;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.setLineDash([8, 5]);
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
  ctx.strokeStyle = team.carrying ? '#ffffff' : main;
  ctx.lineWidth = 3;
  ctx.strokeRect(team.cursor.x - CURSOR_SIZE / 2, team.cursor.y - CURSOR_SIZE / 2, CURSOR_SIZE, CURSOR_SIZE);
  ctx.lineWidth = 1;
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

function drawPreviewPanel(ctx, assets) {
  const area = { x: MID_X, y: PREVIEW_Y, w: MID_W, h: PREVIEW_H };
  ctx.strokeStyle = '#666';
  ctx.beginPath();
  ctx.roundRect(area.x, area.y, area.w, area.h, 10);
  ctx.stroke();
  ctx.fillStyle = '#ccc';
  ctx.font = 'bold 16px "Noto Sans TC", sans-serif';
  ctx.fillText('原畫參考', area.x + 10, area.y + 24);
  if (!assets?.rawImage) return;
  const imgArea = { x: area.x + 8, y: area.y + 32, w: area.w - 16, h: area.h - 40 };
  const { scale, offsetX, offsetY } = computeFit(imgArea, assets.rawImage.width, assets.rawImage.height);
  ctx.drawImage(assets.rawImage, offsetX, offsetY, assets.rawImage.width * scale, assets.rawImage.height * scale);
}

function drawScorePanel(ctx, teams, reveal, timeRemaining, holdSecondsLeft) {
  const area = { x: MID_X, y: SCORE_Y, w: MID_W, h: SCORE_H };
  ctx.strokeStyle = '#666';
  ctx.beginPath();
  ctx.roundRect(area.x, area.y, area.w, area.h, 10);
  ctx.stroke();

  ctx.fillStyle = '#ccc';
  ctx.font = 'bold 16px "Noto Sans TC", sans-serif';
  ctx.fillText(reveal ? '相似度' : '相似度（時間到才公布）', area.x + 10, area.y + 26);

  ctx.textAlign = 'center';
  ctx.font = 'bold 32px sans-serif';
  ctx.fillStyle = TEAM_MAIN.red;
  ctx.fillText(reveal ? `${teams.red.score.toFixed(0)}%` : '？', area.x + area.w * 0.28, area.y + 70);
  ctx.font = 'bold 16px sans-serif';
  ctx.fillStyle = '#999';
  ctx.fillText('VS', area.x + area.w * 0.5, area.y + 64);
  ctx.font = 'bold 32px sans-serif';
  ctx.fillStyle = TEAM_MAIN.blue;
  ctx.fillText(reveal ? `${teams.blue.score.toFixed(0)}%` : '？', area.x + area.w * 0.72, area.y + 70);

  ctx.font = '14px "Noto Sans TC", sans-serif';
  ctx.fillStyle = '#888';
  ctx.fillText('已放置碎片數', area.x + area.w / 2, area.y + 98);
  ctx.font = 'bold 17px sans-serif';
  ctx.fillStyle = TEAM_MAIN.red;
  ctx.fillText(`${teams.red.placedPieces.length} / ${PIECES_PER_TEAM}`, area.x + area.w * 0.28, area.y + 122);
  ctx.fillStyle = TEAM_MAIN.blue;
  ctx.fillText(`${teams.blue.placedPieces.length} / ${PIECES_PER_TEAM}`, area.x + area.w * 0.72, area.y + 122);

  if (reveal) {
    const winner = teams.red.score === teams.blue.score
      ? '平手！'
      : teams.red.score > teams.blue.score ? '🏆 紅隊獲勝！' : '🏆 藍隊獲勝！';
    ctx.font = 'bold 24px "Noto Sans TC", sans-serif';
    ctx.fillStyle = '#ffcc00';
    ctx.fillText(winner, area.x + area.w / 2, area.y + 168);
    if (holdSecondsLeft != null) {
      ctx.font = '13px "Noto Sans TC", sans-serif';
      ctx.fillStyle = '#888';
      ctx.fillText(`${Math.ceil(holdSecondsLeft)} 秒後返回大廳`, area.x + area.w / 2, area.y + 196);
    }
  } else {
    ctx.font = '13px "Noto Sans TC", sans-serif';
    ctx.fillStyle = '#888';
    wrapText(ctx, '搖桿移動游標／B 抓取或放下碎片', area.x + area.w / 2, area.y + 158, area.w - 24, 18);

    ['red', 'blue'].forEach((key, i) => {
      const team = teams[key];
      const y = area.y + 200 + i * 22;
      ctx.font = 'bold 13px "Noto Sans TC", sans-serif';
      ctx.fillStyle = team.finished ? '#7CFC00' : '#666';
      const text = team.finished
        ? `${TEAM_LABEL[key]}已提早完成（+${team.finishBonus.toFixed(1)}%），等待結算`
        : `${TEAM_LABEL[key]}按 A 提早完成：+${computeEarlyFinishBonus(timeRemaining).toFixed(1)}% 加成`;
      wrapText(ctx, text, area.x + area.w / 2, y, area.w - 24, 16);
    });
  }
  ctx.textAlign = 'left';
}

function drawTimer(ctx, remaining) {
  const text = formatTime(remaining);
  const w = 160;
  const x = LOGICAL_W / 2 - w / 2;
  ctx.fillStyle = '#2a2a34';
  ctx.strokeStyle = '#555';
  ctx.beginPath();
  ctx.roundRect(x, TIMER_Y, w, TIMER_H, 20);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = remaining <= 30 ? '#ff6b6b' : '#ffcc00';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`⏱ ${text}`, LOGICAL_W / 2, TIMER_Y + TIMER_H / 2 + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawLoading(ctx, w, h) {
  ctx.fillStyle = '#1a1a20';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#eee';
  ctx.font = 'bold 28px "Noto Sans TC", sans-serif';
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
  pg._pendingWinner = winnerTeam;
}

export default {
  id: 'painting-sticker',
  name: '仿畫大作戰',
  description: '搶碎片、拼出原畫，比比看誰的畫布更像！',
  playersPerTeam: 1,
  color: '#d9895a',
  emoji: '🖼️',

  tutorial: {
    goal: '限時內從自己的碎片架搶碎片、貼到畫布上拼出原畫。時間到或提早鎖定分數後，相似度較高的隊伍獲勝！',
    controls: [
      { key: '🕹️', text: '移動游標' },
      { key: 'B', text: '抓取／放下碎片（碎片可以再抓起來重放）' },
      { key: 'A', text: '提早完成、鎖定目前分數（剩越多時間，加成越高）' },
    ],
    tips: [
      '碎片邊界故意留了一點重疊，沒對得很準也可能看起來完整，這是正常的',
      '分數在時間到／雙方都提早完成之前都是保密的，比的就是最後開獎的緊張感',
    ],
  },

  onStart(globalState, endCb) {
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
      _endCb: endCb,
      _pendingWinner: null,
    };

    loadPaintingAndPieces()
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

  update(dt, globalState) {
    if (!pg) return;

    if (pg.phase === 'playing') {
      pg.timeRemaining -= dt;
      for (const team of Object.values(pg.teams)) {
        if (team.finished) continue;
        moveCursor(team, dt);
      }
      const bothFinished = pg.teams.red.finished && pg.teams.blue.finished;
      if (pg.timeRemaining <= 0 || bothFinished) {
        pg.timeRemaining = Math.max(0, pg.timeRemaining);
        _finish(globalState);
      }
      return;
    }

    if (pg.phase === 'ended') {
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

    const reveal = pg.phase === 'ended';
    drawTeamPanel(ctx, pg.assets, pg.teams.red, reveal);
    drawTeamPanel(ctx, pg.assets, pg.teams.blue, reveal);
    drawTimer(ctx, pg.timeRemaining);
    drawPreviewPanel(ctx, pg.assets);
    drawScorePanel(ctx, pg.teams, reveal, pg.timeRemaining, reveal ? pg.holdSecondsLeft : null);

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
      handleAction(pg.assets, team);
    } else if (data.action === 'finish') {
      finishTeamEarly(pg.assets, team, pg.timeRemaining);
    }
  },

  onEnd() {
    pg = null;
  },
};
