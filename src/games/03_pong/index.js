/**
 * Pong — 2-player paddle game ported from games-pong/screen.html
 *
 * Logical coordinate space: x 0-200, y 0-100
 * Ball scores when it exits left (<= 0) or right (>= 200).
 * Game ends when a player reaches 4 points (score > 3).
 */
import { truncateName } from '../../shared/nameDisplay.js';
import { preloadImages, drawAssetLoadingPlaceholder } from '../../shared/assetPreload.js';
import { bgm, SFX } from './audio.js';

const WIN_SCORE = 4;
// Full-height (100 logical units) sweep in ~1.2s at max stick deflection —
// was 50 (2s sweep), which felt sluggish once the ball ramps up toward
// BALL_SPEED_MAX.
const PADDLE_SPEED = 85; // logical units / sec
const BALL_SPEED_INIT = 50;  // logical units / sec
const BALL_SPEED_STEP = 1.18; // +18% speed on every paddle hit — ramps up fast
const BALL_SPEED_MAX  = 220; // cap at 4.4x — still reactable, just a lot more urgent
// At BALL_SPEED_MAX with a stalled/dropped frame (dt capped at 20ms upstream),
// the ball can move ~4.4 logical units in one step — wider than the old ±2
// hit window, which would let it tunnel through the paddle undetected.
const PADDLE_HIT_DEPTH = 3;

const bgImg = new Image();
bgImg.src = '03_pong/pong_bg.png';

// pong_bg.png draws a decorative black+white picture-frame border OUTSIDE
// the actual white court line — logical space (0-200 x, 0-100 y) needs to
// map onto that inner white-lined rect, not the raw canvas edge, or the
// ball visibly crosses into the frame before bouncing/scoring registers.
// Measured directly against the image (fraction of canvas width/height).
const COURT_X0 = 0.0443, COURT_X1 = 0.9551;
const COURT_Y0 = 0.0756, COURT_Y1 = 0.9297;

// --- Power-ups -------------------------------------------------------------
// Spawn between the paddles; whoever last hit the ball claims the pickup when
// the ball rolls over it. Ball-speed ones apply for the rest of the rally,
// paddle ones are timed. Everything resets when a point is scored.
const POWERUP_TYPES = [
  { type: 'fast',   emoji: '⚡', color: '#ffd54a', label: '球速提升' },
  { type: 'slow',   emoji: '🐌', color: '#7ec8e3', label: '球速減慢' },
  { type: 'shrink', emoji: '🔻', color: '#ff6b6b', label: '縮小對手板子' },
  { type: 'grow',   emoji: '💪', color: '#7bd88f', label: '板子變大' },
];
const PU_RADIUS = 4;          // logical units
const PU_MAX_ONFIELD = 2;
const PU_EFFECT_DURATION = 6; // seconds, for shrink/grow
const PADDLE_BASE_H = 20;

let pg = null; // module-level pong state

function makePaddle(x, deviceId, name) {
  return {
    deviceId,
    name,
    pos: { x, y: 50 },
    move: { y: 0 },
    height: PADDLE_BASE_H,
  };
}

function resetBall(vx, vy) {
  if (!pg) return;
  pg.ball.pos.x = 100;
  pg.ball.pos.y = 50;
  pg.ball.move.x = vx;
  pg.ball.move.y = vy;
  pg.rallySpeed = BALL_SPEED_INIT;
  // Fresh rally, fresh field — clear pickups and revert paddle effects
  pg.powerups = [];
  pg.activeEffects = [];
  pg.lastHitter = null;
  pg.puTimer = 2.5 + Math.random() * 2;
}

// Paddle bounces add "spin" by nudging move.y based on where the ball hit
// the paddle, which would otherwise let the vector's magnitude drift up or
// down on its own. Re-normalizing to pg.rallySpeed after every hit keeps
// speed a deliberate, escalating value instead of an accident of angles.
function rescaleBallSpeed() {
  const { move } = pg.ball;
  const mag = Math.hypot(move.x, move.y) || 1;
  const scale = pg.rallySpeed / mag;
  move.x *= scale;
  move.y *= scale;
}

function spawnPowerup() {
  const def = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  pg.powerups.push({
    ...def,
    x: 60 + Math.random() * 80,   // keep clear of both paddles
    y: 18 + Math.random() * 64,   // keep clear of top/bottom walls
    phase: Math.random() * Math.PI * 2,
  });
}

