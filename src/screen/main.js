import './style.css';
import { StateMachine } from '../shared/state-machine.js';
import { cappedDt } from '../shared/airconsole-wrapper.js';
import { PHASE, MSG, STATE_KEY, MAX_PLAYERS, TEAM_COLOR, TOTAL_GAME_SLOTS, PREP_REEL_DURATION_MS, PREP_READY_TIMEOUT_MS, TUTORIAL_PAGE_AUTO_MS } from '../shared/constants.js';
import { GAMES, UPCOMING_GAMES, getGame, getGameList } from '../games/registry.js';
import { fillMissingTeams, toggleTeam, teamCounts } from '../shared/teams.js';

// ---------------------------------------------------------------------------
// AirConsole
// ---------------------------------------------------------------------------
const airconsole = new AirConsole({ silence_inactive_players: true });

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const state = {
  players: {},           // { [deviceId]: { name, score } }
  teams: {},             // { [deviceId]: 'red' | 'blue' }
  teamScores: { red: 0, blue: 0 },  // cumulative wins across all rounds
  playerPlayCounts: {},  // { [deviceId]: number } — for weighted draw
  activePlayers: {},     // { [deviceId]: 'playing' | 'watching' } — populated once PREP's reveal lands
  prepReady: {},         // { [deviceId]: true } — drawn players who've tapped 準備 this round
  prepUnlocked: false,   // host override (強制開始/重抽) unlocked after PREP_READY_TIMEOUT_MS with stragglers
  selectedMap: null,     // number | null
  activeMaps: null,      // maps/modes currently on the picker (may carry .enabled)
  lastWinner: null,      // 'red' | 'blue' | null — for results display
  initialized: false,
  currentGame: null,
  tutorialActive: false, // how-to-play card is up — game updates/inputs hold
  hostId: null,          // deviceId of the current host — transferable via
                         // request/approve; falls back to AirConsole's master
};

// The hub's "host" starts as AirConsole's master controller but can be
// handed over (guests request, host approves). AirConsole has no API to
// reassign its own master, so the transferable role lives here and every
// permission check goes through this instead of getMasterControllerDeviceId.
function getHostId() {
  if (state.hostId != null && state.players[state.hostId]) return state.hostId;
  return airconsole.getMasterControllerDeviceId();
}

const sm = new StateMachine(onPhaseChange);

// Cheer emojis — rendered on canvas, not in DOM
const _cheerEmojis = [];

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const canvas             = document.getElementById('canvas');
const ctx                = canvas.getContext('2d');
const viewLobby          = document.getElementById('view-lobby');
const viewSelect         = document.getElementById('view-game-select');
const viewMapSelect      = document.getElementById('view-map-select');
const viewPrep           = document.getElementById('view-prep');
const viewResults        = document.getElementById('view-results');
const playerCountEl      = document.getElementById('player-count');
const teamRedListEl      = document.getElementById('team-red-list');
const teamBlueListEl     = document.getElementById('team-blue-list');
const gameGridEl         = document.getElementById('game-grid');
const randomPickBtn      = document.getElementById('random-pick-btn');
const mapGridEl          = document.getElementById('map-grid');
const prepReelsRedEl     = document.getElementById('prep-reels-red');
const prepReelsBlueEl    = document.getElementById('prep-reels-blue');
const prepRosterEl       = document.getElementById('prep-roster');
const prepCountdownEl    = document.getElementById('prep-countdown');
const mapSelectTitleEl   = document.getElementById('map-select-game-title');
const lobbyHintEl        = document.getElementById('lobby-hint');
const scoreboardEl       = document.getElementById('results-scoreboard');
const resultsHintEl      = document.getElementById('results-hint');
const viewIntro          = document.getElementById('view-intro');
const introVideo         = document.getElementById('intro-video');
const introStartBtn      = document.getElementById('intro-start-btn');

// ---------------------------------------------------------------------------
// Intro splash — local to the screen only, independent of AirConsole /
// the multiplayer state machine. The controller's own START button still
// drives the actual game-select flow; this just gates the opening video.
// ---------------------------------------------------------------------------
const INTRO_TAIL_LOOP_SECONDS = 1; // once played through, hold on a loop of just the ending

// ---------------------------------------------------------------------------
// Lobby BGM — loops under every menu phase (lobby / game select / map
// select / results). Hand-off rules: the intro video's own soundtrack owns
// the audio until its first full play-through, then the video goes mute
// (its 1s tail loop would be grating) and the BGM fades in. Replay swaps
// back. Gameplay fades the BGM out so the game's own sounds take over.
// ---------------------------------------------------------------------------
const BGM_LOOP_FADE_SECONDS = 3;  // slow breathe across the loop seam
const BGM_PHASE_FADE_MS = 2200;   // slow fades when menus hand audio around

// User-adjustable via the settings panel; persisted per screen device.
let BGM_VOLUME = _loadVolume('setting_bgm_volume', 0.5);
let SFX_VOLUME = _loadVolume('setting_sfx_volume', 1.0);

function _loadVolume(key, fallback) {
  const v = parseFloat(localStorage.getItem(key));
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
}

const bgm = new Audio('Lobby_bgm.mp3');
bgm.loop = true;
bgm.volume = 0;

// One 50ms ticker owns bgm.volume, combining two layers:
//  - base: the phase-level volume, eased toward its target (menu vs game)
//  - envelope: dips to silence across the track's loop seam — the last
//    seconds fade out and the first seconds fade back in, so the restart
//    is a gentle breathe instead of an audible cut.
let _bgmBase = 0;
let _bgmBaseTarget = 0;
let _bgmStepPerTick = 0;
let _bgmShouldPlay = false; // menu phase wants BGM — survives a fade to 0
const BGM_TICK_MS = 50;

setInterval(() => {
  if (bgm.paused) return;
  if (_bgmBase !== _bgmBaseTarget) {
    _bgmBase = _bgmStepPerTick > 0
      ? Math.min(_bgmBaseTarget, _bgmBase + _bgmStepPerTick)
      : Math.max(_bgmBaseTarget, _bgmBase + _bgmStepPerTick);
    if (_bgmBase === 0 && _bgmBaseTarget === 0) { bgm.pause(); return; }
  }
  let envelope = 1;
  const d = bgm.duration;
  if (Number.isFinite(d) && d > BGM_LOOP_FADE_SECONDS * 2) {
    const t = bgm.currentTime;
    if (t < BGM_LOOP_FADE_SECONDS) envelope = t / BGM_LOOP_FADE_SECONDS;
    else if (t > d - BGM_LOOP_FADE_SECONDS) envelope = Math.max(0, (d - t) / BGM_LOOP_FADE_SECONDS);
  }
  bgm.volume = Math.max(0, Math.min(1, _bgmBase * envelope));
}, BGM_TICK_MS);

function fadeBgm(target, ms = BGM_PHASE_FADE_MS) {
  _bgmBaseTarget = target;
  _bgmStepPerTick = (target - _bgmBase) / Math.max(1, ms / BGM_TICK_MS);
}

