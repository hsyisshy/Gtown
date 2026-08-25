import {
  NET_X, NET_W, GROUND_Y, PLAYER_H, PLAYER_W, BALL_R, WIN_SCORE, POINT_PAUSE,
  JUMP_VELOCITY, LEFT_WALL, RIGHT_WALL,
} from './constants.js';
import { updatePhysics } from './physics.js';
import { render } from './renderer.js';
import { truncateName } from '../../shared/nameDisplay.js';
import { bgm, SFX } from './audio.js';

let vbState = null;

// Split a side's playable x-range into a back zone (near the wall) and a
// front zone (near the net) so the two teammates never overlap — the
// "前後分區" court model. Returned back-first so slot 0 is always the back
// player.
function playerZones(side) {
  const halfW = PLAYER_W / 2;
  const [lo, hi] = side === 'left'
    ? [LEFT_WALL + halfW, NET_X - NET_W / 2 - halfW]      // wall … net
    : [NET_X + NET_W / 2 + halfW, RIGHT_WALL - halfW];    // net … wall
  const mid = (lo + hi) / 2;
  return side === 'left'
    ? [{ xMin: lo, xMax: mid }, { xMin: mid, xMax: hi }]  // back(wall), front(net)
    : [{ xMin: mid, xMax: hi }, { xMin: lo, xMax: mid }]; // back(wall), front(net)
}

function initPlayer(side, deviceId, teamColor, name, zone, slot) {
  return {
    side,
    slot,                       // 0 = back, 1 = front (desyncs anim, picks server)
    deviceId,
    teamColor,
    name,
    x: (zone.xMin + zone.xMax) / 2,
    y: GROUND_Y - PLAYER_H / 2,
    xMin: zone.xMin,
    xMax: zone.xMax,
    vx: 0,
    vy: 0,
    onGround: true,
    animState: 'idle',
    input: { left: false, right: false },
    hitPressedAt: null,
    hitCooldown: 0,
    hitTimer: 0,
    fallTimer: 0,
  };
}

// Build a side's player array (always 2, back + front) with zone assignments.
function initSide(side, ids, teamColor, globalState) {
  const zones = playerZones(side);
  return ids.map((id, i) => initPlayer(side, id, teamColor, _name(globalState, id), zones[i], i));
}

// Everyone on the court, both sides — handy for input routing / lookups.
function everyPlayer() {
  return [...vbState.players.left, ...vbState.players.right];
}

// The designated server on a side = the back player (slot 0).
function server(side) {
  return vbState.players[side][0] ?? null;
}

function spawnBall(serving) {
  const s = server(serving);
  vbState.ball = {
    x: s ? s.x : (serving === 'left' ? NET_X * 0.4 : NET_X * 1.6),
    y: s ? s.y - 620 : GROUND_Y - 650,
    vx: 0,
    vy: 0,
  };
}

