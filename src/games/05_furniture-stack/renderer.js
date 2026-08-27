import {
  WORLD_W,
  WORLD_H,
  PLATFORM,
  GAME_RULES,
  TEAM_STYLE,
} from './config.js';
import {
  drawFurniture,
  drawFurniturePreview,
} from './furniture-renderer.js';
import { pieceBounds } from './rigid-body.js';

const INK = '#2a1d19';
const CREAM = '#fff7df';
const THEME_IMAGE_SOURCES = {
  background: './05_furniture-stack/theme/background.webp',
  platformFlat: './05_furniture-stack/theme/platform-flat.webp',
  redCharacter: './05_furniture-stack/theme/characters/red-mover.webp',
  blueCharacter: './05_furniture-stack/theme/characters/blue-mover.webp',
  redScorePanel: './05_furniture-stack/theme/ui/red-score-panel.webp',
  blueScorePanel: './05_furniture-stack/theme/ui/blue-score-panel.webp',
  nextPanel: './05_furniture-stack/theme/ui/next-panel.webp',
  statusBar: './05_furniture-stack/theme/ui/status-bar.webp',
  towerOverviewPanel: './05_furniture-stack/theme/ui/tower-overview-panel.webp',
  victoryPanel: './05_furniture-stack/theme/ui/victory-panel.webp',
  spinnerWheel: './05_furniture-stack/theme/spinner/wheel.webp',
  spinnerPointer: './05_furniture-stack/theme/spinner/pointer.webp',
};
const themeImageCache = new Map();

export function renderFurnitureStack(ctx, canvasW, canvasH, state) {
  const scale = Math.min(canvasW / WORLD_W, canvasH / WORLD_H);
  const offsetX = (canvasW - WORLD_W * scale) / 2;
  const offsetY = (canvasH - WORLD_H * scale) / 2;

  ctx.save();
  ctx.fillStyle = '#070a20';
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.rect(0, 0, WORLD_W, WORLD_H);
  ctx.clip();

  drawBackdrop(ctx, state);

  ctx.save();
  ctx.translate(0, state.cameraOffsetY ?? 0);
  drawPlatform(ctx, state);

  for (const body of state.pieces) drawFurniture(ctx, body, false);
  if (state.currentBody) {
    drawFurniture(ctx, state.currentBody, state.phase === 'aiming');
  }
  ctx.restore();

  drawTeamCharacter(ctx, 'red', state);
  drawTeamCharacter(ctx, 'blue', state);
  if (state.phase !== 'rolling') drawHud(ctx, state);
  drawOverlay(ctx, state);
  if (state.phase !== 'rolling' && state.pieces.length > 0) {
    drawTowerOverview(ctx, state);
  }

  ctx.restore();
}

