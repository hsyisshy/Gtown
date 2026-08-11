export const HELD_PIECE_SCREEN_Y = 185;

export const CAMERA_RULES = Object.freeze({
  triggerScreenY: 420,
  restoreScreenY: 470,
  followRate: 3.4,
});

export function cameraTargetForTower(currentTarget, stableTowerTop) {
  if (!Number.isFinite(stableTowerTop)) return currentTarget;
  const projectedScreenTop = stableTowerTop + currentTarget;
  if (projectedScreenTop >= CAMERA_RULES.triggerScreenY) return currentTarget;
  return Math.max(currentTarget, CAMERA_RULES.restoreScreenY - stableTowerTop);
}

export function easeCameraOffset(currentOffset, targetOffset, dt) {
  if (targetOffset <= currentOffset) return currentOffset;
  const safeDt = Math.max(0, Math.min(dt, 0.1));
  const blend = 1 - Math.exp(-CAMERA_RULES.followRate * safeDt);
  const nextOffset = currentOffset + (targetOffset - currentOffset) * blend;
  return targetOffset - nextOffset < 0.1 ? targetOffset : nextOffset;
}

export function worldYForFixedScreenY(screenY, cameraOffset) {
  return screenY - cameraOffset;
}
