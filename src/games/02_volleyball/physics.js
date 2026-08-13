import {
  GROUND_Y, NET_X, NET_TOP, NET_W, LEFT_WALL, RIGHT_WALL,
  GRAVITY_BASE, PLAYER_GRAVITY, PLAYER_SPEED, BALL_R,
  PLAYER_W, PLAYER_H, HIT_RADIUS, HIT_WINDOW, HIT_COOLDOWN,
} from './constants.js';
import { SFX } from './audio.js';

export function updatePhysics(dt, vbState) {
  updatePlayers(dt, vbState);
  if (vbState.phase === 'serving') {
    updateBallFalling(dt, vbState); // ball falls from above during serve
    checkHits(vbState);             // intentional hit → transitions to rally
    checkBodyCollision(vbState);    // body contact → also starts rally (no pass-through)
    return null;
  }
  updateBall(dt, vbState);
  checkHits(vbState);            // intentional hit (button press) — takes priority
  checkBodyCollision(vbState);   // passive: ball touching player body without button
  return checkScoring(vbState);
}

// During serving: ball drifts down slowly. No ground bounce — hitting ground = server loses.
function updateBallFalling(dt, vbState) {
  const { ball } = vbState;
  const gravity = GRAVITY_BASE * 0.35; // slow drift

  ball.vy += gravity * dt;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  if (ball.x - BALL_R <= LEFT_WALL)  { ball.x = LEFT_WALL + BALL_R;  ball.vx *= -0.85; }
  if (ball.x + BALL_R >= RIGHT_WALL) { ball.x = RIGHT_WALL - BALL_R; ball.vx *= -0.85; }
}