function drawTowerOverview(ctx, state) {
  const frame = { x: 42, y: 206, width: 236, height: 315 };
  const viewport = {
    x: frame.x + 29,
    y: frame.y + 63,
    width: frame.width - 58,
    height: frame.height - 80,
  };
  const pieces = [...new Set([
    ...state.pieces,
    ...(state.currentBody ? [state.currentBody] : []),
  ])];
  const bounds = pieces.map(pieceBounds);
  const worldBounds = {
    minX: Math.min(PLATFORM.x - PLATFORM.width / 2, ...bounds.map(item => item.min.x)) - 45,
    maxX: Math.max(PLATFORM.x + PLATFORM.width / 2, ...bounds.map(item => item.max.x)) + 45,
    minY: Math.min(PLATFORM.y - PLATFORM.height / 2, ...bounds.map(item => item.min.y)) - 35,
    maxY: Math.max(PLATFORM.y + PLATFORM.height / 2, ...bounds.map(item => item.max.y))
      + (state.losingBody ? 120 : 35),
  };
  const worldWidth = Math.max(1, worldBounds.maxX - worldBounds.minX);
  const worldHeight = Math.max(1, worldBounds.maxY - worldBounds.minY);
  const overviewScale = Math.min(viewport.width / worldWidth, viewport.height / worldHeight);
  const worldCenterX = (worldBounds.minX + worldBounds.maxX) / 2;

  ctx.save();
  ctx.shadowBlur = 16;
  ctx.shadowColor = 'rgba(76, 45, 24, 0.3)';
  const drewFrame = drawThemeImage(
    ctx,
    'towerOverviewPanel',
    frame.x,
    frame.y,
    frame.width,
    frame.height,
  );
  ctx.shadowBlur = 0;
  if (!drewFrame) {
    roundedRect(ctx, frame.x, frame.y, frame.width, frame.height, 22);
    ctx.fillStyle = 'rgba(255, 247, 223, 0.96)';
    ctx.fill();
    ctx.strokeStyle = '#8a5c32';
    ctx.lineWidth = 5;
    ctx.stroke();
  }

  roundedRect(ctx, viewport.x, viewport.y, viewport.width, viewport.height, 13);
  ctx.fillStyle = 'rgba(121, 194, 191, 0.16)';
  ctx.fill();
  ctx.clip();

  ctx.translate(
    viewport.x + viewport.width / 2,
    viewport.y + viewport.height - 5,
  );
  ctx.scale(overviewScale, overviewScale);
  ctx.translate(-worldCenterX, -worldBounds.maxY);

  drawPlatform(ctx, state);
  for (const body of pieces) {
    drawFurniture(
      ctx,
      body,
      body === state.currentBody && state.phase === 'aiming',
    );
  }

  if (state.losingBody) {
    const losingBounds = pieceBounds(state.losingBody);
    const padding = 18 / overviewScale;
    ctx.strokeStyle = '#e5473d';
    ctx.lineWidth = 5 / overviewScale;
    ctx.strokeRect(
      losingBounds.min.x - padding,
      losingBounds.min.y - padding,
      losingBounds.max.x - losingBounds.min.x + padding * 2,
      losingBounds.max.y - losingBounds.min.y + padding * 2,
    );
  }
  ctx.restore();

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  setFittedFont(
    ctx,
    state.losingBody ? '掉落位置' : '全塔',
    frame.width - 92,
    18,
    14,
  );
  ctx.lineWidth = 5;
  ctx.strokeStyle = state.losingBody ? '#7b211d' : INK;
  ctx.fillStyle = state.losingBody ? '#ffd2c8' : CREAM;
  ctx.strokeText(
    state.losingBody ? '掉落位置' : '全塔',
    frame.x + frame.width / 2,
    frame.y + 33,
  );
  ctx.fillText(
    state.losingBody ? '掉落位置' : '全塔',
    frame.x + frame.width / 2,
    frame.y + 33,
  );
  ctx.restore();
}

function drawBackdrop(ctx, state) {
  const background = themeImage('background');

  if (imageReady(background)) {
    ctx.drawImage(background, 0, 0, WORLD_W, WORLD_H);
  } else {
    const sky = ctx.createLinearGradient(0, 0, 0, WORLD_H);
    sky.addColorStop(0, '#65d7f2');
    sky.addColorStop(0.55, '#b8e89e');
    sky.addColorStop(1, '#f4dfb9');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  }

  const focus = ctx.createRadialGradient(WORLD_W / 2, 480, 60, WORLD_W / 2, 480, 520);
  focus.addColorStop(0, 'rgba(255, 250, 226, 0.18)');
  focus.addColorStop(0.72, 'rgba(255, 250, 226, 0.04)');
  focus.addColorStop(1, 'rgba(99, 74, 47, 0.05)');
  ctx.fillStyle = focus;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
}

function themeImage(key) {
  const source = THEME_IMAGE_SOURCES[key];
  if (!source || typeof Image === 'undefined') return null;
  if (!themeImageCache.has(key)) {
    const image = new Image();
    image.src = source;
    themeImageCache.set(key, image);
  }
  return themeImageCache.get(key);
}

function imageReady(image) {
  return Boolean(image?.complete && image.naturalWidth > 0);
}

function drawThemeImage(ctx, key, x, y, width, height) {
  const image = themeImage(key);
  if (!imageReady(image)) return false;
  ctx.drawImage(image, x, y, width, height);
  return true;
}

