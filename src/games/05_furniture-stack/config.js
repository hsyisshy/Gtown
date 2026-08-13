export const WORLD_W = 1600;
export const WORLD_H = 900;

export const PLATFORM = {
  x: WORLD_W / 2,
  y: 820,
  width: 560,
  height: 42,
};

export const GAME_RULES = {
  turnSeconds: 12,
  diceRollSeconds: 1.55,
  gravityY: 2.0,
  shapeChangesPerTeam: 3,
  roundsToWin: 1,
  roundPauseSeconds: 2.6,
  matchPauseSeconds: 2.8,
  moveSpeed: 360,
  failY: WORLD_H + 100,
  failXMargin: 180,
  maxPlacements: 24,
};

export const TEAM_STYLE = {
  red: {
    main: '#ff5f61',
    light: '#ffaaa0',
    dark: '#8f252c',
    glow: 'rgba(255, 95, 97, 0.45)',
    label: '紅隊',
  },
  blue: {
    main: '#38d4d9',
    light: '#9af3ee',
    dark: '#126d7a',
    glow: 'rgba(56, 212, 217, 0.45)',
    label: '藍隊',
  },
};
