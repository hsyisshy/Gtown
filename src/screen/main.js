import './style.css';
import { StateMachine } from '../shared/state-machine.js';
import { cappedDt } from '../shared/airconsole-wrapper.js';
import { PHASE, MSG, STATE_KEY, MAX_PLAYERS, TEAM_COLOR, TOTAL_GAME_SLOTS, PREP_REEL_DURATION_MS, PREP_READY_TIMEOUT_MS, TUTORIAL_READY_TIMEOUT_MS, BGM_RELATIVE_GAIN } from '../shared/constants.js';
import { GAMES, UPCOMING_GAMES, getGame, getGameList } from '../games/registry.js';
import { fillMissingTeams, toggleTeam, teamCounts } from '../shared/teams.js';
import { truncateName } from '../shared/nameDisplay.js';
import { preloadImageUrls } from '../shared/assetPreload.js';

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
  lastRoundScore: null,  // { label, red, blue } | null — the game's own final score, see endGame()
  initialized: false,
  currentGame: null,
  tutorialActive: false, // how-to-play card is up — game updates/inputs hold
  tutorialPages: null,   // array of image paths | null — broadcast so every playing device can browse its own copy
  tutorialReady: {},     // { [deviceId]: true } — playing devices who've finished their own copy
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

// The host never carries a team assignment (they run the room, they never
// play) — every place that used to fill state.teams from "everyone
// connected" needs to fill from this instead, or the "assign anyone
// missing a team" safety nets would immediately re-add the host.
function assignableIds() {
  const hostId = String(getHostId());
  return Object.keys(state.players).filter((id) => id !== hostId);
}

// Defensive invariant: call after anything that could change who the host
// is (connect, disconnect, host transfer) — strips a team assignment the
// current host might be carrying from a moment ago when they were still a
// regular player.
function stripHostFromTeams() {
  const hostId = getHostId();
  if (state.teams[hostId] !== undefined) delete state.teams[hostId];
}

const sm = new StateMachine(onPhaseChange);

// Cheer emojis — rendered on canvas, not in DOM
const _cheerEmojis = [];

// Cheer danmaku (scrolling text) — same idea, own lane-tracking state so
// consecutive messages in a lane don't stack on top of each other.
const _cheerDanmaku = [];
const _lastCheerTextAt = {}; // { [deviceId]: ms } — per-device throttle, independent of the controller's own cooldown

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
const hostCardEl         = document.getElementById('host-card');
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

// The only place BGM_VOLUME should reach an actual <audio> element — see
// BGM_RELATIVE_GAIN's comment in shared/constants.js.
function bgmGain() { return BGM_VOLUME * BGM_RELATIVE_GAIN; }