function drawPlatform(ctx, state) {
  const x = PLATFORM.x - PLATFORM.width / 2;
  const y = PLATFORM.y - PLATFORM.height / 2;
  const platformWidth = PLATFORM.width;
  const platformHeight = platformWidth * 230 / 1688;
  const platformX = PLATFORM.x - platformWidth / 2;
  const platformY = y - platformHeight * 11 / 230;

  ctx.save();
  ctx.shadowBlur = 22;
  ctx.shadowColor = 'rgba(92, 55, 26, 0.32)';
  const drewPlatform = drawThemeImage(
    ctx,
    'platformFlat',
    platformX,
    platformY,
    platformWidth,
    platformHeight,
  );
  if (!drewPlatform) {
    roundedRect(ctx, x, y, PLATFORM.width, PLATFORM.height, 16);
    ctx.fillStyle = '#b96f2c';
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 8;
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  if (state.phase === 'settling') {
    ctx.strokeStyle = 'rgba(255, 235, 155, 0.52)';
    ctx.lineWidth = 5;
    const wobble = Math.sin(state.time * 17) * 9;
    ctx.beginPath();
    ctx.moveTo(x - 20 + wobble, y - 10);
    ctx.lineTo(x - 44 + wobble, y - 22);
    ctx.moveTo(x + PLATFORM.width + 20 + wobble, y - 10);
    ctx.lineTo(x + PLATFORM.width + 44 + wobble, y - 22);
    ctx.stroke();
  }
  ctx.restore();
}

function drawActiveCharacterHighlight(ctx, team, centerX, centerY, width, height, time) {
  const highlightScale = 1.6;
  const rayCount = 30;
  const rayWeights = [0.72, 1.16, 0.86, 1.04, 0.64, 1.28];
  const rayLengths = [1, 0.82, 0.94, 0.76, 0.88, 0.97, 0.8];
  const rayColors = [team.main, '#fff1b8', team.light, '#d5a66e', '#fff8dc'];
  const totalWeight = Array.from(
    { length: rayCount },
    (_, index) => rayWeights[index % rayWeights.length],
  ).reduce((sum, value) => sum + value, 0);
  const outerRadius = Math.max(210, height * 0.69);

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.scale(highlightScale, highlightScale);
  const halo = ctx.createRadialGradient(0, 0, 16, 0, 0, outerRadius * 0.92);
  halo.addColorStop(0, 'rgba(255, 248, 216, 0.46)');
  halo.addColorStop(0.48, team.glow);
  halo.addColorStop(1, 'rgba(255, 248, 216, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.ellipse(0, 0, Math.max(142, width * 0.84), height * 0.66, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.rotate(time * 0.32);
  let startAngle = -Math.PI / 2;
  for (let index = 0; index < rayCount; index += 1) {
    const angleWidth = Math.PI * 2
      * rayWeights[index % rayWeights.length]
      / totalWeight;
    const endAngle = startAngle + angleWidth;
    const length = outerRadius * rayLengths[index % rayLengths.length];
    const brightness = 0.44 + (Math.sin(time * 2.1 + index * 1.37) + 1) * 0.17;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(startAngle) * length, Math.sin(startAngle) * length);
    ctx.lineTo(Math.cos(endAngle) * length, Math.sin(endAngle) * length);
    ctx.closePath();
    ctx.globalAlpha = brightness;
    ctx.fillStyle = rayColors[index % rayColors.length];
    ctx.fill();
    startAngle = endAngle;
  }
  ctx.globalAlpha = 1;
  const centerGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(60, width * 0.38));
  centerGlow.addColorStop(0, 'rgba(255, 250, 225, 0.68)');
  centerGlow.addColorStop(1, 'rgba(255, 250, 225, 0)');
  ctx.fillStyle = centerGlow;
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(60, width * 0.38), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawTurnPrompt(ctx, team, centerX, bottomY, fillStyle = team.dark) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.font = "900 33px 'Noto Sans TC', sans-serif";
  ctx.lineWidth = 8;
  ctx.strokeStyle = CREAM;
  ctx.fillStyle = fillStyle;
  ctx.strokeText('換你！', centerX, bottomY);
  ctx.fillText('換你！', centerX, bottomY);
}

function drawTeamCharacter(ctx, teamKey, state) {
  const team = TEAM_STYLE[teamKey];
  const active = state.currentTeam === teamKey && ['rolling', 'aiming', 'settling'].includes(state.phase);
  const key = teamKey === 'red' ? 'redCharacter' : 'blueCharacter';
  const image = themeImage(key);

  if (!imageReady(image)) {
    drawFallbackMascot(ctx, teamKey, teamKey === 'red' ? 128 : WORLD_W - 128, 760, state);
    return;
  }

  const height = 330;
  const width = height * image.naturalWidth / image.naturalHeight;
  const x = teamKey === 'red' ? 34 : WORLD_W - width - 34;
  const y = WORLD_H - height - 8;

  ctx.save();
  if (active) {
    drawActiveCharacterHighlight(
      ctx,
      team,
      x + width / 2,
      y + height * 0.57,
      width,
      height,
      state.time,
    );
  }
  ctx.globalAlpha = active ? 1 : 0.8;
  ctx.shadowBlur = active ? 38 : 10;
  ctx.shadowColor = active ? team.glow : 'rgba(71, 43, 24, 0.3)';
  ctx.drawImage(image, x, y, width, height);
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  if (active) {
    drawTurnPrompt(ctx, team, x + width / 2, y - 14);
  }
  ctx.restore();
}