function startBgm() {
  _bgmShouldPlay = true;
  if (!bgm.paused) { fadeBgm(BGM_VOLUME); return; }
  // Autoplay policy may reject before the page has a user gesture —
  // retry on the next tap/click, same fallback as the intro video.
  bgm.play().then(() => fadeBgm(BGM_VOLUME)).catch(() => {
    document.addEventListener('pointerdown', () => {
      bgm.play().then(() => fadeBgm(BGM_VOLUME)).catch(() => {});
    }, { once: true });
  });
}

function stopBgm() { _bgmShouldPlay = false; fadeBgm(0); }

// ---------------------------------------------------------------------------
// Settings panel — bottom-right gear. BGM volume applies on this screen;
// button-SFX volume is broadcast so every controller scales its own sounds.
// ---------------------------------------------------------------------------
const settingsBtn   = document.getElementById('settings-btn');
const homeBtn       = document.getElementById('home-btn');
const settingsPanel = document.getElementById('settings-panel');
const bgmSlider     = document.getElementById('setting-bgm');
const sfxSlider     = document.getElementById('setting-sfx');

settingsBtn.addEventListener('click', () => settingsPanel.classList.toggle('hidden'));

bgmSlider.value = Math.round(BGM_VOLUME * 100);
sfxSlider.value = Math.round(SFX_VOLUME * 100);
introVideo.volume = BGM_VOLUME; // the intro soundtrack is "背景音樂" too

bgmSlider.addEventListener('input', () => {
  BGM_VOLUME = bgmSlider.value / 100;
  localStorage.setItem('setting_bgm_volume', String(BGM_VOLUME));
  introVideo.volume = BGM_VOLUME;
  // In-game BGMs (shared/loopingBgm.js) listen for this to retarget live
  window.dispatchEvent(new CustomEvent('bgm-volume-change', { detail: BGM_VOLUME }));
  // Quick retarget while a menu wants BGM, so the slider feels live instead
  // of easing over the slow 2.2s menu fade. A previous drag to 0 pauses the
  // element outright, so dragging back up must also resume playback. Silent
  // phases (gameplay) just keep the new value for the next startBgm().
  if (_bgmShouldPlay) {
    if (bgm.paused) bgm.play().catch(() => {});
    fadeBgm(BGM_VOLUME, 200);
  }
});

let _sfxBroadcastTimer = null;
sfxSlider.addEventListener('input', () => {
  SFX_VOLUME = sfxSlider.value / 100;
  localStorage.setItem('setting_sfx_volume', String(SFX_VOLUME));
  applyScreenSfxVolume();
  // Debounced — 'input' fires continuously while dragging and every
  // broadcast is a network message to all controllers.
  clearTimeout(_sfxBroadcastTimer);
  _sfxBroadcastTimer = setTimeout(() => {
    airconsole.setCustomDeviceStateProperty(STATE_KEY.SFX_VOLUME, SFX_VOLUME);
  }, 150);
});

// ---------------------------------------------------------------------------
// Screen button SFX — the intro is the one place driven by a real mouse,
// so it gets the two-stage treatment: hover cue on mouse-over, click cue
// on activation. Volume follows the same SFX setting as the controllers.
// ---------------------------------------------------------------------------
const hoverSfx = new Audio('bottom_hoverclick.mp3');
const clickSfx = new Audio('bottom_hoverclick.mp3');
hoverSfx.preload = 'auto';
clickSfx.preload = 'auto';

function applyScreenSfxVolume() {
  clickSfx.volume = SFX_VOLUME;
  hoverSfx.volume = SFX_VOLUME * 0.7;
}
applyScreenSfxVolume();

function playScreenSfx(sfx) {
  sfx.currentTime = 0;
  sfx.play().catch(() => {});   // pre-gesture autoplay rejection — ignore
}

introStartBtn.addEventListener('mouseenter', () => playScreenSfx(hoverSfx));
introStartBtn.addEventListener('click', () => playScreenSfx(clickSfx));

// Play through once, then keep looping only the last few seconds so the
// screen keeps moving instead of restarting the whole clip from the top.
introVideo.addEventListener('ended', () => {
  // First full play-through done — the tail loop runs silent under the BGM
  introVideo.muted = true;
  startBgm();
  introVideo.currentTime = Math.max(0, introVideo.duration - INTRO_TAIL_LOOP_SECONDS);
  introVideo.play();
});

// Browsers block autoplay-with-sound until the page has had a user
// gesture. Try with sound first; if that's rejected, fall back to muted
// so the video still plays, then unmute on the first tap/click anywhere.
introVideo.play().catch(() => {
  introVideo.muted = true;
  introVideo.play();
  document.addEventListener('pointerdown', () => { introVideo.muted = false; }, { once: true });
});

introStartBtn.addEventListener('click', () => {
  viewIntro.classList.add('hidden');
  updateHomeBtn();
  introVideo.pause();
  startBgm(); // covers skipping before the video's first play-through ends
});

// 🏠 only lives in the team lobby — later phases (game select, playing…)
// shouldn't offer a jump back to the opening.
function updateHomeBtn() {
  homeBtn.classList.toggle('hidden',
    !sm.is(PHASE.LOBBY) || !viewIntro.classList.contains('hidden'));
}

// 🏠 — back to the opening screen from any menu (lobby / game select / …).
// Pure screen-side overlay: connections, teams and scores all stay intact;
// 開始遊戲 simply drops you back where the hub state currently is.
homeBtn.addEventListener('click', () => {
  viewIntro.classList.remove('hidden');
  homeBtn.classList.add('hidden');
  stopBgm();
  introVideo.muted = false;
  introVideo.currentTime = 0;
  introVideo.play();
});

// Replay the opening from the top (mostly useful once the tail loop kicks
// in) — the video's soundtrack takes the stage back from the BGM.
document.getElementById('intro-replay-btn').addEventListener('click', () => {
  stopBgm();
  introVideo.muted = false;
  introVideo.currentTime = 0;
  introVideo.play();
});

// ---------------------------------------------------------------------------
// AirConsole events
// ---------------------------------------------------------------------------
airconsole.onReady = function () {
  if (state.initialized) return;
  state.initialized = true;
  resizeCanvas();
  renderLoop();
  broadcastGameList();
};

airconsole.onConnect = function (deviceId) {
  const name = airconsole.getNickname(deviceId) || `P${Object.keys(state.players).length + 1}`;
  state.players[deviceId] = { name, score: 0 };
  // Only the new player gets assigned (to whichever team is smaller) —
  // existing players (and any manual switch-team swaps) are left alone.
  state.teams = fillMissingTeams(state.teams, Object.keys(state.players));
  updateMaster();
  broadcastState();
  renderLobby();
};

