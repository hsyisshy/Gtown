import {
  W, H, GROUND_Y, NET_X, NET_H, NET_W, NET_TOP,
  BALL_R, PLAYER_W, PLAYER_H, LEFT_WALL, RIGHT_WALL, WIN_SCORE,
} from './constants.js';

// --- Sprite assets — preloaded at module import so they're decoded well
// before a match starts (same pattern as truck/animals).
const bgImg = new Image();
bgImg.src = 'volleyball/volleyball_bg.png';

const SPRITES = { red: [], blue: [] };
for (const team of ['red', 'blue']) {
  for (let i = 1; i <= 3; i++) {
    const img = new Image();
    img.src = `volleyball/characters/${team}_player${i}.png`;
    SPRITES[team].push(img);
  }
}

// The character art fills ~80% of its square canvas; this draw height keeps
// the visible character close to the old vector player's proportions.
const SPRITE_DRAW_H = PLAYER_H * 1.95;

// Transparent padding below the shoes as a fraction of the square canvas
// (measured: feet bottom ≈ 88.3% down → ~11.7% empty beneath). We drop the
// sprite by this much so the *visible* feet land on the ground line / shadow
// instead of the image's transparent bottom edge floating the player up.
const SPRITE_FOOT_PAD = 0.117;

export function render(ctx, canvasW, canvasH, vbState) {
  if (!vbState) return;

  const scale = Math.min(canvasW / W, canvasH / H);
  const ox = (canvasW - W * scale) / 2;
  const oy = (canvasH - H * scale) / 2;

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);

  drawBackground(ctx);
  drawNet(ctx);

  const { ball, players } = vbState;

  ctx.save();
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = '#000';
  const shadowWidth = BALL_R * 2 * (1 - Math.min(1, (GROUND_Y - ball.y) / 400));
  ctx.beginPath();
  ctx.ellipse(ball.x, GROUND_Y, Math.max(4, shadowWidth), 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  drawBall(ctx, ball);

  for (const p of players.left)  drawPlayer(ctx, p, '#ff6b6b', vbState);
  for (const p of players.right) drawPlayer(ctx, p, '#4ecdc4', vbState);

  drawHUD(ctx, vbState);

  ctx.restore();
}

function drawBackground(ctx) {
  if (bgImg.complete && bgImg.naturalWidth) {
    ctx.drawImage(bgImg, 0, 0, W, H);
  } else {
    // Fallback until the image decodes (first frames on a cold cache)
    const skyGrad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    skyGrad.addColorStop(0, '#4aa8e0');
    skyGrad.addColorStop(1, '#8fd4f5');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, GROUND_Y);
    ctx.fillStyle = '#f0d98c';
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
  }
}

function drawNet(ctx) {
  const netLeft = NET_X - NET_W / 2;

  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(netLeft, NET_TOP, NET_W, NET_H);

  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  const gridSize = 20;
  for (let y = NET_TOP; y < GROUND_Y; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(netLeft, y);
    ctx.lineTo(netLeft + NET_W, y);
    ctx.stroke();
  }

  ctx.fillStyle = '#fff';
  ctx.fillRect(netLeft - 2, NET_TOP - 2, NET_W + 4, 10);

  ctx.fillStyle = '#888';
  ctx.fillRect(netLeft + NET_W / 2 - 2, NET_TOP - 20, 4, NET_H + 20);
}

