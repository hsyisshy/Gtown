// Fixed logical space — draw() uniform-scales + letterboxes into the actual
// canvas, same recipe as truck/furniture-stack.
export const LOGICAL_W = 1600;
export const LOGICAL_H = 900;

export const PLAY_SECONDS = 120;
export const PIECES_PER_TEAM = 25;
export const RACK_SCALE = 0.1;
export const CURSOR_SIZE = 22;
export const MOVE_SPEED = 260; // logical px / sec — slow enough for precise placement
export const ALPHA_HIT_THRESHOLD = 20;

export const SCORE_SAMPLE_W = 240;

// Early-finish bonus: lock in your score before time's up for a bonus that
// scales with how much time was left — rewards confidence, not stalling.
export const BONUS_RATE = 1.34;
export const BONUS_CAP = 8;

// How long the final score reveal holds on screen before handing control
// back to the hub's results phase.
export const RESULT_HOLD_SECONDS = 4;

// Overrides tear-config.json's cols/rows — piece count is fixed per team
// instead of per-painting.
export const TEAR_CONFIG = {
  seedJitter: 0.35,
  tearDepthPx: 34,
  tearIterations: 4,
  tearDepthDecay: 0.55,
  overlapPx: 10,
  supersample: 4,
  canvasPaddingPx: 24,
};

// ---- Layout (two side panels + a middle strip, logical space) ----
const MARGIN = 24;
const COL_GAP = 24;
export const MID_W = 340;
export const SIDE_W = (LOGICAL_W - MID_W - 2 * MARGIN - 2 * COL_GAP) / 2;
export const LEFT_X = MARGIN;
export const MID_X = LEFT_X + SIDE_W + COL_GAP;
export const RIGHT_X = MID_X + MID_W + COL_GAP;

export const TIMER_Y = 14;
export const TIMER_H = 56;

export const CONTENT_TOP = 92;
export const CONTENT_BOTTOM = LOGICAL_H - MARGIN;

export const HEADER_H = 40;
const GAP_AFTER_HEADER = 10;
export const RACK_H = 300;
const GAP_AFTER_RACK = 16;

export const RACK_Y = CONTENT_TOP + HEADER_H + GAP_AFTER_HEADER;
export const CANVAS_Y = RACK_Y + RACK_H + GAP_AFTER_RACK;
export const CANVAS_H = CONTENT_BOTTOM - CANVAS_Y;

export const PREVIEW_H = 260;
const MID_GAP = 20;
export const PREVIEW_Y = CONTENT_TOP;
export const SCORE_Y = PREVIEW_Y + PREVIEW_H + MID_GAP;
export const SCORE_H = CONTENT_BOTTOM - SCORE_Y;

export const TEAM_LABEL = { red: '紅隊', blue: '藍隊' };