airconsole.onDisconnect = function (deviceId) {
  if (deviceId === state.hostId) state.hostId = null; // fall back to AirConsole master
  delete state.players[deviceId];
  delete state.activePlayers[deviceId];
  delete state.playerPlayCounts[deviceId];
  delete state.teams[deviceId];
  updateMaster();
  broadcastState();
  renderLobby();
};

airconsole.onMessage = function (deviceId, data) {
  if (!data?.type) return;
  const masterId = getHostId();

  switch (data.type) {

    case MSG.REQUEST_START: {
      if (deviceId !== masterId) return;
      if (!sm.is(PHASE.LOBBY)) return;
      const ids = Object.keys(state.players);
      if (ids.length < 2) return;
      // Safety net only — everyone should already have a team from
      // onConnect/switch-team. Never reshuffle existing assignments here.
      state.teams = fillMissingTeams(state.teams, ids);
      sm.toGameSelect();
      broadcastState();
      break;
    }

    case MSG.SWITCH_TEAM: {
      if (!sm.is(PHASE.LOBBY)) return;
      if (!state.players[deviceId]) return;
      state.teams = toggleTeam(state.teams, deviceId);
      updateMaster();
      broadcastState();
      renderLobby();
      break;
    }

    case MSG.SELECT_GAME: {
      if (deviceId !== masterId) return;
      if (!sm.is(PHASE.GAME_SELECT)) return;
      handleGameSelected(data.gameId);
      break;
    }

    case MSG.RANDOM_PICK: {
      if (deviceId !== masterId) return;
      if (!sm.is(PHASE.GAME_SELECT) || randomPickBtn.disabled) return;
      spinRandomPick();
      break;
    }

    case MSG.SELECT_MAP: {
      if (deviceId !== masterId) return;
      if (!sm.is(PHASE.MAP_SELECT)) return;
      handleMapSelected(data.mapIndex);
      break;
    }

    case MSG.PREP_READY: {
      if (!sm.is(PHASE.PREP)) return;
      if (state.activePlayers[deviceId] !== 'playing') return;
      state.prepReady[deviceId] = true;
      if (allPrepPlayersReady()) {
        beginMatch();
      } else {
        broadcastState();
        renderPrepRoster();
      }
      break;
    }

    case MSG.PREP_FORCE_START: {
      if (deviceId !== masterId) return;
      if (!sm.is(PHASE.PREP) || !state.prepUnlocked) return;
      beginMatch();
      break;
    }

    case MSG.PREP_REDRAW: {
      if (deviceId !== masterId) return;
      if (!sm.is(PHASE.PREP) || !state.prepUnlocked) return;
      const targetId = String(data.targetId);
      if (state.activePlayers[targetId] !== 'playing' || state.prepReady[targetId]) return;
      const team = state.teams[targetId];
      const spareIds = Object.entries(state.activePlayers)
        .filter(([id, role]) => role === 'watching' && state.teams[id] === team)
        .map(([id]) => id);
      const [substituteId] = drawWeightedPlayers(spareIds, 1);
      if (!substituteId) return; // no spare — host panel shouldn't have offered this
      state.activePlayers[targetId] = 'watching';
      state.activePlayers[substituteId] = 'playing';
      delete state.prepReady[targetId];
      broadcastState();
      renderPrepRoster();
      break;
    }

    case MSG.CHEER: {
      if (!sm.is(PHASE.PLAYING)) return;
      if (data.emoji) addCheerEmoji(data.emoji, deviceId);
      break;
    }

    case MSG.TUTORIAL_NEXT: {
      if (!sm.is(PHASE.PLAYING) || !_tutorialPages) return;
      if (String(deviceId) !== _tutorialControllerId) return;
      tutorialPageNext();
      break;
    }

    case MSG.TUTORIAL_PREV: {
      if (!sm.is(PHASE.PLAYING) || !_tutorialPages) return;
      if (String(deviceId) !== _tutorialControllerId) return;
      tutorialPagePrev();
      break;
    }

    case MSG.REQUEST_RESULTS: {
      if (deviceId !== masterId) return;
      if (!sm.is(PHASE.PLAYING)) return;
      endGame();
      break;
    }

    case MSG.PLAYER_INPUT: {
      if (sm.is(PHASE.PLAYING)) handlePlayerInput(deviceId, data);
      break;
    }

    case MSG.REQUEST_HOST: {
      if (!sm.is(PHASE.LOBBY)) return;            // the claim button only exists in the lobby
      if (deviceId === masterId) return;          // host asking to be host — ignore
      if (!state.players[deviceId]) return;
      airconsole.message(masterId, {
        type: 'host_request',
        fromId: deviceId,
        fromName: state.players[deviceId].name,
      });
      break;
    }

    case MSG.APPROVE_HOST: {
      if (deviceId !== masterId) return;
      const targetId = Number(data.targetId);
      if (!state.players[targetId]) return;       // requester already left
      state.hostId = targetId;
      updateMaster();
      broadcastState();
      renderLobby();
      break;
    }

    case MSG.DENY_HOST: {
      if (deviceId !== masterId) return;
      const targetId = Number(data.targetId);
      if (!state.players[targetId]) return;
      airconsole.message(targetId, { type: 'host_denied' });
      break;
    }

    case 'play_again': {
      if (deviceId !== masterId || !sm.is(PHASE.RESULTS)) return;
      sm.toGameSelect();
      broadcastState();
      break;
    }

    case 'back_to_lobby': {
      if (deviceId !== masterId) return;
      if (sm.is(PHASE.GAME_SELECT) || sm.is(PHASE.MAP_SELECT)) {
        // Host backed out before the round started — no round was played,
        // so just return to the lobby with teams left exactly as they were.
        state.currentGame = null;
        state.selectedMap = null;
        sm.toLobby();
        broadcastState();
      } else if (sm.is(PHASE.PREP)) {
        // Host backs out mid-prep (wrong game/map, or things look off) —
        // nobody's onStart() fired yet, so there's nothing to tear down
        // beyond the prep state itself.
        clearTimeout(_prepReadyTimer);
        clearInterval(_prepCountdownInterval);
        state.currentGame = null;
        state.selectedMap = null;
        state.activePlayers = {};
        state.prepReady = {};
        state.prepUnlocked = false;
        sm.toGameSelect();
        broadcastState();
      } else if (sm.is(PHASE.PLAYING)) {
        // Host aborts the round mid-game: tear the game down without
        // crediting scores or a winner, and go straight back to picking a
        // new game — teams stay exactly as they were, no need to re-split.
        state.currentGame?.onEnd?.();
        state.currentGame = null;
        airconsole.setActivePlayers(0);
        state.activePlayers = {};
        state.selectedMap = null;
        sm.toGameSelect();
        broadcastState();
      }
      break;
    }
  }
};

// ---------------------------------------------------------------------------
// Master
// ---------------------------------------------------------------------------
function updateMaster() {
  const masterId = String(getHostId());
  airconsole.setCustomDeviceStateProperty(STATE_KEY.PLAYERS,
    Object.entries(state.players).reduce((acc, [id, p]) => {
      acc[id] = { ...p, isMaster: id === masterId, team: state.teams[id] ?? null };
      return acc;
    }, {})
  );
}