function updatePlayers(dt, vbState) {
  const gravity = PLAYER_GRAVITY;

  for (const side of ['left', 'right']) {
    for (const p of vbState.players[side]) {
      if (p.fallTimer > 0) {
        p.fallTimer -= dt;
        if (p.fallTimer <= 0) {
          p.fallTimer = 0;
          p.animState = 'idle';
        }
        if (!p.onGround) {
          p.vy += gravity * dt;
          p.y += p.vy * dt;
          if (p.y >= GROUND_Y - PLAYER_H / 2) {
            p.y = GROUND_Y - PLAYER_H / 2;
            p.vy = 0;
            p.onGround = true;
          }
        }
        continue;
      }

      if (!p.onGround) {
        p.vy += gravity * dt;
      }

      if (p.input.left) {
        p.vx = -PLAYER_SPEED;
      } else if (p.input.right) {
        p.vx = PLAYER_SPEED;
      } else {
        p.vx = 0;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Each player is clamped to their own zone (full half in 1v1, front or
      // back sub-zone in 2v2). Zones already bake in the wall/net margins.
      p.x = Math.max(p.xMin, Math.min(p.xMax, p.x));

      const groundLevel = GROUND_Y - PLAYER_H / 2;
      if (p.y >= groundLevel) {
        p.y = groundLevel;
        p.vy = 0;
        p.onGround = true;
      }

      if (p.animState !== 'hitting' && p.animState !== 'spiking') {
        if (!p.onGround) {
          p.animState = 'jumping';
        } else if (p.vx !== 0) {
          p.animState = 'running';
        } else {
          p.animState = 'idle';
        }
      }

      if (p.hitTimer > 0) {
        p.hitTimer -= dt;
        if (p.hitTimer <= 0) {
          p.hitTimer = 0;
          p.animState = 'idle';
        }
      }

      if (p.hitCooldown > 0) {
        p.hitCooldown -= dt;
        if (p.hitCooldown < 0) p.hitCooldown = 0;
      }
    }
  }
}

function updateBall(dt, vbState) {
  const { ball } = vbState;

  ball.vy += GRAVITY_BASE * dt;

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  if (ball.x - BALL_R <= LEFT_WALL) {
    ball.x = LEFT_WALL + BALL_R;
    ball.vx *= -0.85;
  }
  if (ball.x + BALL_R >= RIGHT_WALL) {
    ball.x = RIGHT_WALL - BALL_R;
    ball.vx *= -0.85;
  }

  if (ball.y - BALL_R <= 0) {
    ball.y = BALL_R;
    ball.vy *= -0.7;
  }

  const netLeft = NET_X - NET_W / 2;
  const netRight = NET_X + NET_W / 2;
  if (ball.x + BALL_R > netLeft && ball.x - BALL_R < netRight && ball.y + BALL_R > NET_TOP) {
    if (ball.vx > 0) {
      ball.x = netLeft - BALL_R;
    } else {
      ball.x = netRight + BALL_R;
    }
    ball.vx *= -0.85;
    ball.vy *= 0.8;
  }
}

function checkHits(vbState) {
  const { ball, players, time } = vbState;

  for (const side of ['left', 'right']) {
    for (const p of players[side]) {
      if (p.fallTimer > 0) continue;
      if (p.hitCooldown > 0) continue;
      if (p.hitPressedAt === null || p.hitPressedAt === undefined) continue;

      const timeSincePress = time - p.hitPressedAt;
      if (timeSincePress > HIT_WINDOW) {
        p.hitPressedAt = null;
        continue;
      }

      const dx = ball.x - p.x;
      const dy = ball.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= HIT_RADIUS) {
        const isSpike = p.y < GROUND_Y - PLAYER_H - 50;
        const dirMult = side === 'left' ? 1 : -1;

        if (isSpike) {
          ball.vx = dirMult * 750 + p.vx * 0.25;
          ball.vy = 320;
          p.animState = 'spiking';
        } else {
          ball.vx = dirMult * 680 + p.vx * 0.4;
          ball.vy = -620;
          p.animState = 'hitting';
        }

        p.hitCooldown = HIT_COOLDOWN;
        p.hitPressedAt = null;
        p.hitTimer = 0.25;
        if (vbState.phase === 'serving') vbState.phase = 'rally';
        SFX.slap();
        // Queue feedback to send to controller
        if (!vbState._hitFeedbacks) vbState._hitFeedbacks = [];
        vbState._hitFeedbacks.push(p.deviceId);
      }
    }
  }
}

// Passive body collision — ball bumps off player even without pressing HIT.
// Only fires when player hasn't just done an intentional hit (hitCooldown === 0).
function checkBodyCollision(vbState) {
  const { ball, players } = vbState;
  const BODY_R = PLAYER_W * 0.35; // player collision radius
  const MIN_DIST = BALL_R + BODY_R;

  for (const side of ['left', 'right']) {
    for (const p of players[side]) {
      if (p.fallTimer > 0 || p.hitCooldown > 0) continue;

      const dx = ball.x - p.x;
      const dy = ball.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < MIN_DIST && dist > 0) {
        // Push ball outside player body
        const nx = dx / dist;
        const ny = dy / dist;
        ball.x = p.x + nx * (MIN_DIST + 1);
        ball.y = p.y + ny * (MIN_DIST + 1);

        // Deflect toward opponent side with upward arc
        const dirMult = side === 'left' ? 1 : -1;
        const incoming = Math.max(Math.hypot(ball.vx, ball.vy), 200);
        ball.vx = dirMult * incoming * 0.5;
        ball.vy = -incoming * 0.55;

        p.hitCooldown = HIT_COOLDOWN * 0.6;
        p.animState = 'hitting';
        // Must set hitTimer too: updatePlayers only clears the 'hitting' state
        // when hitTimer counts down to 0. Without it the player sticks in the
        // arms-up pose forever after a passive bump and stops animating.
        p.hitTimer = 0.25;
        if (vbState.phase === 'serving') vbState.phase = 'rally';
        SFX.slap();
      }
    }
  }
}

function checkScoring(vbState) {
  const { ball } = vbState;

  if (ball.y + BALL_R >= GROUND_Y) {
    if (ball.x < NET_X) {
      return { scorer: 'right' };
    } else {
      return { scorer: 'left' };
    }
  }

  if (ball.x < LEFT_WALL - BALL_R) {
    return { scorer: 'right' };
  }
  if (ball.x > RIGHT_WALL + BALL_R) {
    return { scorer: 'left' };
  }

  return null;
}
