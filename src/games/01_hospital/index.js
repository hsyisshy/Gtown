import { initGame, updateGame, drawGame, setPlayerInput, cleanupGame } from './game-logic.js';
import { createLoopingBgm } from '../../shared/loopingBgm.js';

const bgm = createLoopingBgm('01_hospital/audio/bgm.mp3');

export default {
  id: 'hospital',
  name: '狂瘋醫院',
  description: '2v2 對戰！扛擔架送汙染物，60 秒內比誰送得多',
  color: '#00e87a',
  emoji: '🏥',
  cover: '01_hospital/hospital_cover.png',
  playersPerTeam: 2,
  // Unlike climb/truck (which fill short teams gracefully), hospital's two
  // carriers are a rigid stretcher pair — a missing partner leaves half the
  // stretcher uncontrolled, so both teams must be full before it can start.
  requireFullTeams: true,

  tutorial: {
    pages: [
      '01_hospital/tutorial/1.png',
      '01_hospital/tutorial/2.png',
      '01_hospital/tutorial/3.png',
      '01_hospital/tutorial/4.png',
    ],
  },

  onStart(globalState, endCb) {
    const teams      = globalState.teams        || {};
    const active     = globalState.activePlayers || {};
    const players    = globalState.players       || {};
    const mapIndex   = globalState.selectedMap  ?? 0;

    // Find the 2 playing red players and 2 playing blue players
    const redPlayers  = Object.entries(active)
      .filter(([id, role]) => role === 'playing' && teams[id] === 'red')
      .map(([id]) => id);
    const bluePlayers = Object.entries(active)
      .filter(([id, role]) => role === 'playing' && teams[id] === 'blue')
      .map(([id]) => id);

    // Compound IDs: RA = red player A, RB = red player B, BA = blue A, BB = blue B
    const playerMap = {};
    if (redPlayers[0])  playerMap[String(redPlayers[0])]  = 'RA';
    if (redPlayers[1])  playerMap[String(redPlayers[1])]  = 'RB';
    if (bluePlayers[0]) playerMap[String(bluePlayers[0])] = 'BA';
    if (bluePlayers[1]) playerMap[String(bluePlayers[1])] = 'BB';

    // Real nicknames per compound ID, so the on-screen nameplate shows
    // who's who instead of just the team+number.
    const playerNames = {};
    for (const [id, pid] of Object.entries(playerMap)) {
      playerNames[pid] = players[id]?.name;
    }

    initGame(endCb, playerMap, mapIndex, playerNames);
    bgm.start();
  },

  update(dt) {
    updateGame(dt);
  },

  draw(ctx, w, h) {
    drawGame(ctx, w, h);
  },

  onInput(deviceId, data) {
    setPlayerInput(deviceId, data);
  },

  onEnd() {
    bgm.stop();
    cleanupGame();
  },
};
