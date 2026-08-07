const RIGID_IMPACT_GUARD_SECONDS = 0.3;
const MAX_UPWARD_REBOUND_SPEED = 0.25;
const MAX_ANGULAR_REBOUND_SPEED = 0.03;
const SUPPORT_LOSS_WAKE_SECONDS = 0.08;
const MIN_SUPPORT_NORMAL_Y = 0.25;

const BODY_OPTIONS = {
  density: 0.0008,
  friction: 0.88,
  frictionStatic: 1,
  frictionAir: 0.012,
  restitution: 0,
  sleepThreshold: 42,
};

export function createRigidPiece(Matter, {
  shape,
  team,
  x,
  y,
  placementNumber,
}) {
  const { Bodies, Body } = Matter;
  const colliderDefinitions = shape.colliders?.length
    ? shape.colliders
    : [[0, 0, 1, 1]];
  const parts = colliderDefinitions.map(([centerX, centerY, width, height], index) => (
    Bodies.rectangle(
      x + centerX * shape.width,
      y + centerY * shape.height,
      Math.max(2, width * shape.width),
      Math.max(2, height * shape.height),
      {
        ...BODY_OPTIONS,
        label: `furniture-stack-${shape.id}-collider-${index}`,
      },
    )
  ));
  const body = Body.create({
    parts,
    ...BODY_OPTIONS,
    label: `furniture-stack-${shape.id}`,
  });

  // Matter.js only sums each compound part's local inertia. Include the
  // distance from the shared centre so tall furniture does not spin too easily.
  const compoundInertia = parts.reduce((total, part) => {
    const offsetX = part.position.x - body.position.x;
    const offsetY = part.position.y - body.position.y;
    return total + part.inertia + part.mass * (offsetX ** 2 + offsetY ** 2);
  }, 0);
  Body.setInertia(body, compoundInertia);
  const centerOffset = {
    x: body.position.x - x,
    y: body.position.y - y,
  };
  Body.setPosition(body, { x, y });
  Body.setStatic(body, true);
  body.plugin.stackMeta = {
    shape,
    team,
    placementNumber,
    rigidWhole: true,
    rigidHasCollided: false,
    rigidActiveContactIds: new Set(),
    rigidImpactAge: 0,
    rigidSettleTime: 0,
    rigidSupportLossTime: 0,
    renderOffset: {
      x: -centerOffset.x,
      y: -centerOffset.y,
    },
  };
  return body;
}

export function registerRigidCollisionEvents(Matter, engine) {
  Matter.Events.on(engine, 'collisionStart', (event) => {
    for (const pair of event.pairs) {
      noteImpact(pair.bodyA, pair.bodyB, pair);
      noteImpact(pair.bodyB, pair.bodyA, pair);
    }
  });
  Matter.Events.on(engine, 'collisionEnd', (event) => {
    for (const pair of event.pairs) {
      endContact(pair.bodyA, pair);
      endContact(pair.bodyB, pair);
    }
  });
}

function endContact(sourceBody, pair) {
  const body = sourceBody.parent ?? sourceBody;
  body.plugin?.stackMeta?.rigidActiveContactIds?.delete(pair.id);
}

function noteImpact(sourceBody, otherBody, pair) {
  const body = sourceBody.parent ?? sourceBody;
  const other = otherBody.parent ?? otherBody;
  const meta = body.plugin?.stackMeta;
  if (!meta?.shape || body.isStatic) return;
  meta.rigidActiveContactIds.add(pair.id);

  const relativeX = body.velocity.x - (other.velocity?.x ?? 0);
  const relativeY = body.velocity.y - (other.velocity?.y ?? 0);
  const relativeSpeed = Math.hypot(relativeX, relativeY);
  const spin = Math.abs(body.angularVelocity) * 6;
  const significantImpact = relativeSpeed + spin > 0.5;
  const otherPlacement = other.plugin?.stackMeta?.placementNumber ?? -1;
  const struckByNewerPiece = otherPlacement > meta.placementNumber && significantImpact;
  if (!meta.rigidHasCollided || struckByNewerPiece) {
    meta.rigidImpactAge = 0;
    meta.rigidSettleTime = 0;
  }
  meta.rigidHasCollided = true;
}

