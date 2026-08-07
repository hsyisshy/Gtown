import './style.css';
import { StateMachine } from '../shared/state-machine.js';
import { cappedDt } from '../shared/airconsole-wrapper.js';
import { PHASE, MSG, STATE_KEY, MAX_PLAYERS, TEAM_COLOR, TOTAL_GAME_SLOTS } from '../shared/constants.js';
import { GAMES, getGame, getGameList } from '../games/registry.js';
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
  activePlayers: {},     // { [deviceId]: 'playing' | 'watching' }
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
const viewResults        = document.getElementById('view-results');
const playerCountEl      = document.getElementById('player-count');
const teamRedListEl      = document.getElementById('team-red-list');
const teamBlueListEl     = document.getElementById('team-blue-list');
const gameGridEl         = document.getElementById('game-grid');
const mapGridEl          = document.getElementById('map-grid');
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
let SFX_VOLUME = _loadVolume('setting_sfx_volume', 0.7);

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

    case MSG.SELECT_MAP: {
      if (deviceId !== masterId) return;
      if (!sm.is(PHASE.MAP_SELECT)) return;
      handleMapSelected(data.mapIndex);
      break;
    }

    case MSG.CHEER: {
      if (!sm.is(PHASE.PLAYING)) return;
      if (data.emoji) addCheerEmoji(data.emoji, deviceId);
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
      if (sm.is(PHASE.RESULTS)) {
        // Fresh randomized split for the new set of rounds — players can
        // then self-serve swap with the switch-team button.
        state.teams = fillMissingTeams({}, Object.keys(state.players));
        state.teamScores = { red: 0, blue: 0 };
        state.playerPlayCounts = {};
        airconsole.setActivePlayers(0);
        sm.toLobby();
        broadcastState();
      } else if (sm.is(PHASE.GAME_SELECT) || sm.is(PHASE.MAP_SELECT)) {
        // Host backed out before the round started — no round was played,
        // so just return to the lobby with teams left exactly as they were.
        state.currentGame = null;
        state.selectedMap = null;
        sm.toLobby();
        broadcastState();
      } else if (sm.is(PHASE.PLAYING)) {
        // Host aborts the round mid-game: tear the game down without
        // crediting scores or a winner, keep teams as they were.
        state.currentGame?.onEnd?.();
        state.currentGame = null;
        airconsole.setActivePlayers(0);
        state.activePlayers = {};
        state.selectedMap = null;
        sm.toLobby();
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
      startGame();
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

  startGame();
}

function handleMapSelected(mapIndex) {
  const maps = state.activeMaps ?? state.currentGame?.maps ?? [];
  const map = maps[mapIndex];
  if (!map || map.enabled === false) return;   // ignore out-of-range / disabled
  state.selectedMap = mapIndex;
  startGame();
}

function startGame() {
  const game = state.currentGame;
  if (!game) return;
  // Per-team headcount can depend on the picked mode (e.g. 1v1 vs 2v2).
  const ppt = game.playersPerTeamFor?.(state.selectedMap) ?? game.playersPerTeam ?? 1;

  const redIds  = Object.entries(state.teams).filter(([, t]) => t === 'red').map(([id]) => id);
  const blueIds = Object.entries(state.teams).filter(([, t]) => t === 'blue').map(([id]) => id);

  const redPicked  = drawWeightedPlayers(redIds, ppt);
  const bluePicked = drawWeightedPlayers(blueIds, ppt);
  const allPicked  = [...redPicked, ...bluePicked];

  state.activePlayers = {};
  Object.keys(state.players).forEach(id => {
    state.activePlayers[id] = allPicked.includes(id) ? 'playing' : 'watching';
  });

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
// How-to-play card — pops over every game start. The game module is already
// running (its BGM plays under the card) but update()/onInput() hold until
// the card is dismissed: mouse 開始！, or the auto-start countdown.
// ---------------------------------------------------------------------------
const TUTORIAL_SECONDS = 15;
const tutorialOverlay   = document.getElementById('tutorial-overlay');
const tutorialStartBtn  = document.getElementById('tutorial-start-btn');
const tutorialCountdown = document.getElementById('tutorial-countdown');
let _tutorialTimer = null;

function showTutorial(game) {
  const tut = game.tutorial;
  if (!tut) return;
  state.tutorialActive = true;

  document.getElementById('tutorial-title').textContent = `${game.emoji} ${game.name}`;

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
  tutorialOverlay.classList.add('hidden');
  state.tutorialActive = false;
}

tutorialStartBtn.addEventListener('click', hideTutorial);
// Same two-stage SFX as the intro's 開始遊戲 button
tutorialStartBtn.addEventListener('mouseenter', () => playScreenSfx(hoverSfx));
tutorialStartBtn.addEventListener('click', () => playScreenSfx(clickSfx));

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
  if (newPhase !== PHASE.PLAYING) hideTutorial(); // e.g. ↩ 大廳 mid-tutorial
  viewLobby.classList.toggle(    'hidden', newPhase !== PHASE.LOBBY);
  viewSelect.classList.toggle(   'hidden', newPhase !== PHASE.GAME_SELECT);
  viewMapSelect.classList.toggle('hidden', newPhase !== PHASE.MAP_SELECT);
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

  // Slot 1: "random pick" meta-card — not a game, skips manual selection by
  // jumping straight into a randomly chosen game from the current lineup.
  const randomCard = document.createElement('div');
  randomCard.className = 'game-card has-cover random-pick';
  randomCard.innerHTML = `<img class="game-cover" src="random_start_cover.png" alt="隨機開始" />`;
  randomCard.addEventListener('mouseenter', () => playScreenSfx(hoverSfx));
  randomCard.addEventListener('click', () => {
    playScreenSfx(clickSfx);
    const pick = GAMES[Math.floor(Math.random() * GAMES.length)];
    handleGameSelected(pick.id);
  });
  gameGridEl.appendChild(randomCard);

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

  // Fill the rest of the planned lineup with "coming soon" placeholders so
  // the grid reads as "more on the way" instead of an unbalanced last row.
  // -1 accounts for the random-pick card occupying slot 1.
  const comingSoonCount = Math.max(0, TOTAL_GAME_SLOTS - GAMES.length - 1);
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
