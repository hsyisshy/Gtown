import Matter from 'matter-js';
import {
  WORLD_W,
  WORLD_H,
  PLATFORM,
  GAME_RULES,
} from './config.js';
import { bgm, SFX } from './audio.js';
import { STACKING_OBJECTS } from './stacking-objects.generated.js';
import {
  HELD_PIECE_SCREEN_Y,
  cameraTargetForTower,
  easeCameraOffset,
  worldYForFixedScreenY,
} from './camera.js';
import {
  beginRolledTurn,
  completePlacement,
  createTurnState,
  rollPlacementCount,
  spendShapeChange,
} from './turn-rules.js';
import { renderFurnitureStack } from './renderer.js';
import {
  addPieceToWorld,
  createRigidPiece,
  movePieceTo,
  pieceAngle,
  pieceBounds,
  pieceIsSleeping,
  pieceMeta,
  piecePosition,
  removePieceFromWorld,
  registerRigidCollisionEvents,
  rotatePiece,
  setPieceAngularVelocity,
  setPieceStatic,
  setPieceVelocity,
  updateRigidPieceSettling,
  wakePiece,
} from './rigid-body.js';

const {
  Engine,
  World,
  Bodies,
  Body,
  Composite,
  Sleeping,
} = Matter;

const CONTINUOUS_ROTATION_SPEED = Math.PI * 0.8;
const FIXED_PHYSICS_STEP_SECONDS = 1 / 60;
const MAX_PHYSICS_STEPS_PER_UPDATE = 5;
const SPINNER_TARGET_ANGLES = {
  1: Math.PI / 3,
  2: -Math.PI / 3,
  3: -Math.PI,
};

let game = null;

function truncateName(name, maxChars = 10) {
  return name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name;
}