// ---------------------------------------------------------------------------
// State broadcast
// ---------------------------------------------------------------------------
// Each setCustomDeviceStateProperty call is its own message, so controllers
// can observe these fields land one at a time rather than atomically. PHASE
// is what controllers gate "mount my game's controller layout" on, so it's
// set LAST — by the time a controller sees phase flip to PLAYING, TEAMS /
// ACTIVE_PLAYERS / CURRENT_GAME already carry this round's values instead of
// whatever was left over from the previous game (which used to be able to
// mount the wrong/previous game's layout for a moment and then get stuck,
// since the mount guard only fires once per phase change).
function broadcastState() {
  airconsole.setCustomDeviceStateProperty(STATE_KEY.TEAMS, state.teams);
  airconsole.setCustomDeviceStateProperty(STATE_KEY.SFX_VOLUME, SFX_VOLUME);
  airconsole.setCustomDeviceStateProperty(STATE_KEY.TEAM_SCORES, state.teamScores);
  airconsole.setCustomDeviceStateProperty(STATE_KEY.ACTIVE_PLAYERS, state.activePlayers);
  airconsole.setCustomDeviceStateProperty(STATE_KEY.SELECTED_MAP, state.selectedMap);
  airconsole.setCustomDeviceStateProperty(STATE_KEY.PREP_READY, state.prepReady);
  airconsole.setCustomDeviceStateProperty(STATE_KEY.PREP_UNLOCKED, state.prepUnlocked);
  airconsole.setCustomDeviceStateProperty(STATE_KEY.SCORES,
    Object.entries(state.players).reduce((acc, [id, p]) => {
      acc[id] = p.score;
      return acc;
    }, {})
  );
  airconsole.setCustomDeviceStateProperty(STATE_KEY.CURRENT_GAME,
    state.currentGame?.id ?? null
  );
  airconsole.setCustomDeviceStateProperty(STATE_KEY.PHASE, sm.phase);
  updateMaster();
}

function broadcastGameList() {
  airconsole.setCustomDeviceStateProperty(STATE_KEY.GAME_LIST, getGameList());
}

// ---------------------------------------------------------------------------
// Weighted player draw
// Sorts by playCount ascending (shuffle within same-count tier).
// ---------------------------------------------------------------------------
function drawWeightedPlayers(teamIds, n) {
  if (!teamIds.length || n <= 0) return [];
  if (teamIds.length <= n) return [...teamIds];
  const sorted = teamIds
    .map(id => ({ id, count: state.playerPlayCounts[id] || 0 }))
    .sort((a, b) => a.count - b.count || (Math.random() - 0.5));
  return sorted.slice(0, n).map(p => p.id);
}

// ---------------------------------------------------------------------------
// Game lifecycle
// ---------------------------------------------------------------------------
function handleGameSelected(gameId) {
  const game = getGame(gameId);
  if (!game) return;

  if (game.requireFullTeams) {
    const { red, blue } = teamCounts(state.teams);
    if (red < game.playersPerTeam || blue < game.playersPerTeam) {
      airconsole.message(getHostId(), {
        type: 'not_enough_players',
        reason: `${game.name} 需要雙方隊伍都滿 ${game.playersPerTeam} 人才能開始`,
      });
      return;
    }
  }

  state.currentGame = game;
  state.selectedMap = null;
  state.activeMaps = null;

  // Games can resolve a dynamic mode list from the current roster — e.g.
  // volleyball's 1v1 / 2v2, where 2v2 is greyed unless both teams field a
  // pair, and the picker is skipped outright when only 1v1 is possible.
  if (game.resolveModes) {
    const { red, blue } = teamCounts(state.teams);
    const { maps, autoIndex } = game.resolveModes(red, blue);
    if (autoIndex != null) {          // only one sane mode → straight into it
      state.selectedMap = autoIndex;
      enterPrep();
      return;
    }
    state.activeMaps = maps;
    airconsole.setCustomDeviceStateProperty(STATE_KEY.MAP_LIST, maps);
    sm.toMapSelect();
    broadcastState();
    return;
  }

  if (game.maps?.length) {
    state.activeMaps = game.maps;
    airconsole.setCustomDeviceStateProperty(STATE_KEY.MAP_LIST, game.maps);
    sm.toMapSelect();
    broadcastState();
    return;
  }

  enterPrep();
}

function handleMapSelected(mapIndex) {
  const maps = state.activeMaps ?? state.currentGame?.maps ?? [];
  const map = maps[mapIndex];
  if (!map || map.enabled === false) return;   // ignore out-of-range / disabled
  state.selectedMap = mapIndex;
  enterPrep();
}

// ---------------------------------------------------------------------------
// PREP — reveal each team's picks (slot-machine style), then hold until
// everyone drawn taps 準備 before the match actually begins. See
// src/shared/constants.js for PREP_REEL_DURATION_MS / PREP_READY_TIMEOUT_MS.
// ---------------------------------------------------------------------------
let _prepReadyTimer = null;
// Bumped on every enterPrep() so a stale runReveal() callback from an
// aborted-then-immediately-re-picked PREP can tell it's no longer current
// (sm.is(PHASE.PREP) alone isn't enough — that'd also be true for the NEW
// pick, which has different redPicked/bluePicked closed over in the old
// callback).
let _prepGeneration = 0;

function enterPrep() {
  const game = state.currentGame;
  if (!game) return;
  // Per-team headcount can depend on the picked mode (e.g. 1v1 vs 2v2).
  const ppt = game.playersPerTeamFor?.(state.selectedMap) ?? game.playersPerTeam ?? 1;

  const redIds  = Object.entries(state.teams).filter(([, t]) => t === 'red').map(([id]) => id);
  const blueIds = Object.entries(state.teams).filter(([, t]) => t === 'blue').map(([id]) => id);

  const redPicked  = drawWeightedPlayers(redIds, ppt);
  const bluePicked = drawWeightedPlayers(blueIds, ppt);

  // activePlayers stays empty until the reveal actually lands on screen —
  // broadcasting it now would let a drawn player's phone show the ready
  // button before the shared spin even finishes, spoiling the reveal.
  state.activePlayers = {};
  state.prepReady = {};
  state.prepUnlocked = false;
  sm.toPrep();
  broadcastState();

  const gen = ++_prepGeneration;
  runReveal(redIds, blueIds, redPicked, bluePicked, ppt, gen);
}

function allPrepPlayersReady() {
  return Object.entries(state.activePlayers)
    .filter(([, role]) => role === 'playing')
    .every(([id]) => state.prepReady[id]);
}