function applyPowerup(pu, globalState) {
  const owner = pg.lastHitter;
  const ownerName = _name(globalState, pg.paddles[owner].deviceId);

  switch (pu.type) {
    case 'fast':
      pg.rallySpeed = Math.min(pg.rallySpeed * 1.5, BALL_SPEED_MAX);
      rescaleBallSpeed();
      break;
    case 'slow':
      pg.rallySpeed = Math.max(pg.rallySpeed * 0.6, 30);
      rescaleBallSpeed();
      break;
    case 'shrink':
      pg.activeEffects.push({ type: 'shrink', target: 1 - owner, t: PU_EFFECT_DURATION });
      break;
    case 'grow':
      pg.activeEffects.push({ type: 'grow', target: owner, t: PU_EFFECT_DURATION });
      break;
  }

  pg.scoreMsg = `${ownerName} ${pu.emoji} ${pu.label}！`;
  pg.scoreMsgTimer = 1.5;
  SFX.ding();
}

// Recompute paddle heights from base + whatever timed effects are running
function updatePaddleEffects(dt) {
  for (const e of pg.activeEffects) e.t -= dt;
  pg.activeEffects = pg.activeEffects.filter(e => e.t > 0);

  for (let i = 0; i < 2; i++) {
    let h = PADDLE_BASE_H;
    for (const e of pg.activeEffects) {
      if (e.target !== i) continue;
      if (e.type === 'shrink') h -= 8;
      if (e.type === 'grow') h += 10;
    }
    pg.paddles[i].height = Math.max(8, Math.min(36, h));
  }
}