function startBgm() {
  _bgmShouldPlay = true;
  if (!bgm.paused) { fadeBgm(bgmGain()); return; }
  // Autoplay policy may reject before the page has a user gesture —
  // retry on the next tap/click, same fallback as the intro video.
  bgm.play().then(() => fadeBgm(bgmGain())).catch(() => {
    document.addEventListener('pointerdown', () => {
      bgm.play().then(() => fadeBgm(bgmGain())).catch(() => {});
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
introVideo.volume = bgmGain(); // the intro soundtrack is "背景音樂" too

bgmSlider.addEventListener('input', () => {
  BGM_VOLUME = bgmSlider.value / 100;
  localStorage.setItem('setting_bgm_volume', String(BGM_VOLUME));
  introVideo.volume = bgmGain();
  // In-game BGMs (shared/loopingBgm.js) listen for this to retarget live —
  // sent as the raw slider fraction; loopingBgm.js applies its own
  // BGM_RELATIVE_GAIN when it actually reaches an <audio> element.
  window.dispatchEvent(new CustomEvent('bgm-volume-change', { detail: BGM_VOLUME }));
  // Quick retarget while a menu wants BGM, so the slider feels live instead
  // of easing over the slow 2.2s menu fade. A previous drag to 0 pauses the
  // element outright, so dragging back up must also resume playback. Silent
  // phases (gameplay) just keep the new value for the next startBgm().
  if (_bgmShouldPlay) {
    if (bgm.paused) bgm.play().catch(() => {});
    fadeBgm(bgmGain(), 200);
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

// PREP's slot-machine reel spin (see runReveal/spinReel) — a dedicated
// spin+land sound instead of reusing the generic click, played once when
// the reel(s) start scrolling. public/drawppl.mp3 is trimmed to its last
// ~3.5s (the source clip's climax + decay tail, cut from a ~6s original
// with a long quiet buildup at the front that didn't suit a reel spin) —
// see PREP_REEL_DURATION_MS in shared/constants.js, tuned to this trimmed
// length so the visual landing and the sound's natural end line up instead
// of one cutting the other off.
const reelSpinSfx = new Audio('drawppl.mp3');
reelSpinSfx.preload = 'auto';

function applyScreenSfxVolume() {
  clickSfx.volume = SFX_VOLUME;
  hoverSfx.volume = SFX_VOLUME * 0.7;
  reelSpinSfx.volume = SFX_VOLUME;
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
  // Cover art pop-in on first entering the game-select grid — not the "fast
  // input outruns the asset" bug the per-game preload() fixes, just the
  // same DOM-<img> loading everyone already knows, front-loaded early.
  preloadImageUrls([...GAMES, ...UPCOMING_GAMES].map(g => g.cover).filter(Boolean));
};

airconsole.onConnect = function (deviceId) {
  const name = airconsole.getNickname(deviceId) || `P${Object.keys(state.players).length + 1}`;
  state.players[deviceId] = { name, score: 0 };
  // Only the new player gets assigned (to whichever team is smaller) —
  // existing players (and any manual switch-team swaps) are left alone.
  // Excludes the host: matters for the very first connection, which
  // AirConsole auto-promotes to master.
  state.teams = fillMissingTeams(state.teams, assignableIds());
  stripHostFromTeams();
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
  // A host disconnect can fall back to a new AirConsole master who was a
  // regular (team-having) player a moment ago — strip it.
  stripHostFromTeams();
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
      // Need at least 2 PLAYABLE (non-host) participants — the host alone
      // never counts toward a team.
      const ids = assignableIds();
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
      else if (data.text) addCheerDanmaku(data.text, deviceId);
      break;
    }

    case MSG.TUTORIAL_READY: {
      if (!sm.is(PHASE.PLAYING)) return;
      handleTutorialReady(deviceId);
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
      const oldHostId = masterId; // stepping down — rejoins a team below
      delete state.teams[targetId];                              // new host must not carry a team
      state.teams = fillMissingTeams(state.teams, [oldHostId]);   // old host rejoins the smaller team
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
  airconsole.setCustomDeviceStateProperty(STATE_KEY.TUTORIAL_PAGES, state.tutorialPages);
  airconsole.setCustomDeviceStateProperty(STATE_KEY.TUTORIAL_READY, state.tutorialReady);
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

  // Fire-and-forget as early as possible — PREP's reveal spin + ready-roster
  // wait, then the how-to-play card, all give this a multi-second head start
  // before onStart() actually needs the assets. Each game's onStart() awaits
  // its own preload() too, so this is purely an optimization, never required
  // for correctness — a game with no preload() (nothing to front-load, or
  // it wires it up on its own like painting-sticker's per-match painting
  // pick) just no-ops here.
  game.preload?.();

  // Same head start for the how-to-play card's own image(s). The two tutorial
  // formats are rendered on different devices: a single `comic` is drawn on
  // THIS screen (showTutorial()'s classic branch), so preload it here; a
  // paged reader is browsed on each PLAYING phone's own copy instead (see
  // STATE_KEY.TUTORIAL_PRELOAD below) — preloading `pages` here would just
  // waste the screen's own bandwidth on images it never displays.
  if (game.tutorial?.comic) preloadImageUrls([game.tutorial.comic]);

  // Broadcast paged-tutorial image paths to every connected phone right now,
  // well before beginMatch()'s showTutorial() actually needs them — same
  // "PREP window as free head start" idea, just for a device this screen
  // can't preload on behalf of. Purely a hint: no controller UI reacts to
  // this key, it only triggers a background preload (see controller/main.js).
  airconsole.setCustomDeviceStateProperty(STATE_KEY.TUTORIAL_PRELOAD, game.tutorial?.pages ?? null);

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
  // Row height is now fluid (percentage of .reel-window, itself sized by
  // flex+clamp so 1-3 reels never overflow — see style.css), so it's
  // measured off the live DOM instead of a hardcoded constant that would
  // drift out of sync with it. offsetHeight ignores the transform we're
  // about to animate, so this reads the row's true layout height.
  const rowH = strip.firstElementChild?.offsetHeight || 0;
  const targetY = -(REEL_FILLER_COUNT - 1) * rowH;
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
      msg.textContent = pickedIds.length ? '全隊上場！' : '（本隊無人可上場）';
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
    playScreenSfx(reelSpinSfx); // slot-machine spin+land sound
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

// One box per team (mirrors the reel boxes above it) instead of a flat pile
// of individual pills — a big roster used to wrap across several rows and
// push the later ones off the bottom of this un-scrollable overlay. Shared
// by PREP's ready-to-play roster and the tutorial's read-the-comic roster —
// same shape (grouped by team, each member either done or still waiting),
// just a different "done" predicate and status wording.
function buildRosterTeamBox(team, label, ids, isReady, readyText, pendingText) {
  const box = document.createElement('div');
  box.className = `prep-roster-team-box team-${team}`;

  const header = document.createElement('div');
  header.className = 'prep-roster-team-header';
  header.textContent = label;
  box.appendChild(header);

  const list = document.createElement('div');
  list.className = 'prep-roster-list';
  const members = ids.filter(id => (state.teams[id] ?? 'red') === team);
  if (!members.length) {
    const empty = document.createElement('div');
    empty.className = 'prep-roster-empty';
    empty.textContent = '（本隊無人上場）';
    list.appendChild(empty);
  } else {
    members.forEach(id => {
      const ready = isReady(id);
      const row = document.createElement('div');
      row.className = 'prep-roster-member' + (ready ? ' ready' : '');
      row.innerHTML = `
        <span class="prep-roster-member-name">${state.players[id]?.name ?? '???'}</span>
        <span class="prep-roster-member-status">${ready ? readyText : pendingText}</span>
      `;
      list.appendChild(row);
    });
  }
  box.appendChild(list);
  return box;
}

function renderPrepRoster() {
  prepRosterEl.innerHTML = '';
  const ids = Object.entries(state.activePlayers).filter(([, role]) => role === 'playing').map(([id]) => id);
  const isReady = id => !!state.prepReady[id];
  prepRosterEl.appendChild(buildRosterTeamBox('red',  '🔴 紅隊', ids, isReady, '已準備', '準備中…'));
  prepRosterEl.appendChild(buildRosterTeamBox('blue', '🔵 藍隊', ids, isReady, '已準備', '準備中…'));

  if (state.prepUnlocked) {
    clearInterval(_prepCountdownInterval);
    prepCountdownEl.classList.remove('hidden');
    prepCountdownEl.textContent = '時間到！房主可以強制開始或重抽尚未準備的人';
  }
}

// ---------------------------------------------------------------------------
// How-to-play card — pops over every game start. The game module is already
// running (its BGM plays under the card) but update()/onInput() hold until
// the card is dismissed. Two formats, picked by whether the game defines
// tutorial.pages: the original text/single-comic card (mouse 開始！ or an
// auto-start countdown), or a flip-through picture book that every playing
// device browses independently on its own phone (see the roster section
// below).
// ---------------------------------------------------------------------------
const TUTORIAL_SECONDS = 15;
const tutorialOverlay    = document.getElementById('tutorial-overlay');
const tutorialPanelEl    = document.getElementById('tutorial-panel');
const tutorialClassicEl  = document.getElementById('tutorial-classic');
const tutorialStartBtn   = document.getElementById('tutorial-start-btn');
const tutorialCountdown  = document.getElementById('tutorial-countdown');
const tutorialPagedEl    = document.getElementById('tutorial-paged');
const tutorialPagesEl    = document.getElementById('tutorial-pages');
const tutorialRosterEl   = document.getElementById('tutorial-roster');
const tutorialRosterCountdownEl = document.getElementById('tutorial-roster-countdown');
let _tutorialTimer = null;

function showTutorial(game) {
  const tut = game.tutorial;
  if (!tut) return;
  state.tutorialActive = true;
  document.getElementById('tutorial-title').textContent = game.name;
  tutorialPanelEl.classList.toggle('tutorial-panel--paged', !!tut.pages?.length);

  if (tut.pages?.length) {
    tutorialClassicEl.classList.add('hidden');
    tutorialPagedEl.classList.remove('hidden');
    tutorialOverlay.classList.remove('hidden');
    startTutorialRoster(tut.pages);
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
  clearTimeout(_tutorialReadyTimer);
  _tutorialReadyTimer = null;
  clearInterval(_tutorialCountdownInterval);
  _tutorialCountdownInterval = null;
  state.tutorialPages = null;
  state.tutorialReady = {};
  tutorialOverlay.classList.add('hidden');
  state.tutorialActive = false;
  broadcastState(); // tells controllers the paging UI is gone (pages → null)
}

tutorialStartBtn.addEventListener('click', hideTutorial);
// Same two-stage SFX as the intro's 開始遊戲 button
tutorialStartBtn.addEventListener('mouseenter', () => playScreenSfx(hoverSfx));
tutorialStartBtn.addEventListener('click', () => playScreenSfx(clickSfx));

// ---------------------------------------------------------------------------
// How-to-play picture book — every playing device flips through its OWN copy
// at its own pace, using its own game's real A/B gamepad buttons (see
// src/controller/main.js) — doubles as button practice. Since there's no
// single synced page anymore, the shared screen shows a ready-roster instead
// (same idea as the PREP ready check): each playing device reports in via
// MSG.TUTORIAL_READY once it's flipped through to the end, and the match
// starts once everyone's in or TUTORIAL_READY_TIMEOUT_MS elapses, whichever
// comes first.
// ---------------------------------------------------------------------------
let _tutorialReadyTimer = null;
let _tutorialCountdownInterval = null;

function renderTutorialPages(pages) {
  tutorialPagesEl.innerHTML = '';
  tutorialPagesEl.style.setProperty('--tutorial-page-count', pages.length);
  pages.forEach((src, i) => {
    const img = document.createElement('img');
    img.className = 'tutorial-page';
    img.src = src;
    img.alt = `教學漫畫第 ${i + 1} 頁`;
    tutorialPagesEl.appendChild(img);
  });
}

function startTutorialRoster(pages) {
  state.tutorialPages = pages;
  state.tutorialReady = {};
  broadcastState();
  renderTutorialPages(pages);
  renderTutorialRoster();

  if (tutorialPlayingIds().length === 0) { hideTutorial(); return; } // nobody to wait on

  clearTimeout(_tutorialReadyTimer);
  _tutorialReadyTimer = setTimeout(() => {
    if (!state.tutorialActive) return;
    hideTutorial();
  }, TUTORIAL_READY_TIMEOUT_MS);

  startTutorialReadyCountdown(TUTORIAL_READY_TIMEOUT_MS / 1000);
}

function tutorialPlayingIds() {
  return Object.entries(state.activePlayers)
    .filter(([, role]) => role === 'playing')
    .map(([id]) => id);
}

function allTutorialPlayersReady() {
  const ids = tutorialPlayingIds();
  return ids.length === 0 || ids.every(id => state.tutorialReady[id]);
}

function renderTutorialRoster() {
  tutorialRosterEl.innerHTML = '';
  const ids = tutorialPlayingIds();
  const isReady = id => !!state.tutorialReady[id];
  tutorialRosterEl.appendChild(buildRosterTeamBox('red',  '🔴 紅隊', ids, isReady, '看完了', '閱讀中…'));
  tutorialRosterEl.appendChild(buildRosterTeamBox('blue', '🔵 藍隊', ids, isReady, '看完了', '閱讀中…'));
}

function handleTutorialReady(deviceId) {
  if (!state.tutorialPages?.length) return;
  const id = String(deviceId);
  if ((state.activePlayers ?? {})[id] !== 'playing') return;
  state.tutorialReady[id] = true;
  broadcastState();
  renderTutorialRoster();
  if (allTutorialPlayersReady()) hideTutorial();
}

function startTutorialReadyCountdown(seconds) {
  clearInterval(_tutorialCountdownInterval);
  let remaining = seconds;
  const tick = () => {
    if (!state.tutorialActive || allTutorialPlayersReady()) {
      clearInterval(_tutorialCountdownInterval);
      tutorialRosterCountdownEl.classList.add('hidden');
      return;
    }
    tutorialRosterCountdownEl.classList.remove('hidden');
    tutorialRosterCountdownEl.textContent = `還有 ${Math.max(0, remaining)} 秒，時間到會自動開始比賽`;
    remaining -= 1;
  };
  tick();
  _tutorialCountdownInterval = setInterval(tick, 1000);
}

// roundScore is optional: { label, red, blue } — each game's own final
// score in whatever format makes sense for it (points, %, coins, ...),
// pre-formatted as display strings since every game's unit is different.
// Games that don't pass one just skip that line on the results screen.
function endGame(winnerTeam, roundScore) {
  // Games report their winner explicitly; anything else counts as a draw
  if (winnerTeam === 'red' || winnerTeam === 'blue') {
    state.teamScores[winnerTeam]++;
    state.lastWinner = winnerTeam;
  } else {
    state.lastWinner = null;
  }
  state.lastRoundScore = roundScore ?? null;

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
// Cheer emoji system (canvas layer drawn over game) — the six picker
// buttons on the controller (src/controller/main.js's .cheer-btn handler)
// send one of these ids; the matching illustrated sticker (public/emoji/)
// floats up here instead of a plain unicode glyph.
// ---------------------------------------------------------------------------
const CHEER_STICKER_SRC = {
  fire:  'emoji/1.jpg',
  like:  'emoji/2.jpg',
  cheer: 'emoji/3.jpg',
  party: 'emoji/4.jpg',
  star:  'emoji/5.jpg',
  love:  'emoji/6.jpg',
};
const CHEER_STICKER_IMAGES = Object.fromEntries(
  Object.entries(CHEER_STICKER_SRC).map(([id, src]) => {
    const img = new Image();
    img.src = src;
    return [id, img];
  })
);

function addCheerEmoji(stickerId, deviceId) {
  const img = CHEER_STICKER_IMAGES[stickerId];
  if (!img) return; // unknown id (stale client) — ignore rather than draw nothing forever
  _cheerEmojis.push({
    img,
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
  for (let i = _cheerEmojis.length - 1; i >= 0; i--) {
    const em = _cheerEmojis[i];
    em.age    += dt;
    em.wobble += em.wobbleSpd * dt;
    em.y      += em.vy * dt;
    em.x      += em.vx * dt + Math.sin(em.wobble) * 0.5;
    em.opacity = Math.max(0, 1 - (em.age / em.lifetime) ** 1.8);
    if (em.age >= em.lifetime) { _cheerEmojis.splice(i, 1); continue; }
    if (!em.img.complete || !em.img.naturalWidth) continue; // still decoding — skip this frame

    const r = em.size / 2;
    ctx.save();
    ctx.globalAlpha = em.opacity;
    ctx.translate(em.x, em.y);
    // Source stickers are opaque square JPGs (no alpha channel) — clip to
    // a circle so it reads as a round sticker badge instead of a white
    // square patch flying across the screen.
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(em.img, -r, -r, em.size, em.size);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Cheer danmaku system (scrolling "(name)：text" bullets, own canvas layer)
// ---------------------------------------------------------------------------
const CHEER_TEXT_MAX_CHARS  = 20;   // defensive re-clip — controller already caps via maxlength
const CHEER_TEXT_MIN_GAP_MS = 1000; // per-device throttle, independent of the controller's own cooldown
const DANMAKU_SPEED  = 140; // px/sec, leftward
const DANMAKU_LANES  = 5;
const DANMAKU_GAP_PX = 40;  // min horizontal gap enforced between successive bullets sharing a lane

let _danmakuClock = 0; // local clock driven by dt, not wall-clock — stays in lockstep with the render loop
const _danmakuLaneFreeAt = new Array(DANMAKU_LANES).fill(0);

function pickDanmakuLane(textWidth) {
  // Least-recently-scheduled lane — not a strict collision guarantee under
  // heavy simultaneous cheering, but self-corrects and never blocks a send.
  let best = 0;
  for (let i = 1; i < DANMAKU_LANES; i++) {
    if (_danmakuLaneFreeAt[i] < _danmakuLaneFreeAt[best]) best = i;
  }
  _danmakuLaneFreeAt[best] = Math.max(_danmakuLaneFreeAt[best], _danmakuClock) + (textWidth + DANMAKU_GAP_PX) / DANMAKU_SPEED;
  return best;
}

function addCheerDanmaku(text, deviceId) {
  const now = performance.now();
  if (now - (_lastCheerTextAt[deviceId] ?? -Infinity) < CHEER_TEXT_MIN_GAP_MS) return;
  const trimmed = String(text).trim().slice(0, CHEER_TEXT_MAX_CHARS);
  if (!trimmed) return;
  _lastCheerTextAt[deviceId] = now;

  const name  = truncateName(state.players[deviceId]?.name ?? '???');
  const label = `${name}：${trimmed}`;
  const color = TEAM_COLOR[state.teams?.[deviceId]] ?? '#ffe555';

  const fontSize = Math.floor(canvas.height * 0.032);
  ctx.font = `700 ${fontSize}px "Noto Sans TC", sans-serif`;
  const width = ctx.measureText(label).width;

  _cheerDanmaku.push({ label, color, width, x: canvas.width + 20, lane: pickDanmakuLane(width) });
}

function tickAndDrawCheerDanmaku(dt) {
  _danmakuClock += dt;
  if (!_cheerDanmaku.length) return;
  const fontSize = Math.floor(canvas.height * 0.032);
  const laneH    = fontSize * 1.6;
  const top      = canvas.height * 0.06;
  ctx.save();
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  ctx.font         = `700 ${fontSize}px "Noto Sans TC", sans-serif`;
  ctx.lineWidth    = 4;
  for (let i = _cheerDanmaku.length - 1; i >= 0; i--) {
    const d = _cheerDanmaku[i];
    d.x -= DANMAKU_SPEED * dt;
    if (d.x + d.width < -20) { _cheerDanmaku.splice(i, 1); continue; }
    const y = top + d.lane * laneH + laneH / 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.strokeText(d.label, d.x, y);
    ctx.fillStyle = d.color;
    ctx.fillText(d.label, d.x, y);
  }
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
    tickAndDrawCheerDanmaku(dtSec);
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

  // The host has its own standalone badge — it never appears in either
  // team column (see shared/teams.js and assignableIds()).
  const host = state.players[masterId];
  hostCardEl.classList.toggle('hidden', !host);
  hostCardEl.textContent = host ? `房主：${host.name}` : '';

  teamRedListEl.innerHTML  = '';
  teamBlueListEl.innerHTML = '';

  ids.forEach(id => {
    if (id === masterId) return; // rendered as the host badge instead
    const p    = state.players[id];
    const team = state.teams[id];
    const card = document.createElement('div');
    card.className   = 'player-card ' + (team === 'red' ? 'player-card-red' : 'player-card-blue');
    card.textContent = p.name;
    if (team === 'red') teamRedListEl.appendChild(card);
    else                teamBlueListEl.appendChild(card);
  });

  // Density tier per roster size so ~20 players still fit on screen:
  // always at least 2 columns (even for a single player), then 3 columns
  // with smaller cards once a team gets big.
  const tier = n => (n <= 12 ? 'medium' : 'dense');
  teamRedListEl.dataset.size  = tier(teamRedListEl.children.length);
  teamBlueListEl.dataset.size = tier(teamBlueListEl.children.length);

  // Playable headcount excludes the host — they never fill a team slot.
  const playableCount = count - (host ? 1 : 0);
  lobbyHintEl.textContent =
    playableCount === 0 ? '等待玩家加入…' :
    playableCount === 1 ? '至少需要 2 位玩家才能開始' :
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
    <div class="cum-divider">VS</div>
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
  const roundScore = state.lastRoundScore; // { label, red, blue } | null

  const winnerClass = w === 'red' ? 'red' : w === 'blue' ? 'blue' : 'tie';
  // English poster wording — reads as a big title banner (near-full-width,
  // same treatment as the READY ROOM/RESULTS headers) instead of a
  // sentence, so it needs to work as short punchy words, not a translated
  // Chinese sentence.
  const winnerText = w === 'red' ? 'RED TEAM WINS!' : w === 'blue' ? 'BLUE TEAM WINS!' : 'DRAW!';

  // Cumulative match tally isn't shown here anymore — the flow always
  // returns to game select next, which already has its own running score
  // pill (see renderGameSelect()), so repeating it on this screen was
  // redundant.
  scoreboardEl.innerHTML = `
    <div class="winner-announce ${winnerClass}">${winnerText}</div>
    ${roundScore ? `
      <div class="round-score">
        <span class="round-score-label">${roundScore.label}</span>
        <span class="round-score-red">${roundScore.red}</span>
        <span class="round-score-sep">:</span>
        <span class="round-score-blue">${roundScore.blue}</span>
      </div>
    ` : ''}
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