function finishReveal(redPicked, bluePicked) {
  const allPicked = [...redPicked, ...bluePicked];

  state.activePlayers = {};
  Object.keys(state.players).forEach(id => {
    state.activePlayers[id] = allPicked.includes(id) ? 'playing' : 'watching';
  });
  state.prepReady = {};
  state.prepUnlocked = false;
  broadcastState();
  renderPrepRoster();

  if (allPicked.length === 0) { beginMatch(); return; } // nobody to wait on

  startPrepCountdown(PREP_READY_TIMEOUT_MS / 1000);
  clearTimeout(_prepReadyTimer);
  _prepReadyTimer = setTimeout(() => {
    // Host may have already backed out, or a race let everyone ready up
    // right as the timer fired — either way there's nothing to unlock.
    if (!sm.is(PHASE.PREP) || allPrepPlayersReady()) return;
    state.prepUnlocked = true;
    broadcastState();
    renderPrepRoster();
  }, PREP_READY_TIMEOUT_MS);
}

function beginMatch() {
  const game = state.currentGame;
  if (!game) return;
  clearTimeout(_prepReadyTimer);

  const allPicked = Object.entries(state.activePlayers)
    .filter(([, role]) => role === 'playing')
    .map(([id]) => id);

  allPicked.forEach(id => {
    state.playerPlayCounts[id] = (state.playerPlayCounts[id] || 0) + 1;
  });

  airconsole.setActivePlayers(allPicked.length);
  sm.toPlaying();
  broadcastState();
  game.onStart?.(state, endGame);
  showTutorial(game);
}

// ---------------------------------------------------------------------------
// PREP reveal — slot-machine reels, one per required slot. A single spin
// reveals a whole team's roster at once; red/blue launch together. Pure
// CSS-transition scroll (not a JS tick loop): the landing value is set as
// the literal final transform, so it can never overshoot/undershoot.
// ---------------------------------------------------------------------------
const REEL_ROW_H = 64;          // px — must match .reel-row height in style.css
const REEL_FILLER_COUNT = 24;   // decorative rows scrolled through before landing

function buildReelRows(candidateIds, winnerId) {
  const names = candidateIds.map(id => state.players[id]?.name ?? '???');
  const randomName = () => names[Math.floor(Math.random() * names.length)];
  const fillers = Array.from({ length: REEL_FILLER_COUNT }, randomName);
  const winnerName = state.players[winnerId]?.name ?? '???';
  return [...fillers, winnerName, randomName()]; // winner lands at index REEL_FILLER_COUNT
}

function renderReel(containerEl, candidateIds, winnerId) {
  const rows = buildReelRows(candidateIds, winnerId);
  const strip = document.createElement('div');
  strip.className = 'reel-strip';
  rows.forEach((name, i) => {
    const row = document.createElement('div');
    row.className = 'reel-row' + (i === REEL_FILLER_COUNT ? ' winner' : '');
    row.textContent = name;
    strip.appendChild(row);
  });
  const win = document.createElement('div');
  win.className = 'reel-window';
  win.appendChild(strip);
  containerEl.appendChild(win);
  return strip;
}

function spinReel(strip) {
  const targetY = -(REEL_FILLER_COUNT - 1) * REEL_ROW_H;
  strip.style.transition = 'none';
  strip.style.transform = 'translateY(0px)';
  // Force a reflow so the reset above actually commits before the
  // transition is applied — otherwise the browser can coalesce both style
  // writes into one paint and the reel just snaps to the end with no
  // visible motion at all.
  void strip.offsetHeight;
  strip.style.transition = `transform ${PREP_REEL_DURATION_MS}ms cubic-bezier(0.12, 0.8, 0.2, 1)`;
  strip.style.transform = `translateY(${targetY}px)`;
}

function runReveal(redIds, blueIds, redPicked, bluePicked, ppt, gen) {
  const buildTeamBox = (containerEl, teamIds, pickedIds) => {
    containerEl.innerHTML = '';
    const needsSpin = teamIds.length > ppt;
    if (!needsSpin) {
      const msg = document.createElement('div');
      msg.className = 'prep-instant';
      msg.textContent = pickedIds.length ? '✅ 全隊上場！' : '（本隊無人可上場）';
      containerEl.appendChild(msg);
      return null;
    }
    return pickedIds.map(winnerId => renderReel(containerEl, teamIds, winnerId));
  };

  const redStrips  = buildTeamBox(prepReelsRedEl, redIds, redPicked);
  const blueStrips = buildTeamBox(prepReelsBlueEl, blueIds, bluePicked);
  const anySpin = !!(redStrips || blueStrips);

  prepRosterEl.innerHTML = '';
  prepCountdownEl.classList.add('hidden');

  if (anySpin) {
    playScreenSfx(clickSfx); // spin-start whoosh
    // Launch every reel (both teams, all slots) in the same tick so they
    // visually start together.
    requestAnimationFrame(() => {
      redStrips?.forEach(spinReel);
      blueStrips?.forEach(spinReel);
    });
  }

  const delay = anySpin ? PREP_REEL_DURATION_MS + 200 : 0;
  setTimeout(() => {
    // Stale — host backed out of PREP (and possibly re-picked a different
    // game/map) while this reveal was still spinning.
    if (gen !== _prepGeneration || !sm.is(PHASE.PREP)) return;
    if (anySpin) playScreenSfx(hoverSfx); // landing click
    finishReveal(redPicked, bluePicked);
  }, delay);
}

let _prepCountdownInterval = null;

function startPrepCountdown(seconds) {
  clearInterval(_prepCountdownInterval);
  let remaining = seconds;
  const tick = () => {
    if (!sm.is(PHASE.PREP) || state.prepUnlocked || allPrepPlayersReady()) {
      clearInterval(_prepCountdownInterval);
      return;
    }
    prepCountdownEl.classList.remove('hidden');
    prepCountdownEl.textContent = `⏳ 還有 ${Math.max(0, remaining)} 秒未準備，時間到房主可以協助處理`;
    remaining -= 1;
  };
  tick();
  _prepCountdownInterval = setInterval(tick, 1000);
}

function renderPrepRoster() {
  prepRosterEl.innerHTML = '';
  const entries = Object.entries(state.activePlayers).filter(([, role]) => role === 'playing');
  entries.forEach(([id]) => {
    const ready = !!state.prepReady[id];
    const team = state.teams[id] ?? 'red';
    const row = document.createElement('div');
    row.className = 'prep-roster-row' + (ready ? ' ready' : '');
    row.innerHTML = `
      <span class="prep-roster-dot ${team}"></span>
      <span class="prep-roster-name">${state.players[id]?.name ?? '???'}</span>
      <span class="prep-roster-status">${ready ? '✅ 已準備' : '⏳ 準備中…'}</span>
    `;
    prepRosterEl.appendChild(row);
  });

  if (state.prepUnlocked) {
    clearInterval(_prepCountdownInterval);
    prepCountdownEl.classList.remove('hidden');
    prepCountdownEl.textContent = '⏰ 時間到！房主可以強制開始或重抽尚未準備的人';
  }
}