export default {
  id: 'pong',
  name: '乒乓對戰',
  description: '2-player paddle battle',
  playersPerTeam: 1,
  color: '#00cfff',
  emoji: '🏓',
  cover: '03_pong/pong_cover.png',

  tutorial: {
    pages: [
      '03_pong/tutorial/1.png',
      '03_pong/tutorial/2.png',
    ],
  },

  onStart(globalState, endCb) {
    bgm.start();
    // Red plays the left paddle, blue the right — drawn players only
    const active = globalState.activePlayers || {};
    const teams  = globalState.teams || {};
    const playing = Object.entries(active)
      .filter(([, role]) => role === 'playing')
      .map(([id]) => id);
    const ids = playing.length >= 2 ? playing : Object.keys(globalState.players || {});
    const redId  = ids.find(id => teams[id] === 'red')  ?? ids[0] ?? null;
    const blueId = ids.find(id => teams[id] === 'blue' && id !== redId) ?? ids.find(id => id !== redId) ?? null;
    pg = {
      paddles: [
        makePaddle(22, redId, _name(globalState, redId)),
        makePaddle(178, blueId, _name(globalState, blueId)),
      ],
      ball: { pos: { x: 100, y: 50 }, move: { x: 0, y: 0 } },
      score: [0, 0],
      scoreMsg: null,
      scoreMsgTimer: 0,
      time: 0,
      powerups: [],
      activeEffects: [],
      lastHitter: null,
      puTimer: 0,
      assetsReady: false,
      _endCb: endCb,
      _globalState: globalState,
    };
    resetBall(BALL_SPEED_INIT, 0);
    preloadImages([bgImg]).then(() => { if (pg) pg.assetsReady = true; });
  },

  preload() {
    return preloadImages([bgImg]);
  },

  update(dt, globalState) {
    if (!pg || !pg.assetsReady) return;

    const { paddles, ball, score } = pg;

    pg.time += dt;

    // Score message timeout
    if (pg.scoreMsgTimer > 0) {
      pg.scoreMsgTimer -= dt;
      if (pg.scoreMsgTimer <= 0) pg.scoreMsg = null;
    }

    // Timed paddle effects (shrink/grow)
    updatePaddleEffects(dt);

    // Power-up spawning — keep a trickle coming mid-court
    pg.puTimer -= dt;
    if (pg.puTimer <= 0 && pg.powerups.length < PU_MAX_ONFIELD) {
      spawnPowerup();
      pg.puTimer = 4 + Math.random() * 4;
    }

    // Move paddles
    for (const p of paddles) {
      p.pos.y += p.move.y * dt;
      const half = p.height / 2;
      p.pos.y = Math.max(half, Math.min(100 - half, p.pos.y));
    }

    // Move ball
    ball.pos.x += ball.move.x * dt;
    ball.pos.y += ball.move.y * dt;

    // Wall bounce (top / bottom)
    if (ball.pos.y <= 1) { ball.pos.y = 1; ball.move.y *= -1; }
    if (ball.pos.y >= 99) { ball.pos.y = 99; ball.move.y *= -1; }

    // Left paddle bounce
    const lh = paddles[0].height;
    if (
      ball.pos.x >= paddles[0].pos.x - PADDLE_HIT_DEPTH && ball.pos.x <= paddles[0].pos.x + PADDLE_HIT_DEPTH &&
      ball.pos.y >= paddles[0].pos.y - lh / 2 && ball.pos.y <= paddles[0].pos.y + lh / 2
    ) {
      ball.move.x = Math.abs(ball.move.x); // always bounce right
      ball.move.y += (ball.pos.y - paddles[0].pos.y) * 2;
      ball.pos.x = paddles[0].pos.x + 2;
      pg.rallySpeed = Math.min(pg.rallySpeed * BALL_SPEED_STEP, BALL_SPEED_MAX);
      rescaleBallSpeed();
      pg.lastHitter = 0;
      SFX.hit();
    }

    // Right paddle bounce
    const rh = paddles[1].height;
    if (
      ball.pos.x >= paddles[1].pos.x - PADDLE_HIT_DEPTH && ball.pos.x <= paddles[1].pos.x + PADDLE_HIT_DEPTH &&
      ball.pos.y >= paddles[1].pos.y - rh / 2 && ball.pos.y <= paddles[1].pos.y + rh / 2
    ) {
      ball.move.x = -Math.abs(ball.move.x); // always bounce left
      ball.move.y += (ball.pos.y - paddles[1].pos.y) * 2;
      ball.pos.x = paddles[1].pos.x - 2;
      pg.rallySpeed = Math.min(pg.rallySpeed * BALL_SPEED_STEP, BALL_SPEED_MAX);
      rescaleBallSpeed();
      pg.lastHitter = 1;
      SFX.hit();
    }

    // Power-up pickup — the ball itself collects; credit goes to whoever
    // hit it last, so serves (lastHitter === null) pass straight through
    if (pg.lastHitter !== null) {
      for (let i = pg.powerups.length - 1; i >= 0; i--) {
        const pu = pg.powerups[i];
        if (Math.abs(ball.pos.x - pu.x) < PU_RADIUS + 2 &&
            Math.abs(ball.pos.y - pu.y) < PU_RADIUS + 3) {
          pg.powerups.splice(i, 1);
          applyPowerup(pu, globalState);
          _vibratePlayer(globalState, paddles[pg.lastHitter].deviceId);
        }
      }
    }

    // Scoring
    if (ball.pos.x >= 200) {
      score[0] += 1;
      SFX.ding();
      _vibratePlayer(globalState, paddles[1].deviceId);
      if (score[0] >= WIN_SCORE) { _finish(globalState, 0); return; }
      pg.scoreMsg = `${_name(globalState, paddles[0].deviceId)} 得分！`;
      pg.scoreMsgTimer = 1.5;
      resetBall(-BALL_SPEED_INIT, 0);
    } else if (ball.pos.x <= 0) {
      score[1] += 1;
      SFX.ding();
      _vibratePlayer(globalState, paddles[0].deviceId);
      if (score[1] >= WIN_SCORE) { _finish(globalState, 1); return; }
      pg.scoreMsg = `${_name(globalState, paddles[1].deviceId)} 得分！`;
      pg.scoreMsgTimer = 1.5;
      resetBall(BALL_SPEED_INIT, 0);
    }

  },

  draw(ctx, w, h) {
    if (!pg) return;
    if (!pg.assetsReady) { drawAssetLoadingPlaceholder(ctx, w, h, '乒乓對戰'); return; }

    const { paddles, ball, score, scoreMsg } = pg;

    // Map logical coords to canvas pixels — tx/ty are ABSOLUTE positions
    // (offset to land inside the court's white line, see COURT_X0 etc.
    // above); sx/sy are pure width/height deltas with no offset, for sizes
    // like paddle/ball radius that must scale but not shift.
    const scaleX = (COURT_X1 - COURT_X0) * (w / 200);
    const scaleY = (COURT_Y1 - COURT_Y0) * (h / 100);
    const tx = x => (COURT_X0 * w + x * scaleX) | 0;
    const ty = y => (COURT_Y0 * h + y * scaleY) | 0;
    const sx = x => x * scaleX;
    const sy = y => y * scaleY;

    // Background
    if (bgImg.complete && bgImg.naturalWidth) {
      ctx.drawImage(bgImg, 0, 0, w, h);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
    }

    // Center dashed line — spans ty(0)..ty(100), the court's true top/bottom
    // white line, not the raw canvas edge (0..h)
    ctx.save();
    ctx.setLineDash([sy(4), sy(4)]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tx(100), ty(0));
    ctx.lineTo(tx(100), ty(100));
    ctx.stroke();
    ctx.restore();

    // Power-ups — pulsing chips so they read as pickups, not obstacles
    for (const pu of pg.powerups) {
      const px = tx(pu.x);
      const py = ty(pu.y);
      const pulse = 1 + 0.12 * Math.sin(pg.time * 5 + pu.phase);
      const r = sy(PU_RADIUS) * pulse;

      ctx.beginPath();
      ctx.arc(px, py, r + 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.strokeStyle = pu.color;
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.font = `${Math.floor(r * 1.3)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pu.emoji, px, py + 1);
    }

    // Paddles
    ctx.fillStyle = '#fff';
    for (const p of paddles) {
      const pw = Math.max(sx(2), 4);
      const ph = sy(p.height);
      ctx.fillRect(tx(p.pos.x - 1), ty(p.pos.y) - (ph >> 1), pw, ph);
    }

    // Ball
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(tx(ball.pos.x), ty(ball.pos.y), Math.max(sx(2), 5), 0, Math.PI * 2);
    ctx.fill();

    // Score — on a dark chip so it stays legible over the board frame
    const fontSize = Math.max(Math.floor(h * 0.07), 20);
    ctx.font = `${fontSize}px 'Press Start 2P', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const sepText = '  :  ';
    const scorePadX = 20;
    const sepW = ctx.measureText(sepText).width;
    const scoreW = ctx.measureText(`${score[0]}${sepText}${score[1]}`).width + scorePadX * 2;
    const scoreH = fontSize + 16;
    const scoreY = ty(4) - 8;
    ctx.fillStyle = 'rgba(10, 8, 6, 0.65)';
    ctx.beginPath();
    ctx.roundRect(w / 2 - scoreW / 2, scoreY, scoreW, scoreH, 12);
    ctx.fill();
    // Each side's score in its team color — red left, blue right
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(':', w / 2, ty(4));
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ff6b6b';
    ctx.fillText(String(score[0]), w / 2 - sepW / 2, ty(4));
    ctx.textAlign = 'left';
    ctx.fillStyle = '#4ecdc4';
    ctx.fillText(String(score[1]), w / 2 + sepW / 2, ty(4));

    // Names — same nickname-display treatment as hospital/volleyball: real
    // nickname, bold text on a dark chip, tinted by team color, corner-fixed
    // since the paddle itself has no head to float a label above.
    const nameSize = Math.max(Math.floor(h * 0.032), 13);
    ctx.font = `bold ${nameSize}px 'Noto Sans TC', sans-serif`;
    ctx.textBaseline = 'top';
    const namePadX = 12;
    const nameChipH = nameSize + 14;
    const nameChipY = ty(4);

    ctx.textAlign = 'left';
    const leftName = paddles[0].name;
    const leftW = ctx.measureText(leftName).width + namePadX * 2;
    ctx.fillStyle = 'rgba(10, 8, 6, 0.6)';
    ctx.fillRect(namePadX, nameChipY, leftW, nameChipH);
    ctx.fillStyle = '#ff6b6b';
    ctx.fillText(leftName, namePadX * 2, nameChipY + 7);

    ctx.textAlign = 'right';
    const rightName = paddles[1].name;
    const rightW = ctx.measureText(rightName).width + namePadX * 2;
    ctx.fillStyle = 'rgba(10, 8, 6, 0.6)';
    ctx.fillRect(w - namePadX - rightW, nameChipY, rightW, nameChipH);
    ctx.fillStyle = '#4ecdc4';
    ctx.fillText(rightName, w - namePadX * 2, nameChipY + 7);

    // Transient score / power-up message — Noto Sans TC so the Chinese
    // pickup labels render instead of falling out of Press Start 2P
    if (scoreMsg) {
      const msgSize = Math.max(Math.floor(h * 0.045), 16);
      ctx.font = `bold ${msgSize}px 'Noto Sans TC', sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.strokeText(scoreMsg, w / 2, h / 2);
      ctx.fillStyle = '#ffe066';
      ctx.fillText(scoreMsg, w / 2, h / 2);
    }
  },

  onInput(deviceId, data) {
    if (!pg) return;
    const did = String(deviceId);
    const player = pg.paddles.find(p => String(p.deviceId) === did);
    if (!player) return;

    if (data.action === 'move') player.move.y = (data.dy ?? 0) * PADDLE_SPEED;
  },

  onEnd() {
    bgm.stop();
    pg = null;
  },
};

function _name(globalState, deviceId) {
  return truncateName(globalState.players?.[deviceId]?.name ?? `Player ${deviceId}`);
}

function _vibratePlayer(globalState, deviceId) {
  if (!deviceId) return;
  if (!globalState._pendingMessages) globalState._pendingMessages = [];
  globalState._pendingMessages.push({ type: 'hit_confirm', deviceId: String(deviceId) });
}

function _finish(globalState, winnerIdx) {
  if (!pg) return;
  // Credit the winner's score to the hub scoreboard
  const winnerId = pg.paddles[winnerIdx].deviceId;
  if (winnerId && globalState.players?.[winnerId]) {
    globalState.players[winnerId].score =
      (globalState.players[winnerId].score || 0) + pg.score[winnerIdx];
  }
  const winnerTeam = winnerId ? (globalState.teams?.[winnerId] ?? null) : null;
  pg._endCb?.(winnerTeam, { label: '比分', red: String(pg.score[0]), blue: String(pg.score[1]) });
}