function drawFallbackMascot(ctx, teamKey, x, y, state) {
  const team = TEAM_STYLE[teamKey];
  const active = state.currentTeam === teamKey && ['rolling', 'aiming', 'settling'].includes(state.phase);

  ctx.save();
  ctx.translate(x, y);
  if (active) drawActiveCharacterHighlight(ctx, team, 0, 0, 128, 180, state.time);
  ctx.shadowBlur = active ? 28 : 12;
  ctx.shadowColor = active ? team.glow : 'rgba(0,0,0,0.35)';
  ctx.fillStyle = team.main;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(0, 0, 64, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = CREAM;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(side * 23, -12, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(side * 23 + 2, -10, 6, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.fillStyle = CREAM;
  }

  ctx.beginPath();
  ctx.arc(0, 20, 20, 0.1 * Math.PI, 0.9 * Math.PI);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.font = "900 22px 'Noto Sans TC', sans-serif";
  ctx.fillStyle = CREAM;
  ctx.fillText(team.label, 0, 96);

  if (active) {
    drawTurnPrompt(ctx, team, 0, -78, '#ffe66d');
  }
  ctx.restore();
}

function drawHud(ctx, state) {
  drawTeamScore(ctx, 'red', 24, 18, state);
  drawTeamScore(ctx, 'blue', WORLD_W - 424, 18, state);

  ctx.save();
  const active = TEAM_STYLE[state.currentTeam];
  const turnWidth = 700;
  const turnHeight = 70;
  const turnX = WORLD_W / 2 - turnWidth / 2;
  const turnY = 10;
  if (!drawThemeImage(ctx, 'statusBar', turnX, turnY, turnWidth, turnHeight)) {
    roundedRect(ctx, turnX, turnY, turnWidth, turnHeight, 22);
    ctx.fillStyle = 'rgba(255, 247, 223, 0.94)';
    ctx.fill();
    ctx.strokeStyle = active.dark;
    ctx.lineWidth = 6;
    ctx.stroke();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  const seconds = Math.max(0, Math.ceil(state.turnTime));
  const phaseText = state.phase === 'settling'
    ? '等待家具完全停止'
    : active.label + ' · 還需 ' + state.placementsRemaining + ' 件 · ' + seconds + ' 秒';
  setFittedFont(ctx, phaseText, turnWidth - 140, 24, 20);
  ctx.fillText(phaseText, WORLD_W / 2, turnY + turnHeight / 2 + 1);

  if (state.phase === 'aiming') {
    const ratio = Math.max(0, state.turnTime / GAME_RULES.turnSeconds);
    const timerWidth = 340;
    const timerX = WORLD_W / 2 - timerWidth / 2;
    const timerY = turnY + turnHeight + 5;
    roundedRect(ctx, timerX, timerY, timerWidth, 12, 6);
    ctx.fillStyle = 'rgba(91, 55, 31, 0.28)';
    ctx.fill();
    roundedRect(ctx, timerX, timerY, timerWidth * ratio, 12, 6);
    ctx.fillStyle = ratio < 0.25 ? '#ffdf4e' : active.main;
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  const nextX = WORLD_W - 270;
  const nextY = 164;
  const nextWidth = 236;
  const nextHeight = 214;
  drawThemeImage(ctx, 'nextPanel', nextX, nextY, nextWidth, nextHeight);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#6d4a31';
  ctx.font = "800 17px 'Noto Sans TC', sans-serif";
  ctx.fillText('下一件', nextX + nextWidth / 2, nextY + 79);
  const nextLabel = state.nextShape?.label ?? '？';
  setFittedFont(ctx, nextLabel, nextWidth - 80, 22, 17);
  ctx.fillStyle = INK;
  ctx.fillText(nextLabel, nextX + nextWidth / 2, nextY + 111);
  drawFurniturePreview(
    ctx,
    state.nextShape,
    nextX + nextWidth / 2,
    nextY + 164,
    16,
  );
  ctx.restore();

  ctx.save();
  const statusX = 330;
  const statusY = 808;
  const statusWidth = 940;
  const statusHeight = 84;
  drawThemeImage(ctx, 'statusBar', statusX, statusY, statusWidth, statusHeight);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  const statusText = '已堆 ' + state.successfulPlacements + ' 件 · 本回合還需 ' + state.placementsRemaining + ' 件 · ' + active.label + '換物件剩 ' + state.shapeChangesRemaining[state.currentTeam] + ' 次';
  setFittedFont(ctx, statusText, statusWidth - 160, 18, 16);
  ctx.fillText(statusText, WORLD_W / 2, statusY + statusHeight / 2 + 1);
  ctx.restore();

  if (state.phase === 'aiming' && state.successfulPlacements === 0) {
    ctx.save();
    ctx.textAlign = 'center';
    const controlText = '← → 移動　↺ / ↻ 調角度　換物件　放下';
    setFittedFont(ctx, controlText, 760, 22, 16);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255, 247, 223, 0.9)';
    ctx.fillStyle = INK;
    ctx.strokeText(controlText, WORLD_W / 2, 770);
    ctx.fillText(controlText, WORLD_W / 2, 770);
    ctx.restore();
  }
}

function drawTeamScore(ctx, teamKey, x, y, state) {
  const team = TEAM_STYLE[teamKey];
  const w = 400;
  const h = 180;
  ctx.save();
  const panelKey = teamKey === 'red' ? 'redScorePanel' : 'blueScorePanel';
  if (!drawThemeImage(ctx, panelKey, x, y, w, h)) {
    roundedRect(ctx, x, y, w, h, 28);
    ctx.fillStyle = CREAM;
    ctx.fill();
    ctx.strokeStyle = team.dark;
    ctx.lineWidth = 6;
    ctx.stroke();
  }

  ctx.textAlign = teamKey === 'red' ? 'left' : 'right';
  ctx.textBaseline = 'middle';
  const safeInsetX = 72;
  const anchorX = teamKey === 'red' ? x + safeInsetX : x + w - safeInsetX;
  ctx.fillStyle = INK;
  setFittedFont(ctx, `${team.label} · ${state.playerNames[teamKey]}`, w - safeInsetX * 2, 24, 18);
  ctx.fillText(`${team.label} · ${state.playerNames[teamKey]}`, anchorX, y + 80);

  const dotGap = 34;
  const startX = teamKey === 'red' ? x + safeInsetX : x + w - safeInsetX;
  for (let i = 0; i < GAME_RULES.roundsToWin; i++) {
    const cx = teamKey === 'red' ? startX + i * dotGap : startX - i * dotGap;
    const scored = i < state.scores[teamKey];
    ctx.beginPath();
    ctx.arc(cx, y + 119, 11, 0, Math.PI * 2);
    ctx.fillStyle = scored ? team.main : 'rgba(101, 70, 43, 0.18)';
    ctx.shadowBlur = scored ? 9 : 0;
    ctx.shadowColor = scored ? team.glow : 'transparent';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = scored ? team.dark : INK;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.restore();
}

function drawSpinnerOverlay(ctx, state) {
  const team = TEAM_STYLE[state.currentTeam];
  ctx.save();
  ctx.fillStyle = 'rgba(55, 35, 20, 0.62)';
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  drawThemeImage(ctx, 'statusBar', 390, 30, 820, 80);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  const spinnerTitle = team.label + '轉動轉盤';
  setFittedFont(ctx, spinnerTitle, 680, 32, 26);
  ctx.fillText(spinnerTitle, WORLD_W / 2, 71);

  const wheel = themeImage('spinnerWheel');
  const wheelSize = 460;
  const wheelCenterX = WORLD_W / 2;
  const wheelCenterY = 500;
  ctx.save();
  ctx.translate(wheelCenterX, wheelCenterY);
  ctx.rotate(state.diceSpinAngle ?? 0);
  if (imageReady(wheel)) {
    ctx.drawImage(wheel, -wheelSize / 2, -wheelSize / 2, wheelSize, wheelSize);
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, wheelSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#d99a3f';
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 14;
    ctx.stroke();
  }
  ctx.restore();
  drawSpinnerNumbers(
    ctx,
    wheelCenterX,
    wheelCenterY,
    wheelSize,
    state.diceSpinAngle ?? 0,
  );

  const pointer = themeImage('spinnerPointer');
  const pointerHeight = 155;
  const pointerWidth = pointerHeight * 283 / 493;
  if (imageReady(pointer)) {
    ctx.drawImage(
      pointer,
      wheelCenterX - pointerWidth / 2,
      wheelCenterY - wheelSize / 2 - 62,
      pointerWidth,
      pointerHeight,
    );
  }

  drawThemeImage(ctx, 'statusBar', 390, 798, 820, 82);
  const spinnerHelp = '轉到的數字＝本回合需要放置的家具數';
  setFittedFont(ctx, spinnerHelp, 660, 20, 18);
  ctx.fillStyle = INK;
  ctx.fillText(spinnerHelp, WORLD_W / 2, 840);
  ctx.restore();
}

function drawSpinnerNumbers(ctx, centerX, centerY, wheelSize, rotation) {
  const radius = wheelSize * 0.27;
  const labels = [
    { value: '1', angle: -Math.PI * 5 / 6 },
    { value: '2', angle: -Math.PI / 6 },
    { value: '3', angle: Math.PI / 2 },
  ];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = "900 72px 'Noto Sans TC', sans-serif";
  ctx.lineWidth = 10;
  ctx.strokeStyle = CREAM;
  ctx.fillStyle = INK;
  for (const label of labels) {
    const rotatedAngle = label.angle + rotation;
    const x = centerX + Math.cos(rotatedAngle) * radius;
    const y = centerY + Math.sin(rotatedAngle) * radius;
    ctx.strokeText(label.value, x, y);
    ctx.fillText(label.value, x, y);
  }
}

function setFittedFont(ctx, text, maxWidth, maximumSize, minimumSize) {
  let size = maximumSize;
  while (size > minimumSize) {
    ctx.font = `900 ${size}px 'Noto Sans TC', sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) return;
    size -= 1;
  }
  ctx.font = `900 ${minimumSize}px 'Noto Sans TC', sans-serif`;
}
function drawOverlay(ctx, state) {
  if (state.phase === 'rolling') {
    drawSpinnerOverlay(ctx, state);
    return;
  }
  if (state.phase !== 'round-over' && state.phase !== 'match-over') return;

  const winner = TEAM_STYLE[state.roundWinner ?? state.matchWinner];
  ctx.save();
  ctx.fillStyle = 'rgba(3, 5, 20, 0.64)';
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  const panelX = 390;
  const panelY = 295;
  const panelWidth = 820;
  const panelHeight = 305;
  if (!drawThemeImage(ctx, 'victoryPanel', panelX, panelY, panelWidth, panelHeight)) {
    roundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 34);
    ctx.fillStyle = 'rgba(255, 247, 223, 0.96)';
    ctx.fill();
    ctx.strokeStyle = winner?.main ?? '#ffe66d';
    ctx.lineWidth = 10;
    ctx.stroke();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  // 用比分判斷比賽是否已經決定,而不是只看 state.phase —— 這一局結束的當下
  // phase 還是 'round-over'(要等 roundPauseSeconds 跑完才會變 'match-over'),
  // 但如果這局的贏家已經達到 roundsToWin,比賽其實已經結束了,文字要跟著對。
  const matchDecided = state.scores[state.roundWinner] >= GAME_RULES.roundsToWin;
  const title = matchDecided
    ? `${winner.label}贏得比賽！`
    : `${winner.label}拿下一局！`;
  setFittedFont(ctx, title, 650, 58, 42);
  ctx.fillText(title, WORLD_W / 2, 414);

  const roundReason = state.roundReason || '物件掉出平台';
  setFittedFont(ctx, roundReason, 640, 27, 20);
  ctx.fillStyle = '#5d4940';
  ctx.fillText(roundReason, WORLD_W / 2, 471);

  ctx.font = "800 20px 'Noto Sans TC', sans-serif";
  ctx.fillStyle = 'rgba(42,29,25,0.6)';
  ctx.fillText(
    matchDecided ? '即將回到大廳結算' : '下一局交換先手',
    WORLD_W / 2,
    513,
  );
  ctx.restore();
}

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