// ---------------------------------------------------------------------------
// How-to-play card — pops over every game start. The game module is already
// running (its BGM plays under the card) but update()/onInput() hold until
// the card is dismissed. Two formats, picked by whether the game defines
// tutorial.pages: the original text/single-comic card (mouse 開始！ or an
// auto-start countdown), or a flip-through picture book driven by anyone's
// controller A/B (see MSG.TUTORIAL_NEXT/PREV below).
// ---------------------------------------------------------------------------
const TUTORIAL_SECONDS = 15;
const tutorialOverlay    = document.getElementById('tutorial-overlay');
const tutorialClassicEl  = document.getElementById('tutorial-classic');
const tutorialStartBtn   = document.getElementById('tutorial-start-btn');
const tutorialCountdown  = document.getElementById('tutorial-countdown');
const tutorialPagedEl    = document.getElementById('tutorial-paged');
const tutorialPageImg    = document.getElementById('tutorial-page-img');
const tutorialPageCounter = document.getElementById('tutorial-page-counter');
const tutorialPagePrevBtn = document.getElementById('tutorial-page-prev');
const tutorialPageNextBtn = document.getElementById('tutorial-page-next');
let _tutorialTimer = null;

function showTutorial(game) {
  const tut = game.tutorial;
  if (!tut) return;
  state.tutorialActive = true;
  document.getElementById('tutorial-title').textContent = `${game.emoji} ${game.name}`;

  if (tut.pages?.length) {
    tutorialClassicEl.classList.add('hidden');
    tutorialPagedEl.classList.remove('hidden');
    tutorialOverlay.classList.remove('hidden');
    startTutorialPages(tut.pages);
    return;
  }

  tutorialPagedEl.classList.add('hidden');
  tutorialClassicEl.classList.remove('hidden');

  // Comic-strip tutorials replace the text sections entirely — the hub is
  // migrating game-by-game from text/emoji cards to drawn how-to-play comics.
  const comicImg = document.getElementById('tutorial-comic');
  const goalSection = document.getElementById('tutorial-goal').closest('.tut-section');
  const controlsSection = document.getElementById('tutorial-controls').closest('.tut-section');
  const hasComic = !!tut.comic;
  comicImg.classList.toggle('hidden', !hasComic);
  goalSection.classList.toggle('hidden', hasComic);
  controlsSection.classList.toggle('hidden', hasComic);
  if (hasComic) {
    comicImg.src = tut.comic;
    comicImg.alt = `${game.name} 玩法說明`;
  }

  document.getElementById('tutorial-goal').textContent = tut.goal ?? '';
  document.getElementById('tutorial-controls').innerHTML = (tut.controls ?? [])
    .map(c => `<div class="tut-row"><span class="tut-key">${c.key}</span><span>${c.text}</span></div>`)
    .join('');
  const tips = hasComic ? [] : (tut.tips ?? []);
  document.getElementById('tutorial-tips-section').classList.toggle('hidden', !tips.length);
  document.getElementById('tutorial-tips').innerHTML = tips
    .map(t => `<p class="tut-tip">・${t}</p>`)
    .join('');

  tutorialOverlay.classList.remove('hidden');

  let remain = TUTORIAL_SECONDS;
  tutorialCountdown.textContent = `${remain} 秒後自動開始`;
  clearInterval(_tutorialTimer);
  _tutorialTimer = setInterval(() => {
    remain -= 1;
    tutorialCountdown.textContent = `${remain} 秒後自動開始`;
    if (remain <= 0) hideTutorial();
  }, 1000);
}

function hideTutorial() {
  clearInterval(_tutorialTimer);
  _tutorialTimer = null;
  const wasPaged = !!_tutorialPages;
  clearTimeout(_tutorialPageTimer);
  _tutorialPageTimer = null;
  _tutorialPages = null;
  _tutorialControllerId = null;
  tutorialOverlay.classList.add('hidden');
  state.tutorialActive = false;
  if (wasPaged) broadcastTutorialPage(); // tells controllers the paging UI is gone (count → 0)
}

tutorialStartBtn.addEventListener('click', hideTutorial);
// Same two-stage SFX as the intro's 開始遊戲 button
tutorialStartBtn.addEventListener('mouseenter', () => playScreenSfx(hoverSfx));
tutorialStartBtn.addEventListener('click', () => playScreenSfx(clickSfx));

// ---------------------------------------------------------------------------
// How-to-play picture book — flip-through pages. Only ONE drawn player (the
// host if they're playing this round, otherwise whichever drawn player
// sorts first) controls it, using their own game's real A/B gamepad
// buttons (src/controller/main.js delegates .btn-a/.btn-b clicks to
// MSG.TUTORIAL_PREV/NEXT while they're the designated controller — see the
// comment there for why hijacking the real buttons is safe even though the
// game's own handler for them may also fire). A click on either side of the
// image here on the shared screen works too. 30s/page auto-advance safety
// net so the room can't stall forever if the designated controller is AFK;
// the last page auto-starts the same way the classic card's countdown does.
// ---------------------------------------------------------------------------
let _tutorialPages = null;
let _tutorialPageIndex = 0;
let _tutorialPageTimer = null;
let _tutorialControllerId = null;

function pickTutorialController() {
  const playingIds = Object.entries(state.activePlayers)
    .filter(([, role]) => role === 'playing')
    .map(([id]) => id);
  if (!playingIds.length) return null;
  const hostId = String(getHostId());
  return playingIds.includes(hostId) ? hostId : playingIds[0];
}

function startTutorialPages(pages) {
  _tutorialPages = pages;
  _tutorialPageIndex = 0;
  _tutorialControllerId = pickTutorialController();
  renderTutorialPage();
}

function renderTutorialPage() {
  tutorialPageImg.src = _tutorialPages[_tutorialPageIndex];
  tutorialPageCounter.textContent = `${_tutorialPageIndex + 1} / ${_tutorialPages.length}`;
  tutorialPagePrevBtn.disabled = _tutorialPageIndex === 0;
  broadcastTutorialPage();

  clearTimeout(_tutorialPageTimer);
  _tutorialPageTimer = setTimeout(tutorialPageNext, TUTORIAL_PAGE_AUTO_MS);
}

function tutorialPageNext() {
  if (!_tutorialPages) return;
  if (_tutorialPageIndex >= _tutorialPages.length - 1) {
    hideTutorial();
    return;
  }
  _tutorialPageIndex += 1;
  playScreenSfx(hoverSfx);
  renderTutorialPage();
}

function tutorialPagePrev() {
  if (!_tutorialPages || _tutorialPageIndex === 0) return;
  _tutorialPageIndex -= 1;
  playScreenSfx(hoverSfx);
  renderTutorialPage();
}

