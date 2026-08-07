/**
 * Game registry — add new games here.
 * Each entry must export: id, name, description, color, emoji
 * and optionally: update(dt, state), draw(ctx, w, h, state), onInput(deviceId, data, state)
 */

import volleyball from './volleyball/index.js';
import pong from './pong/index.js';
import hospital from './hospital/index.js';
import truck from './truck/index.js';
import furnitureStack from './furniture-stack/index.js';
import climb from './climb/index.js';
import paintingSticker from './painting-sticker/index.js';

export const GAMES = [
  hospital,
  volleyball,
  pong,
  truck,
  furnitureStack,
  climb,
  paintingSticker,
];

export function getGame(id) {
  return GAMES.find(g => g.id === id) ?? null;
}

// Serializable summary for broadcasting to controllers
export function getGameList() {
  return GAMES.map(({ id, name, description, color, emoji, cover }) =>
    ({ id, name, description, color, emoji, cover: cover ?? null })
  );
}