function drawBall(ctx, ball) {
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
  ctx.fillStyle = '#FFE234';
  ctx.fill();
  ctx.strokeStyle = '#c8a800';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.strokeStyle = '#c8a800';
  ctx.lineWidth = 1.5;

  ctx.beginPath();
  ctx.arc(ball.x, ball.y, BALL_R - 4, -Math.PI * 0.3, Math.PI * 0.3);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(ball.x - BALL_R * 0.5, ball.y, BALL_R - 4, Math.PI * 0.2, Math.PI * 0.8);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(ball.x + BALL_R * 0.5, ball.y, BALL_R - 4, Math.PI * 0.2, Math.PI * 0.8);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// --- Procedural motion tuning ------------------------------------------
// Three static poses can't form a real walk cycle, so the "life" comes from
// foot-anchored squash/stretch + a lean layered on top of a *semantic* pose
// choice. All vertical motion is scaleY around the planted feet, so the
// shoes never lift off the ground line no matter how the body bounces.
const STEP_HZ     = 8.5;   // stride cadence while running (×time, rad)
const RUN_LEAN    = 0.10;  // torso tilt (rad) into the travel direction
const RUN_BOUNCE  = 0.06;  // scaleY swing across one stride
const IDLE_HZ     = 1.8;   // breathing cadence
const IDLE_BREATH = 0.035; // scaleY swing while idle

// How the three poses interleave, plus the secondary motion that sells each:
//   idle     → pose 0 (calm ready) + gentle breathing, no frame jitter
//   running  → pose 0 ↔ 1 synced to a bounce — stand tall through the rise,
//              drop into the deep crouch on the foot-plant, torso leaning
//              into the direction of travel (reads as a shuffle/stride)
//   jumping  → pose 2 (arms reaching up), slight lean
//   hit/spike→ pose 2 with a quick swing toward the net that eases back out
// Returns { frame, rot, sx, sy }: pose index, lean angle, and foot-anchored
// squash factors.
function spriteAnim(player, time) {
  // Offset players so nobody bounces/breathes in lockstep — by side, and by
  // slot so 2v2 teammates on the same side stay desynced too.
  const t = time + (player.side === 'left' ? 0 : 0.25) + (player.slot || 0) * 0.5;
  const faceNet = player.side === 'left' ? 1 : -1;

  switch (player.animState) {
    case 'running': {
      const step = Math.abs(Math.sin(t * STEP_HZ)); // 0 on plant, 1 mid-stride
      return {
        frame: step > 0.5 ? 0 : 1,                   // tall on rise, crouch on plant
        rot: Math.sign(player.vx) * RUN_LEAN,
        sy: 1 - RUN_BOUNCE + step * RUN_BOUNCE * 2,  // compress → pop
        sx: 1 + RUN_BOUNCE - step * RUN_BOUNCE * 2,  // preserve volume
      };
    }
    case 'jumping':
      return { frame: 2, rot: Math.sign(player.vx) * RUN_LEAN * 0.5, sx: 1, sy: 1 };
    case 'hitting':
    case 'spiking': {
      const swing = player.hitTimer > 0 ? player.hitTimer / 0.25 : 0; // 1 → 0
      const pop = 1 + 0.06 * swing;
      return {
        frame: 2,
        rot: faceNet * 0.20 * swing,                 // snap toward net, ease back
        sx: pop,
        sy: pop,
      };
    }
    default: { // idle
      const b = Math.sin(t * IDLE_HZ);
      return {
        // Mostly the upright ready stance; briefly settle into the deep
        // crouch at the bottom of each breath so a standing player still
        // visibly shifts weight (not a fast jitter).
        frame: b < -0.6 ? 1 : 0,
        rot: b * 0.02,                               // faint sway keeps it alive
        sy: 1 + b * IDLE_BREATH,
        sx: 1 - b * IDLE_BREATH * 0.7,
      };
    }
  }
}

function drawPlayer(ctx, player, teamColor, vbState) {
  const { x, y, onGround, fallTimer } = player;
  const time = vbState.time;
  const team = player.side === 'left' ? 'red' : 'blue';

  ctx.save();

  if (fallTimer > 0) {
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 2);
    ctx.translate(-x, -y);

    const numStars = 3;
    for (let i = 0; i < numStars; i++) {
      const angle = (time * 3 + (i / numStars) * Math.PI * 2);
      const sr = PLAYER_W * 0.8;
      const sx = x + Math.cos(angle) * sr;
      const sy = y - PLAYER_H * 0.6 + Math.sin(angle) * sr * 0.4;
      ctx.fillStyle = '#FFD700';
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.save();
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(x, GROUND_Y + 2, PLAYER_W * 0.4, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Airborne stretch/squash — grounded "life" comes from the anim below.
  let scaleY = 1.0;
  let scaleX = 1.0;
  if (!onGround) {
    if (player.vy < -200)     { scaleY = 0.95; scaleX = 1.04; } // rising: stretch
    else if (player.vy > 200) { scaleY = 1.02; scaleX = 0.99; } // falling: slight
  }

  // Layer the pose + procedural squash/lean (skipped mid-topple; the 90°
  // rotation above already owns that frame).
  const anim = fallTimer > 0
    ? { frame: 0, rot: 0, sx: 1, sy: 1 }
    : spriteAnim(player, time);
  scaleX *= anim.sx;
  scaleY *= anim.sy;

  // Foot line uses the *unscaled* body height so squash/stretch grows the
  // body from planted feet — the shoes stay welded to the ground line
  // (and to the shadow) regardless of the bounce.
  const footY = y + PLAYER_H / 2;
  const drawH = SPRITE_DRAW_H * scaleY;
  const drawW = SPRITE_DRAW_H * scaleX;

  // Push the image down by its below-the-feet padding so the shoes (not the
  // transparent canvas edge) sit on footY. This holds for any drawH.
  const spriteBottom = footY + drawH * SPRITE_FOOT_PAD;

  const img = SPRITES[team][anim.frame];
  if (img.complete && img.naturalWidth) {
    ctx.save();
    if (anim.rot) {
      // Lean pivots on the foot point so the shoes stay planted.
      ctx.translate(x, spriteBottom);
      ctx.rotate(anim.rot);
      ctx.translate(-x, -spriteBottom);
    }
    ctx.drawImage(img, x - drawW / 2, spriteBottom - drawH, drawW, drawH);
    ctx.restore();
  } else {
    // Sprite not decoded yet — placeholder block so the player never vanishes
    ctx.fillStyle = teamColor;
    roundRect(ctx, x - (PLAYER_W * scaleX) / 2, y - (PLAYER_H * scaleY) / 2,
              PLAYER_W * scaleX, PLAYER_H * scaleY, 12);
    ctx.fill();
  }

  ctx.restore();

  // Drawn after restore (outside the fallTimer rotate transform) so the
  // nameplate stays upright and legible even while the character topples.
  // Anchored to spriteBottom so it tracks the head after the foot-pad drop.
  const spriteTop = spriteBottom - drawH * 0.82;
  drawNameplate(ctx, player, x, spriteTop, teamColor);
}

// Same nickname-display treatment as hospital: real nickname, bold text on
// a dark chip, tinted by team color, floating above the character's head.
function drawNameplate(ctx, player, x, topY, teamColor) {
  if (!player.name) return;
  const nameY = topY - 12;
  ctx.font = 'bold 18px "Noto Sans TC", sans-serif';
  ctx.textAlign = 'center';
  const textW = ctx.measureText(player.name).width;
  const padX = 8;
  ctx.fillStyle = 'rgba(10, 8, 6, 0.6)';
  ctx.fillRect(x - textW / 2 - padX, nameY - 15, textW + padX * 2, 21);
  ctx.fillStyle = teamColor;
  ctx.fillText(player.name, x, nameY);
}

function drawHUD(ctx, vbState) {
  const { scores, winner, lastScorer, phase, pointPauseTimer } = vbState;

  ctx.font = 'bold 72px Arial';
  ctx.textAlign = 'center';

  // Dark outline keeps the score readable against the bright sky
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.strokeText(String(scores.left), W * 0.25, 80);
  ctx.strokeText(String(scores.right), W * 0.75, 80);

  ctx.fillStyle = scores.left >= WIN_SCORE - 1 ? '#FFD700' : '#fff';
  ctx.fillText(String(scores.left), W * 0.25, 80);

  ctx.fillStyle = scores.right >= WIN_SCORE - 1 ? '#FFD700' : '#fff';
  ctx.fillText(String(scores.right), W * 0.75, 80);

  ctx.font = 'bold 48px Arial';
  ctx.lineWidth = 6;
  ctx.strokeText(':', W / 2, 75);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(':', W / 2, 75);

  if (phase === 'point' && lastScorer && !winner) {
    const alpha = Math.min(1, pointPauseTimer / 0.5);
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 90px Arial';
    const color = lastScorer === 'left' ? '#ff6b6b' : '#4ecdc4';
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 20;
    ctx.fillText('POINT!', W / 2, H / 2);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  if (winner) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, H / 2 - 80, W, 150);
    ctx.font = 'bold 90px Arial';
    const color = winner === 'left' ? '#ff6b6b' : '#4ecdc4';
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 30;
    ctx.fillText(winner.toUpperCase() + ' WINS!', W / 2, H / 2 + 30);
    ctx.shadowBlur = 0;
    ctx.font = '28px Arial';
    ctx.fillStyle = '#aaa';
    ctx.fillText(`${scores.left} — ${scores.right}`, W / 2, H / 2 + 75);
  }
}