export default {
  id: 'volleyball',
  name: '熱血排球',
  description: '2v2 排球對戰，合力把球打進對方場地！',
  playersPerTeam: 2,
  requireFullTeams: true,
  color: '#ffe066',
  emoji: '🏐',
  cover: '02_volleyball/volleyball_cover.png',

  tutorial: {
    pages: [
      '02_volleyball/tutorial/1.png',
      '02_volleyball/tutorial/2.png',
    ],
  },

  onStart(globalState, endCb) {
    // Red plays the left side, blue the right — requireFullTeams guarantees
    // exactly 2 real players per side by the time this runs.
    const active  = globalState.activePlayers || {};
    const teams   = globalState.teams || {};
    const playing = Object.entries(active)
      .filter(([, role]) => role === 'playing')
      .map(([id]) => id);

    const redIds  = playing.filter(id => teams[id] === 'red');
    const blueIds = playing.filter(id => teams[id] === 'blue');

    vbState = {
      players: {
        left:  initSide('left',  redIds,  '#ff6b6b', globalState),
        right: initSide('right', blueIds, '#4ecdc4', globalState),
      },
      ball: { x: NET_X, y: 200, vx: 0, vy: 0 },
      scores: { left: 0, right: 0 },
      serving: 'left',
      phase: 'serving',
      pointPauseTimer: 0,
      lastScorer: null,
      winner: null,
      time: 0,
      _endCb: endCb,
      _globalState: globalState,
    };

    spawnBall('left');
    bgm.start();
  },

  update(dt, globalState) {
    if (!vbState) return;

    // Drain hit feedbacks so screen can forward to controllers
    if (vbState._hitFeedbacks?.length) {
      if (!globalState._pendingMessages) globalState._pendingMessages = [];
      for (const did of vbState._hitFeedbacks)
        globalState._pendingMessages.push({ type: 'hit_confirm', deviceId: did });
      vbState._hitFeedbacks = [];
    }

    vbState.time += dt;

    if (vbState.phase === 'point') {
      vbState.pointPauseTimer -= dt;
      if (vbState.pointPauseTimer <= 0) {
        if (vbState.winner) {
          if (globalState.players) {
            for (const [deviceId, playerData] of Object.entries(globalState.players)) {
              const side = vbState.players.left.some(p => p.deviceId === deviceId)  ? 'left'  :
                           vbState.players.right.some(p => p.deviceId === deviceId) ? 'right' : null;
              if (side) {
                playerData.score = (playerData.score || 0) + vbState.scores[side];
              }
            }
          }
          const winnerId = server(vbState.winner)?.deviceId;
          const winnerTeam = winnerId ? (vbState._globalState?.teams?.[winnerId] ?? null) : null;
          // players.left was built from the red roster, players.right from blue.
          vbState._endCb?.(winnerTeam, {
            label: '局分',
            red: String(vbState.scores.left),
            blue: String(vbState.scores.right),
          });
        } else {
          spawnBall(vbState.serving);
          vbState.phase = 'serving';
        }
      }
      return;
    }

    if (vbState.phase === 'serving') {
      updatePhysics(dt, vbState);
      // Ball hit the ground — server missed, opponent scores
      if (vbState.phase === 'serving' && vbState.ball.y + BALL_R >= GROUND_Y) {
        const opponent = vbState.serving === 'left' ? 'right' : 'left';
        vbState.scores[opponent] += 1;
        vbState.lastScorer = opponent;
        vbState.serving = opponent;
        vbState.phase = 'point';
        vbState.pointPauseTimer = vbState.scores[opponent] >= WIN_SCORE
          ? (vbState.winner = opponent, 3.0)
          : POINT_PAUSE;
        SFX.whistle();
      }
      return;
    }

    if (vbState.phase === 'rally') {
      const scoreResult = updatePhysics(dt, vbState);

      if (scoreResult) {
        const scorer = scoreResult.scorer;
        vbState.scores[scorer] += 1;
        vbState.lastScorer = scorer;
        vbState.serving = scorer;

        if (vbState.scores[scorer] >= WIN_SCORE) {
          vbState.winner = scorer;
          vbState.phase = 'point';
          vbState.pointPauseTimer = 3.0;
        } else {
          vbState.phase = 'point';
          vbState.pointPauseTimer = POINT_PAUSE;
        }
        SFX.whistle();
      }
    }
  },

  draw(ctx, w, h, globalState) {
    if (!vbState) return;
    render(ctx, w, h, vbState);
  },

  onInput(deviceId, data, globalState) {
    if (!vbState) return;

    const did = String(deviceId);
    const player = everyPlayer().find(p => p.deviceId === did);
    if (!player) return;

    switch (data.action) {
      case 'move':
        player.input.left  = (data.dx ?? 0) < -0.2;
        player.input.right = (data.dx ?? 0) > 0.2;
        break;
      case 'a':
        if (player.onGround) {
          player.vy = JUMP_VELOCITY;
          player.onGround = false;
          player.animState = 'jumping';
          SFX.jump();
        }
        break;
      case 'b':
        player.hitPressedAt = vbState.time;
        break;
    }
  },

  onEnd() {
    bgm.stop();
    vbState = null;
  },
};

function _name(globalState, deviceId) {
  return truncateName(globalState.players?.[deviceId]?.name ?? `Player ${deviceId}`);
}