function broadcastTutorialPage() {
  airconsole.setCustomDeviceStateProperty(STATE_KEY.TUTORIAL_PAGE_COUNT, _tutorialPages?.length ?? 0);
  airconsole.setCustomDeviceStateProperty(STATE_KEY.TUTORIAL_PAGE, _tutorialPageIndex);
  airconsole.setCustomDeviceStateProperty(STATE_KEY.TUTORIAL_CONTROLLER, _tutorialControllerId);
}

// tutorialPageNext()/Prev() already play their own SFX (shared with the
// MSG.TUTORIAL_NEXT/PREV path below) — the click handlers just trigger them.
tutorialPageNextBtn.addEventListener('click', tutorialPageNext);
tutorialPagePrevBtn.addEventListener('click', tutorialPagePrev);

function endGame(winnerTeam) {
  // Games report their winner explicitly; anything else counts as a draw
  if (winnerTeam === 'red' || winnerTeam === 'blue') {
    state.teamScores[winnerTeam]++;
    state.lastWinner = winnerTeam;
  } else {
    state.lastWinner = null;
  }

  state.currentGame?.onEnd?.();
  airconsole.setActivePlayers(0);
  state.activePlayers = {};
  state.selectedMap = null;
  sm.toResults();
  broadcastState();
}

function handlePlayerInput(deviceId, data) {
  if (state.tutorialActive) return; // inputs hold until the how-to card closes
  if (state.currentGame?.onInput) state.currentGame.onInput(deviceId, data, state);
}

// ---------------------------------------------------------------------------
// Cheer emoji system (canvas layer drawn over game)
// ---------------------------------------------------------------------------
function addCheerEmoji(emoji, deviceId) {
  _cheerEmojis.push({
    emoji,
    x:          60 + Math.random() * (canvas.width - 120),
    y:          canvas.height - 10,
    vy:         -(100 + Math.random() * 80),
    vx:         (Math.random() - 0.5) * 40,
    wobble:     Math.random() * Math.PI * 2,
    wobbleSpd:  2 + Math.random() * 2,
    size:       Math.floor(canvas.height * 0.08),
    opacity:    1,
    age:        0,
    lifetime:   2.8,
  });
}