function hasSupportBelow(Matter, piece, supportBodies) {
  const candidates = supportBodies.filter((candidate) => (
    (candidate.parent ?? candidate) !== piece && !candidate.isSensor
  ));
  return Matter.Query.collides(piece, candidates).some((collision) => {
    const rootA = collision.bodyA.parent ?? collision.bodyA;
    const rootB = collision.bodyB.parent ?? collision.bodyB;
    const supportDirectionY = rootB === piece
      ? collision.normal.y
      : rootA === piece
        ? -collision.normal.y
        : 0;
    return supportDirectionY >= MIN_SUPPORT_NORMAL_Y;
  });
}

export function updateRigidPieceSettling(Matter, piece, dt, supportBodies = null) {
  const meta = piece?.plugin?.stackMeta;
  if (!meta?.rigidHasCollided || piece.isStatic) return;
  if (piece.isSleeping) {
    if (!supportBodies) return;
    if (hasSupportBelow(Matter, piece, supportBodies)) {
      meta.rigidSupportLossTime = 0;
      return;
    }
    meta.rigidSupportLossTime += dt;
    if (meta.rigidSupportLossTime >= SUPPORT_LOSS_WAKE_SECONDS) {
      meta.rigidSupportLossTime = 0;
      meta.rigidSettleTime = 0;
      Matter.Sleeping.set(piece, false);
    }
    return;
  }

  meta.rigidSupportLossTime = 0;
  meta.rigidImpactAge += dt;
  if (meta.rigidImpactAge <= RIGID_IMPACT_GUARD_SECONDS) {
    if (piece.velocity.y < -MAX_UPWARD_REBOUND_SPEED) {
      Matter.Body.setVelocity(piece, {
        x: piece.velocity.x,
        y: -MAX_UPWARD_REBOUND_SPEED,
      });
    }
    if (piece.angularSpeed > MAX_ANGULAR_REBOUND_SPEED) {
      Matter.Body.setAngularVelocity(
        piece,
        Math.sign(piece.angularVelocity) * MAX_ANGULAR_REBOUND_SPEED,
      );
    }
  }

  const hasActiveContact = meta.rigidActiveContactIds.size > 0;
  const canDamp = meta.rigidImpactAge >= RIGID_IMPACT_GUARD_SECONDS && hasActiveContact;
  const lowEnoughMotion = piece.speed < 4 && piece.angularSpeed < 0.08;
  if (!canDamp || !lowEnoughMotion) {
    meta.rigidSettleTime = 0;
    return;
  }

  Matter.Body.setVelocity(piece, {
    x: piece.velocity.x * 0.78,
    y: piece.velocity.y * 0.78,
  });
  Matter.Body.setAngularVelocity(piece, piece.angularVelocity * 0.78);

  const nearlyStill = piece.speed < 0.12 && piece.angularSpeed < 0.006;
  meta.rigidSettleTime = nearlyStill ? meta.rigidSettleTime + dt : 0;
  if (meta.rigidSettleTime >= 0.3) {
    Matter.Body.setVelocity(piece, { x: 0, y: 0 });
    Matter.Body.setAngularVelocity(piece, 0);
    Matter.Sleeping.set(piece, true);
  }
}

export function pieceMeta(piece) {
  return piece?.plugin?.stackMeta ?? null;
}

export function piecePosition(piece) {
  return piece.position;
}

export function pieceBounds(piece) {
  return piece.bounds;
}

export function pieceAngle(piece) {
  return piece.angle;
}

export function pieceIsSleeping(piece) {
  return Boolean(piece?.isSleeping);
}

export function addPieceToWorld(Matter, world, piece) {
  Matter.Composite.add(world, piece);
}

export function removePieceFromWorld(Matter, world, piece) {
  Matter.Composite.remove(world, piece, true);
}

export function setPieceStatic(Matter, piece, isStatic) {
  Matter.Body.setStatic(piece, isStatic);
}

export function setPieceVelocity(Matter, piece, velocity) {
  Matter.Body.setVelocity(piece, velocity);
}

export function setPieceAngularVelocity(Matter, piece, velocity) {
  Matter.Body.setAngularVelocity(piece, velocity);
}

export function wakePiece(Matter, piece) {
  Matter.Sleeping.set(piece, false);
}

export function movePieceTo(Matter, piece, target) {
  Matter.Body.setPosition(piece, target);
}

export function rotatePiece(Matter, piece, radians) {
  Matter.Body.rotate(piece, radians);
}
