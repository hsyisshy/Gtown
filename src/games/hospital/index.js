import { initGame, updateGame, drawGame, setPlayerInput, cleanupGame } from './game-logic.js';
import { createLoopingBgm } from '../../shared/loopingBgm.js';

const bgm = createLoopingBgm('hospital/audio/bgm.mp3');

const MAPS = [
  { name: '第一地圖：開闊病房', description: '無障礙地形，4 隻殭屍，比誰跑得快、閃得準' },
  { name: '第二地圖：障礙迷宮', description: '三道障礙牆，3 隻殭屍，走位與卡位是勝負關鍵' },
  { name: '第三地圖：同步平台', description: '兩座往返平台，4 隻殭屍，雙隊搶搭同一條航線' },
];

export default {
  id: 'hospital',
  name: '狂瘋醫院',
  description: '2v2 對戰！扛擔架送汙染物，搶先送達 10 個獲勝',
  color: '#00e87a',
  emoji: '🏥',
  cover: 'hospital/hospital_cover.png',
  playersPerTeam: 2,
  maps: MAPS,

  tutorial: {
    goal: '2v2 對抗——隊友兩人扛起擔架搬運汙染物送到對面，搶先送達 10 個獲勝！',
    controls: [
      { key: '🕹️', text: '移動角色' },
    ],
    tips: [
      '小心殭屍！被攻擊會扣血，倒地時汙染物會掉落',
      '兩位隊友要互相配合走位，擔架才扛得穩',
      '第三地圖要搭來回移動的平台，抓準時機跳上去',
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