function shuffled(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function applyTurnState(nextState) {
  game.turnState = nextState;
  game.currentTeam = nextState.currentTeam;
  game.placementsRequired = nextState.placementsRequired;
  game.placementsRemaining = nextState.placementsRemaining;
  game.shapeChangesRemaining = { ...nextState.shapeChangesRemaining };
}

function ensureShapeQueue(minimum = 2) {
  while (game.shapeQueue.length < minimum) {
    game.shapeQueue.push(...shuffled(game.shapeSet));
  }
  game.nextShape = game.shapeQueue[0] ?? game.shapeSet[0];
}

function takeNextShape() {
  ensureShapeQueue(2);
  const shape = game.shapeQueue.shift() ?? game.shapeSet[0];
  ensureShapeQueue(2);
  return shape;
}

function createEngine() {
  const engine = Engine.create({ enableSleeping: true });
  engine.gravity.x = 0;
  engine.gravity.y = GAME_RULES.gravityY;
  engine.gravity.scale = 0.001;
  engine.positionIterations = 10;
  engine.velocityIterations = 8;
  engine.constraintIterations = 8;
  registerRigidCollisionEvents(Matter, engine);
  return engine;
}

function createPlatform() {
  const platform = Bodies.rectangle(
    PLATFORM.x,
    PLATFORM.y,
    PLATFORM.width,
    PLATFORM.height,
    {
      isStatic: true,
      friction: 1,
      frictionStatic: 1,
      restitution: 0,
      label: 'furniture-stack-platform',
      chamfer: { radius: 12 },
    },
  );
  platform.plugin.stackMeta = { platform: true };
  return platform;
}

function createPiece(shape, team, x = WORLD_W / 2) {
  return createRigidPiece(Matter, {
    shape,
    team,
    x,
    y: worldYForFixedScreenY(HELD_PIECE_SCREEN_Y, game.cameraOffsetY),
    placementNumber: game.successfulPlacements + 1,
  });
}

function startDiceRoll() {
  if (!game) return;
  game.currentBody = null;
  game.moveAxis = 0;
  game.rotationAxis = 0;
  game.turnTime = GAME_RULES.turnSeconds;
  game.diceTimer = GAME_RULES.diceRollSeconds;
  game.diceTick = 0;
  game.diceValue = rollPlacementCount();
  game.diceDisplay = 1;
  game.diceSpinAngle = 0;
  game.phase = 'rolling';
}

function startRound() {
  if (!game) return;

  if (game.engine) {
    Composite.clear(game.engine.world, false, true);
    Engine.clear(game.engine);
  }

  game.engine = createEngine();
  game.physicsAccumulator = 0;
  game.platformBody = createPlatform();
  World.add(game.engine.world, game.platformBody);
  game.shapeQueue = [];
  ensureShapeQueue(2);
  game.pieces = [];
  game.currentBody = null;
  game.successfulPlacements = 0;
  game.cameraOffsetY = 0;
  game.cameraTargetOffsetY = 0;
  game.turnState = createTurnState(
    game.roundNumber % 2 === 1 ? 'red' : 'blue',
    GAME_RULES.shapeChangesPerTeam,
  );
  applyTurnState(game.turnState);
  game.roundWinner = null;
  game.roundReason = '';
  game.losingBody = null;
  game.roundPause = 0;
  game.towerTop = PLATFORM.y - PLATFORM.height / 2;
  startDiceRoll();
}

function spawnHeldPiece({ x = WORLD_W / 2, preserveTurnTime = false } = {}) {
  if (!game) return;
  const turnTime = game.turnTime;
  const shape = takeNextShape();
  game.currentBody = createPiece(shape, game.currentTeam, x);
  game.moveAxis = 0;
  game.rotationAxis = 0;
  game.turnTime = preserveTurnTime ? turnTime : GAME_RULES.turnSeconds;
  game.phase = 'aiming';
  addPieceToWorld(Matter, game.engine.world, game.currentBody);
}

function updateDiceRoll(dt) {
  game.diceTimer -= dt;
  game.diceTick += dt;
  const spinProgress = Math.min(
    1,
    Math.max(0, 1 - game.diceTimer / GAME_RULES.diceRollSeconds),
  );
  const easedSpin = 1 - (1 - spinProgress) ** 3;
  const targetAngle = SPINNER_TARGET_ANGLES[game.diceValue] ?? 0;
  game.diceSpinAngle = easedSpin * (Math.PI * 10 + targetAngle);
  game.diceDisplay = game.diceTimer <= 0.35
    ? game.diceValue
    : 1 + Math.floor(game.diceTick * 12) % 3;

  if (game.diceTimer > 0) return;
  applyTurnState(beginRolledTurn(game.turnState, game.diceValue));
  spawnHeldPiece();
}

function dropCurrentPiece() {
  if (!game || game.phase !== 'aiming' || !game.currentBody) return;
  setPieceStatic(Matter, game.currentBody, false);
  setPieceVelocity(Matter, game.currentBody, { x: 0, y: 0 });
  setPieceAngularVelocity(Matter, game.currentBody, 0);
  wakePiece(Matter, game.currentBody);
  game.pieces.push(game.currentBody);
  game.phase = 'settling';
  game.moveAxis = 0;
  game.rotationAxis = 0;
  SFX.crack();
}

function rerollCurrentShape() {
  if (!game || game.phase !== 'aiming' || !game.currentBody) return;
  const result = spendShapeChange(game.turnState, game.currentTeam);
  if (!result.accepted) return;
  SFX.changeItem();

  const x = piecePosition(game.currentBody).x;
  const turnTime = game.turnTime;
  removePieceFromWorld(Matter, game.engine.world, game.currentBody);
  game.currentBody = null;
  applyTurnState(result.state);
  spawnHeldPiece({ x, preserveTurnTime: true });
  game.turnTime = turnTime;
}

function moveHeldPiece(dt) {
  if (!game?.currentBody || game.phase !== 'aiming') return;

  if (game.rotationAxis !== 0) {
    rotatePiece(Matter, game.currentBody, game.rotationAxis * CONTINUOUS_ROTATION_SPEED * dt);
  }

  const bounds = pieceBounds(game.currentBody);
  const position = piecePosition(game.currentBody);
  const halfWidth = (bounds.max.x - bounds.min.x) / 2;
  const left = PLATFORM.x - PLATFORM.width / 2 - 300 + halfWidth;
  const right = PLATFORM.x + PLATFORM.width / 2 + 300 - halfWidth;
  const x = Math.max(
    left,
    Math.min(right, position.x + game.moveAxis * GAME_RULES.moveSpeed * dt),
  );
  movePieceTo(Matter, game.currentBody, {
    x,
    y: worldYForFixedScreenY(HELD_PIECE_SCREEN_Y, game.cameraOffsetY),
  });
  setPieceVelocity(Matter, game.currentBody, { x: 0, y: 0 });
  setPieceAngularVelocity(Matter, game.currentBody, 0);
}

function bodyFellOut(body) {
  const position = piecePosition(body);
  return position.y > GAME_RULES.failY
    || position.x < -GAME_RULES.failXMargin
    || position.x > WORLD_W + GAME_RULES.failXMargin;
}

function allPiecesStopped() {
  if (!game?.pieces.length) return false;
  return game.pieces.every(pieceIsSleeping);
}

function updateTowerTop() {
  if (!game) return;
  const bodies = game.pieces.filter(body => !bodyFellOut(body));
  game.towerTop = bodies.length
    ? Math.min(...bodies.map(body => pieceBounds(body).min.y))
    : PLATFORM.y - PLATFORM.height / 2;
}

function updateCameraTarget() {
  game.cameraTargetOffsetY = cameraTargetForTower(
    game.cameraTargetOffsetY,
    game.towerTop,
  );
}

function updateCamera(dt) {
  game.cameraOffsetY = easeCameraOffset(
    game.cameraOffsetY,
    game.cameraTargetOffsetY,
    dt,
  );
}

function settleSucceeded() {
  if (!game) return;
  game.successfulPlacements += 1;
  game.currentBody = null;
  updateTowerTop();
  updateCameraTarget();

  if (game.successfulPlacements >= GAME_RULES.maxPlacements) {
    finishRound(game.currentTeam, `成功堆滿 ${GAME_RULES.maxPlacements} 件物件`);
    return;
  }

  const result = completePlacement(game.turnState);
  applyTurnState(result.state);
  if (result.handoff) startDiceRoll();
  else spawnHeldPiece();
}

function queueFeedback(deviceId) {
  if (!game?._globalState || !deviceId) return;
  game._globalState._pendingMessages = game._globalState._pendingMessages ?? [];
  game._globalState._pendingMessages.push({
    type: 'hit_confirm',
    deviceId: String(deviceId),
  });
}

function finishRound(winner, reason) {
  if (!game || game.phase === 'round-over' || game.phase === 'match-over') return;
  const loser = winner === 'red' ? 'blue' : 'red';
  game.scores[winner] += 1;
  game.roundWinner = winner;
  game.roundReason = reason;
  game.roundPause = GAME_RULES.roundPauseSeconds;
  game.phase = 'round-over';
  game.moveAxis = 0;
  game.rotationAxis = 0;
  game.currentBody = null;
  queueFeedback(game.playerIds[loser]);
}

function finishMatch() {
  if (!game || game.endSent) return;
  game.endSent = true;
  const winner = game.matchWinner;
  const winnerId = game.playerIds[winner];
  if (winnerId && game._globalState.players?.[winnerId]) {
    game._globalState.players[winnerId].score =
      (game._globalState.players[winnerId].score || 0) + game.scores[winner];
  }
  game._endCb?.(winner);
}

function updateRoundTransition(dt) {
  game.roundPause -= dt;
  if (game.roundPause > 0) return;

  if (game.scores[game.roundWinner] >= GAME_RULES.roundsToWin) {
    game.matchWinner = game.roundWinner;
    game.phase = 'match-over';
    game.roundPause = GAME_RULES.matchPauseSeconds;
    return;
  }

  game.roundNumber += 1;
  startRound();
}

function updateMatchTransition(dt) {
  game.roundPause -= dt;
  if (game.roundPause <= 0) finishMatch();
}

function advancePhysics(dt, updateSettling = false) {
  const maximumAccumulatedTime = FIXED_PHYSICS_STEP_SECONDS * MAX_PHYSICS_STEPS_PER_UPDATE;
  game.physicsAccumulator = Math.min(
    maximumAccumulatedTime,
    game.physicsAccumulator + Math.max(0, dt),
  );

  let stepCount = 0;
  while (
    game.physicsAccumulator + Number.EPSILON >= FIXED_PHYSICS_STEP_SECONDS
    && stepCount < MAX_PHYSICS_STEPS_PER_UPDATE
  ) {
    Engine.update(game.engine, FIXED_PHYSICS_STEP_SECONDS * 1000);
    if (updateSettling) {
      const supportBodies = Matter.Composite.allBodies(game.engine.world);
      for (const piece of game.pieces) {
        updateRigidPieceSettling(Matter, piece, FIXED_PHYSICS_STEP_SECONDS, supportBodies);
      }
    }
    game.physicsAccumulator -= FIXED_PHYSICS_STEP_SECONDS;
    stepCount += 1;
  }
}

function updatePhysics(dt) {
  advancePhysics(dt, true);

  const fallen = game.pieces.find(bodyFellOut);
  if (fallen) {
    game.losingBody = fallen;
    const winner = game.currentTeam === 'red' ? 'blue' : 'red';
    finishRound(winner, `${game.playerNames[game.currentTeam]}讓物件掉出平台`);
    return;
  }

  if (allPiecesStopped()) settleSucceeded();
}

function activePlayerIds(globalState) {
  const playing = Object.entries(globalState.activePlayers ?? {})
    .filter(([, role]) => role === 'playing')
    .map(([id]) => String(id));
  return playing.length ? playing : Object.keys(globalState.players ?? {}).map(String);
}

function playerName(globalState, deviceId, fallback) {
  return truncateName(globalState.players?.[deviceId]?.name ?? fallback);
}

export default {
  id: 'furniture-stack',
  name: '家具高塔',
  description: '旋轉不規則家具設局，別讓整座塔倒下',
  playersPerTeam: 1,
  color: '#ff8d5c',
  emoji: '🎯',
  cover: '05_furniture-stack/theme/furniture_cover.png',

  tutorial: {
    pages: [
      '05_furniture-stack/tutorial/1.png',
      '05_furniture-stack/tutorial/2.png',
      '05_furniture-stack/tutorial/3.png',
    ],
  },

  onStart(globalState, endCb) {
    const playing = activePlayerIds(globalState);
    const teams = globalState.teams ?? {};
    const redId = playing.find(id => teams[id] === 'red') ?? playing[0] ?? 'demo-red';
    const blueId = playing.find(id => teams[id] === 'blue' && id !== redId)
      ?? playing.find(id => id !== redId)
      ?? 'demo-blue';

    game = {
      engine: null,
      shapeSet: STACKING_OBJECTS,
      platformBody: null,
      pieces: [],
      currentBody: null,
      shapeQueue: [],
      nextShape: null,
      currentTeam: 'red',
      moveAxis: 0,
      rotationAxis: 0,
      turnTime: GAME_RULES.turnSeconds,
      turnState: null,
      placementsRequired: 0,
      placementsRemaining: 0,
      shapeChangesRemaining: { red: 0, blue: 0 },
      diceTimer: 0,
      diceTick: 0,
      diceValue: 1,
      diceDisplay: 1,
      diceSpinAngle: 0,
      successfulPlacements: 0,
      towerTop: PLATFORM.y,
      cameraOffsetY: 0,
      cameraTargetOffsetY: 0,
      phase: 'rolling',
      time: 0,
      roundNumber: 1,
      roundWinner: null,
      roundReason: '',
      losingBody: null,
      roundPause: 0,
      matchWinner: null,
      scores: { red: 0, blue: 0 },
      playerIds: { red: String(redId), blue: String(blueId) },
      playerNames: {
        red: playerName(globalState, redId, '紅隊玩家'),
        blue: playerName(globalState, blueId, '藍隊玩家'),
      },
      teamByDevice: {
        [String(redId)]: 'red',
        [String(blueId)]: 'blue',
      },
      _endCb: endCb,
      _globalState: globalState,
      endSent: false,
      physicsAccumulator: 0,
    };

    startRound();
    bgm.start();
  },

  update(dt) {
    if (!game || game.endSent) return;
    game.time += dt;
    updateCamera(dt);

    if (game.phase === 'rolling') {
      updateDiceRoll(dt);
    } else if (game.phase === 'aiming') {
      moveHeldPiece(dt);
      game.turnTime -= dt;
      if (game.turnTime <= 0) dropCurrentPiece();
    } else if (game.phase === 'settling') {
      updatePhysics(dt);
    } else if (game.phase === 'round-over') {
      advancePhysics(dt);
      updateRoundTransition(dt);
    } else if (game.phase === 'match-over') {
      advancePhysics(dt);
      updateMatchTransition(dt);
    }

    updateTowerTop();
  },

  draw(ctx, width, height) {
    if (!game) return;
    renderFurnitureStack(ctx, width, height, game);
  },

  onInput(deviceId, data) {
    if (!game || game.endSent) return;
    const team = game.teamByDevice[String(deviceId)];
    if (team !== game.currentTeam) return;

    if (data.action === 'move' && game.phase === 'aiming') {
      game.moveAxis = Math.max(-1, Math.min(1, data.dx ?? 0));
      return;
    }
    if (data.action === 'rotate' && game.phase === 'aiming') {
      game.rotationAxis = Math.max(-1, Math.min(1, data.direction ?? 0));
      return;
    }
    if (data.action === 'reroll' && game.phase === 'aiming') {
      rerollCurrentShape();
      return;
    }
    if ((data.action === 'b' || data.action === 'drop') && game.phase === 'aiming') {
      dropCurrentPiece();
    }
  },

  onEnd() {
    bgm.stop();
    if (game?.engine) {
      Composite.clear(game.engine.world, false, true);
      Engine.clear(game.engine);
    }
    game = null;
  },
};

export function getFurnitureStackDebugState() {
  if (!game) return null;
  return {
    phase: game.phase,
    currentTeam: game.currentTeam,
    scores: { ...game.scores },
    roundNumber: game.roundNumber,
    turnTime: game.turnTime,
    successfulPlacements: game.successfulPlacements,
    currentShape: pieceMeta(game.currentBody)?.shape?.id ?? null,
    currentX: game.currentBody ? piecePosition(game.currentBody).x : null,
    currentAngleDegrees: game.currentBody ? pieceAngle(game.currentBody) * 180 / Math.PI : null,
    nextShape: game.nextShape?.id ?? null,
    diceValue: game.diceValue,
    diceDisplay: game.diceDisplay,
    diceSpinAngle: game.diceSpinAngle,
    placementsRequired: game.placementsRequired,
    placementsRemaining: game.placementsRemaining,
    shapeChangesRemaining: { ...game.shapeChangesRemaining },
    currentPieceIsRigidWhole: pieceMeta(game.currentBody)?.rigidWhole ?? null,
    currentPieceColliderCount: game.currentBody
      ? Math.max(1, (game.currentBody.parts?.length ?? 1) - 1)
      : 0,
    maximumPhysicsPointSpeed: Math.max(
      0,
      ...game.pieces.map((piece) => piece.speed ?? 0),
    ),
    movingPieceCount: game.pieces.filter((body) => !pieceIsSleeping(body)).length,
    towerTop: game.towerTop,
    cameraOffsetY: game.cameraOffsetY,
    cameraTargetOffsetY: game.cameraTargetOffsetY,
    roundWinner: game.roundWinner,
    matchWinner: game.matchWinner,
    reason: game.roundReason,
  };
}

export function setFurnitureStackDebugPhase(phase) {
  if (!game || (phase !== 'round-over' && phase !== 'match-over')) return false;
  const winner = game.currentTeam === 'red' ? 'blue' : 'red';
  game.roundWinner = winner;
  game.roundReason = `${game.playerNames[game.currentTeam]}讓物件掉出平台`;
  game.currentBody = null;
  game.moveAxis = 0;
  game.rotationAxis = 0;

  if (phase === 'match-over') {
    game.scores[winner] = GAME_RULES.roundsToWin;
    game.matchWinner = winner;
    game.phase = 'match-over';
    game.roundPause = GAME_RULES.matchPauseSeconds;
    return true;
  }

  game.phase = 'round-over';
  game.roundPause = GAME_RULES.roundPauseSeconds;
  return true;
}

export function setFurnitureStackDebugCameraOffset(offsetY = 300) {
  if (!game) return false;
  const safeOffsetY = Math.max(0, Number(offsetY) || 0);
  game.cameraOffsetY = safeOffsetY;
  game.cameraTargetOffsetY = safeOffsetY;
  return true;
}