function tickAndDrawCheerEmojis(dt) {
  if (!_cheerEmojis.length) return;
  ctx.save();
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  for (let i = _cheerEmojis.length - 1; i >= 0; i--) {
    const em = _cheerEmojis[i];
    em.age    += dt;
    em.wobble += em.wobbleSpd * dt;
    em.y      += em.vy * dt;
    em.x      += em.vx * dt + Math.sin(em.wobble) * 0.5;
    em.opacity = Math.max(0, 1 - (em.age / em.lifetime) ** 1.8);
    if (em.age >= em.lifetime) { _cheerEmojis.splice(i, 1); continue; }
    ctx.globalAlpha = em.opacity;
    ctx.font        = `${em.size}px sans-serif`;
    ctx.fillText(em.emoji, em.x, em.y);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Phase change
// ---------------------------------------------------------------------------
function onPhaseChange(newPhase) {
  // BGM covers every menu phase; gameplay gets its own soundscape
  if (newPhase === PHASE.PLAYING) stopBgm();
  else if (viewIntro.classList.contains('hidden') || introVideo.muted) startBgm();

  updateHomeBtn();
  if (newPhase !== PHASE.PLAYING) hideTutorial(); // e.g. ↩ 選遊戲 mid-tutorial
  viewLobby.classList.toggle(    'hidden', newPhase !== PHASE.LOBBY);
  viewSelect.classList.toggle(   'hidden', newPhase !== PHASE.GAME_SELECT);
  viewMapSelect.classList.toggle('hidden', newPhase !== PHASE.MAP_SELECT);
  viewPrep.classList.toggle(     'hidden', newPhase !== PHASE.PREP);
  viewResults.classList.toggle(  'hidden', newPhase !== PHASE.RESULTS);

  if (newPhase === PHASE.LOBBY)       renderLobby();
  if (newPhase === PHASE.GAME_SELECT) renderGameSelect();
  if (newPhase === PHASE.MAP_SELECT)  renderMapSelect();
  if (newPhase === PHASE.RESULTS)     renderResults();
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
let lastTime = null;

function renderLoop(timestamp = 0) {
  requestAnimationFrame(renderLoop);
  const dtSec = cappedDt(lastTime === null ? 0 : timestamp - lastTime) / 1000;
  lastTime = timestamp;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (sm.is(PHASE.PLAYING)) {
    if (state.currentGame?.update && !state.tutorialActive) state.currentGame.update(dtSec, state);
    if (state._pendingMessages?.length) {
      for (const { deviceId, type, ...rest } of state._pendingMessages)
        airconsole.message(Number(deviceId), { type, ...rest });
      state._pendingMessages = [];
    }
    if (state.currentGame?.draw) state.currentGame.draw(ctx, canvas.width, canvas.height, state);
    else drawPlayingPlaceholder();
    tickAndDrawCheerEmojis(dtSec);
  }
}

function drawPlayingPlaceholder() {
  const { width: w, height: h } = canvas;
  ctx.fillStyle    = '#ffe066';
  ctx.font         = `bold ${Math.floor(w * 0.04)}px monospace`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(state.currentGame?.name ?? 'PLAYING', w / 2, h / 2);
}

// ---------------------------------------------------------------------------
// Lobby UI
// ---------------------------------------------------------------------------
function renderLobby() {
  const ids      = Object.keys(state.players);
  const count    = ids.length;
  const masterId = String(getHostId());

  playerCountEl.textContent = `${count} 位玩家已加入`;

  teamRedListEl.innerHTML  = '';
  teamBlueListEl.innerHTML = '';

  // Host always renders first in their team's roster (stable sort keeps
  // everyone else in join order).
  const orderedIds = [...ids].sort((a, b) =>
    (a === masterId ? 0 : 1) - (b === masterId ? 0 : 1));

  orderedIds.forEach(id => {
    const p    = state.players[id];
    const team = state.teams[id];
    const card = document.createElement('div');
    card.className   = 'player-card ' + (team === 'red' ? 'player-card-red' : 'player-card-blue');
    if (id === masterId) card.classList.add('player-card-host');
    card.textContent = p.name + (id === masterId ? '（房主）' : '');
    if (team === 'red') teamRedListEl.appendChild(card);
    else                teamBlueListEl.appendChild(card);
  });

  // Density tier per roster size so ~20 players still fit on screen:
  // single column while roomy, then 2 / 3 columns with smaller cards.
  const tier = n => (n <= 6 ? 'roomy' : n <= 12 ? 'medium' : 'dense');
  teamRedListEl.dataset.size  = tier(teamRedListEl.children.length);
  teamBlueListEl.dataset.size = tier(teamBlueListEl.children.length);

  lobbyHintEl.textContent =
    count === 0 ? '等待玩家加入…' :
    count === 1 ? '至少需要 2 位玩家才能開始' :
                  '房主：準備好了按 START 開始！';
}

// ---------------------------------------------------------------------------
// Game Select UI
// ---------------------------------------------------------------------------
function renderGameSelect() {
  const counts = teamCounts(state.teams);
  document.getElementById('game-select-subtitle').textContent =
    `🔴 ${counts.red} vs 🔵 ${counts.blue}  —  Host is picking…`;

  // Running team score — same painted-pill treatment as the results screen
  document.getElementById('game-select-scores').innerHTML = `
    <div class="cum-score red">🔴 <span class="cum-num">${state.teamScores.red}</span></div>
    <div class="cum-divider">勝</div>
    <div class="cum-score blue"><span class="cum-num">${state.teamScores.blue}</span> 🔵</div>
  `;

  gameGridEl.innerHTML = '';
  randomPickBtn.disabled = false;

  GAMES.forEach(game => {
    const card = document.createElement('div');
    // Cover art has the title AND its own frame baked in, so it IS the
    // card — has-cover strips the cream signboard chrome entirely.
    card.className = game.cover ? 'game-card has-cover' : 'game-card';
    card.style.setProperty('--game-color', game.color);
    card.innerHTML = game.cover
      ? `<img class="game-cover" src="${game.cover}" alt="${game.name}" />`
      : `
      <span class="game-emoji">${game.emoji}</span>
      <span class="game-name">${game.name}</span>
    `;
    // The shared screen is mouse-driven too — clicking a card picks the
    // game directly, same SFX pairing as the 開始遊戲 button.
    card.addEventListener('mouseenter', () => playScreenSfx(hoverSfx));
    card.addEventListener('click', () => {
      playScreenSfx(clickSfx);
      handleGameSelected(game.id);
    });
    gameGridEl.appendChild(card);
  });

  // Games with cover art but no mechanics yet — real thumbnail, but inert
  // and flagged with a corner ribbon instead of the blank "❓" placeholder.
  UPCOMING_GAMES.forEach(game => {
    const card = document.createElement('div');
    card.className = 'game-card has-cover upcoming';
    card.innerHTML = `
      <img class="game-cover" src="${game.cover}" alt="${game.name}" />
      <span class="upcoming-badge">即將推出</span>
    `;
    gameGridEl.appendChild(card);
  });

  // Fill the rest of the planned lineup with "coming soon" placeholders so
  // the grid reads as "more on the way" instead of an unbalanced last row.
  const comingSoonCount = Math.max(0, TOTAL_GAME_SLOTS - GAMES.length - UPCOMING_GAMES.length);
  for (let i = 0; i < comingSoonCount; i++) {
    const card = document.createElement('div');
    card.className = 'game-card coming-soon';
    card.innerHTML = `
      <span class="game-emoji">❓</span>
      <span class="game-name">敬請期待</span>
    `;
    gameGridEl.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// 🎲 隨機開始 — chase-light "bingo machine" spin across the real game cards,
// landing on a randomly chosen game before actually starting it.
// ---------------------------------------------------------------------------
randomPickBtn.addEventListener('mouseenter', () => playScreenSfx(hoverSfx));
randomPickBtn.addEventListener('click', () => {
  if (!sm.is(PHASE.GAME_SELECT) || randomPickBtn.disabled) return;
  playScreenSfx(clickSfx);
  spinRandomPick();
});

function spinRandomPick() {
  // Must match GAMES exactly, in order — .upcoming previews have cover art
  // too but aren't real games, so a plain :not(.coming-soon) selector would
  // wrongly include them and desync the index from GAMES[winnerIndex].
  const cardEls = Array.from(gameGridEl.querySelectorAll('.game-card:not(.coming-soon):not(.upcoming)'));
  if (!cardEls.length) return;
  randomPickBtn.disabled = true;

  const n = cardEls.length;
  const winnerIndex = Math.floor(Math.random() * n);
  const rounds = 3; // full loops around the grid before landing
  const totalTicks = winnerIndex + 1 + rounds * n;
  const MIN_DELAY_MS = 70;
  const MAX_DELAY_MS = 420;

  let tick = 0;
  let litEl = null;

  function step() {
    if (!sm.is(PHASE.GAME_SELECT)) return; // left the screen mid-spin

    if (litEl) litEl.classList.remove('lit');
    litEl = cardEls[tick % n];
    litEl.classList.add('lit');
    playScreenSfx(hoverSfx);
    tick++;

    if (tick >= totalTicks) {
      setTimeout(() => {
        randomPickBtn.disabled = false;
        if (!sm.is(PHASE.GAME_SELECT)) return;
        playScreenSfx(clickSfx);
        handleGameSelected(GAMES[winnerIndex].id);
        // Rejected (e.g. team-size requirement not met) — still here, so
        // clear the landed highlight instead of leaving it stuck lit.
        if (sm.is(PHASE.GAME_SELECT)) litEl.classList.remove('lit');
      }, 700);
      return;
    }

    // Ease the tick interval from fast to slow, like a wheel spinning down.
    const progress = tick / totalTicks;
    const delay = MIN_DELAY_MS + (MAX_DELAY_MS - MIN_DELAY_MS) * Math.pow(progress, 3);
    setTimeout(step, delay);
  }

  step();
}

// ---------------------------------------------------------------------------
// Map Select UI
// ---------------------------------------------------------------------------
function renderMapSelect() {
  const game = state.currentGame;
  if (!game) return;
  mapSelectTitleEl.textContent = `${game.emoji} ${game.name}`;

  mapGridEl.innerHTML = '';
  const maps = state.activeMaps ?? game.maps ?? [];
  maps.forEach((map, i) => {
    const card = document.createElement('div');
    const disabled = map.enabled === false;
    card.className = disabled ? 'map-card disabled' : 'map-card';
    card.innerHTML = `
      <span class="map-name">${map.name}</span>
      <span class="map-desc">${map.description}</span>
    `;
    if (!disabled) {
      // Mouse flow continues through map select, so the game can actually
      // be entered from the screen alone.
      card.addEventListener('mouseenter', () => playScreenSfx(hoverSfx));
      card.addEventListener('click', () => {
        playScreenSfx(clickSfx);
        handleMapSelected(i);
      });
    }
    mapGridEl.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// Results UI
// ---------------------------------------------------------------------------
function renderResults() {
  const w = state.lastWinner;
  const red  = state.teamScores.red;
  const blue = state.teamScores.blue;

  scoreboardEl.innerHTML = `
    <div class="cumulative-scores">
      <div class="cum-score red">🔴 <span class="cum-num">${red}</span></div>
      <div class="cum-divider">勝</div>
      <div class="cum-score blue"><span class="cum-num">${blue}</span> 🔵</div>
    </div>
    <div class="last-winner">
      ${w ? `本局：${w === 'red' ? '🔴 紅隊' : '🔵 藍隊'} 獲勝 👑` : '本局：平手'}
    </div>
  `;

  resultsHintEl.textContent = '房主：繼續遊戲或回到大廳';
}

// ---------------------------------------------------------------------------
// Canvas resize
// ---------------------------------------------------------------------------
function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
