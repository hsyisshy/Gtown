/**
 * Game registry — add new games here.
 * Each entry must export: id, name, description, color, emoji
 * and optionally: update(dt, state), draw(ctx, w, h, state), onInput(deviceId, data, state)
 *
 * Folder numbering (01_hospital, 02_volleyball, ...) fixes the picker order —
 * when adding a game, slot it in at the position it should appear on the
 * choose-game screen and number its folder to match.
 */

import hospital from './01_hospital/index.js';
import volleyball from './02_volleyball/index.js';
import pong from './03_pong/index.js';
import truck from './04_truck/index.js';
import furnitureStack from './05_furniture-stack/index.js';
import climb from './06_climb/index.js';
import paintingSticker from './07_painting-sticker/index.js';
import fall from './08_fall/index.js';

export const GAMES = [
  hospital,
  volleyball,
  pong,
  truck,
  furnitureStack,
  climb,
  paintingSticker,
  fall,
];

// Cover-art-only previews for games still in development — no mechanics
// yet, so they're never in GAMES/getGame() and can't actually be started.
// It still gets a numbered public/ folder (09_shoot) so the art sits
// alongside real games' assets.
export const UPCOMING_GAMES = [
  { id: 'shoot', name: '噴槍佔地', cover: '09_shoot/shoot_cover.png' },
];

export function getGame(id) {
  return GAMES.find(g => g.id === id) ?? null;
}

// Serializable summary for broadcasting to controllers — real games first,
// then cover-only previews flagged comingSoon so the phone can render them
// the same non-clickable way the screen does.
export function getGameList() {
  return [
    ...GAMES.map(({ id, name, description, color, emoji, cover }) =>
      ({ id, name, description, color, emoji, cover: cover ?? null, comingSoon: false })
    ),
    ...UPCOMING_GAMES.map(({ id, name, cover }) =>
      ({ id, name, description: '', color: null, emoji: null, cover, comingSoon: true })
    ),
  ];
}
