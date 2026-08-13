import './style.css';
import { classifyMediaError, teardownAudio, throttledMessage } from '../shared/airconsole-wrapper.js';
import { PHASE, MSG, STATE_KEY, TEAM_COLOR, TOTAL_GAME_SLOTS } from '../shared/constants.js';
import * as defaultLayout from './layouts/default.js';

const airconsole = new AirConsole();

// ---------------------------------------------------------------------------
// Local state
// ---------------------------------------------------------------------------
const state = {
  phase:         PHASE.LOBBY,
  isMaster:      false,
  myTeam:        null,
  teams:         {},            // { [deviceId]: 'red' | 'blue' } — full map, needed for the PREP host panel's redraw-spare check
  players:       {},
  gameList:      [],
  mapList:       [],            // from STATE_KEY.MAP_LIST
  currentGameId: null,
  activePlayers: {},            // { [deviceId]: 'playing' | 'watching' }
  teamScores:    { red: 0, blue: 0 },
  prepReady:     {},            // { [deviceId]: true } — from STATE_KEY.PREP_READY
  prepUnlocked:  false,         // from STATE_KEY.PREP_UNLOCKED
  tutorialPages: [],            // from STATE_KEY.TUTORIAL_PAGES — image paths; empty means no paged tutorial active
  tutorialReady: {},            // from STATE_KEY.TUTORIAL_READY — { [deviceId]: true }
  _prevMyRole:   null,          // track my previous playing/watching role
  _activeLayoutGameId: null,    // gameId the mounted controller-layout belongs to
  _lastSent:     {},
  audio:         { context: null, nodes: [] },
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const views = {
  waiting:         document.getElementById('waiting'),
  lobbyMaster:     document.getElementById('lobby-master'),
  lobbyPlayer:     document.getElementById('lobby-player'),
  gameSelectMaster: document.getElementById('game-select-master'),
  gameSelectPlayer: document.getElementById('game-select-player'),
  mapSelectMaster:  document.getElementById('map-select-master'),
  mapSelectPlayer:  document.getElementById('map-select-player'),
  prepWaiting:      document.getElementById('prep-waiting'),
  prepReadyPending: document.getElementById('prep-ready-pending'),
  prepReadyDone:    document.getElementById('prep-ready-done'),
  prepWatching:     document.getElementById('prep-watching'),
  controls:        document.getElementById('controls'),
  cheering:        document.getElementById('cheering'),
  resultsMaster:   document.getElementById('results-master'),
  resultsPlayer:   document.getElementById('results-player'),
};

const gameSelectList = document.getElementById('game-select-list');
const mapSelectList  = document.getElementById('map-select-list');
const prepHostPanel  = document.getElementById('prep-host-panel');
const prepRosterList = document.getElementById('prep-roster-list');
const prepReadyCount = document.getElementById('prep-ready-count');

// ---------------------------------------------------------------------------
// Menu button SFX — one confirm cue on activation (click). Delegated on
// document so the dynamically built game/map lists are covered without
// re-binding. In-game controls (joystick / D-pad / A / B under #layout-root)
// are deliberately not in the selector — a 2s cue on every input would
// drown gameplay.
// ---------------------------------------------------------------------------
const MENU_BTN_SELECTOR = [
  '.primary-btn', '.secondary-btn', '.cheer-btn',
  '.game-select-btn', '.map-select-btn', '#ingame-back-btn',
].join(', ');

// One-tap buttons get the hover cue as their tap sound — it reads better
// as a single feedback than the click cue.
const menuSfx = new Audio('bottom_hoverclick.mp3');
menuSfx.preload = 'auto';

// Overall SFX loudness (0..1) — the screen's settings panel broadcasts it
// via STATE_KEY.SFX_VOLUME.
function applySfxVolume(v) {
  menuSfx.volume = Math.max(0, Math.min(1, v));
}
applySfxVolume(1.0);

// Bubble phase on purpose: the list drag-scroll guard below cancels
// accidental clicks with stopPropagation in the capture phase, and those
// must stay silent too.
document.addEventListener('click', e => {
  const btn = e.target.closest?.(MENU_BTN_SELECTOR);
  if (btn && !btn.disabled) {
    // Restart from the top on rapid re-presses instead of stacking copies
    menuSfx.currentTime = 0;
    menuSfx.play().catch(() => {});   // pre-gesture autoplay rejection — ignore
  }
});

// ---------------------------------------------------------------------------
// Manual touch scrolling for lists inside the portrait rotate-90 hack.
// iOS Safari doesn't map pan gestures through CSS transforms — a scroller
// inside the rotated body simply never scrolls natively in portrait. So in
// portrait we drive scrollTop ourselves from pointer deltas (rotating the
// axes like the joystick does); in landscape native scrolling works and
// this stays out of the way.
// ---------------------------------------------------------------------------
function enableRotatedTouchScroll(el) {
  let activeId = null, lastX = 0, lastY = 0, dragged = 0;

  el.addEventListener('pointerdown', e => {
    activeId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    dragged = 0;
  });
  el.addEventListener('pointermove', e => {
    if (e.pointerId !== activeId) return;
    const dxs = e.clientX - lastX;
    const dys = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    dragged += Math.abs(dxs) + Math.abs(dys);
    if (!matchMedia('(orientation: portrait)').matches) return; // native handles landscape
    // rotate(90deg): the list's local "down" is the screen's "left"
    el.scrollTop += dxs;
  });
  const end = e => { if (e.pointerId === activeId) activeId = null; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  // A drag that scrolled the list shouldn't also "click" the button the
  // finger happened to start on.
  el.addEventListener('click', e => {
    if (dragged > 12) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

enableRotatedTouchScroll(gameSelectList);
enableRotatedTouchScroll(mapSelectList);
const layoutRoot     = document.getElementById('layout-root');
const youAreUpEl     = document.getElementById('you-are-up');

// ---------------------------------------------------------------------------
// Per-game layout loading via import.meta.glob
// ---------------------------------------------------------------------------
const gameLayouts = import.meta.glob('../games/*/controller-layout.js');

async function mountLayout(gameId) {
  // Custom device state fields land as separate messages (see screen's
  // broadcastState), so PHASE can flip to PLAYING slightly before/after
  // CURRENT_GAME updates. Claim the gameId synchronously so a second call
  // for the same game (fired from another state message before this one
  // finishes its async import) is a no-op instead of double-mounting.
  if (state._activeLayoutGameId === gameId) return;
  state._activeLayoutGameId = gameId;

  const active = state._activeLayout;
  if (active) { active.unmount(); state._activeLayout = null; }

  const layoutKey = Object.keys(gameLayouts)
    .find(k => k.includes(`/${gameId}/controller-layout`));
  let layout = defaultLayout;
  if (layoutKey) {
    try { layout = await gameLayouts[layoutKey](); }
    catch (e) { console.warn('[layout] failed to load game layout, using default', e); }
  }

  // A newer call for a different game superseded us while we were awaiting
  // the dynamic import — bail out so we don't clobber the newer layout.
  if (state._activeLayoutGameId !== gameId) return;

  layout.mount(layoutRoot, sendInput);
  state._activeLayout = layout;
}

function unmountLayout() {
  state._activeLayout?.unmount();
  state._activeLayout = null;
  state._activeLayoutGameId = null;
  layoutRoot.innerHTML = '';
}

// ---------------------------------------------------------------------------
// Input sender
// ---------------------------------------------------------------------------
function sendInput(data) {
  airconsole.message(AirConsole.SCREEN, { type: MSG.PLAYER_INPUT, ...data });
}

// ---------------------------------------------------------------------------
// AirConsole events
// ---------------------------------------------------------------------------
airconsole.onReady = function () {
  state.isSilenced = airconsole.arePlayersSilenced();
  refreshUI();
};

airconsole.onMessage = function (deviceId, data) {
  if (deviceId !== AirConsole.SCREEN || !data) return;
  if (data.type === 'hit_confirm') {
    navigator.vibrate?.(70);
    flashHit();
  }
  if (data.type === 'host_request') showHostRequest(data.fromId, data.fromName);
  if (data.type === 'host_denied') showToast('房主拒絕了你的申請');
  if (data.type === 'not_enough_players') showToast(data.reason || '人數不足，無法開始這個遊戲');
};

function flashHit() {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;background:rgba(255,107,107,0.45);pointer-events:none;z-index:9999';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 160);
}

airconsole.onDisconnect = function () {
  teardownAudio(state.audio);
  state.audio = { context: null, nodes: [] };
  unmountLayout();
};

airconsole.onCustomDeviceStateChange = function (deviceId, customData) {
  if (deviceId !== AirConsole.SCREEN || !customData) return;

  if (customData[STATE_KEY.PHASE] !== undefined)        state.phase         = customData[STATE_KEY.PHASE];
  if (customData[STATE_KEY.CURRENT_GAME] !== undefined) state.currentGameId = customData[STATE_KEY.CURRENT_GAME];
  if (customData[STATE_KEY.TEAM_SCORES] !== undefined)  state.teamScores    = customData[STATE_KEY.TEAM_SCORES];
  if (customData[STATE_KEY.MAP_LIST] !== undefined)     state.mapList       = customData[STATE_KEY.MAP_LIST];

  if (customData[STATE_KEY.PLAYERS] !== undefined) {
    state.players = customData[STATE_KEY.PLAYERS];
    const myId = String(airconsole.getDeviceId());
    state.isMaster = state.players[myId]?.isMaster ?? false;
  }

  if (customData[STATE_KEY.TEAMS] !== undefined) {
    state.teams = customData[STATE_KEY.TEAMS];
    const myId = String(airconsole.getDeviceId());
    state.myTeam = state.teams[myId] ?? null;
  }

  if (customData[STATE_KEY.ACTIVE_PLAYERS] !== undefined) {
    state.activePlayers = customData[STATE_KEY.ACTIVE_PLAYERS];
  }

  if (customData[STATE_KEY.PREP_READY] !== undefined) {
    state.prepReady = customData[STATE_KEY.PREP_READY];
  }

  if (customData[STATE_KEY.PREP_UNLOCKED] !== undefined) {
    state.prepUnlocked = customData[STATE_KEY.PREP_UNLOCKED];
  }

  if (customData[STATE_KEY.TUTORIAL_PAGES] !== undefined) {
    const pages = customData[STATE_KEY.TUTORIAL_PAGES];
    // Reset MY OWN reading position only when a tutorial session is actually
    // starting (empty/none → non-empty) — NOT every time this re-broadcasts
    // unchanged during the same session (e.g. another player tapping ready),
    // which would otherwise yank everyone back to page 1 mid-read.
    const startingNewSession = !(state.tutorialPages?.length) && pages?.length;
    state.tutorialPages = pages ?? [];
    if (startingNewSession) _tutorialLocalPage = 0;
  }

  if (customData[STATE_KEY.TUTORIAL_READY] !== undefined) {
    state.tutorialReady = customData[STATE_KEY.TUTORIAL_READY];
  }

  if (customData[STATE_KEY.SFX_VOLUME] !== undefined) {
    applySfxVolume(customData[STATE_KEY.SFX_VOLUME]);
  }

  if (customData[STATE_KEY.GAME_LIST] !== undefined) {
    state.gameList = customData[STATE_KEY.GAME_LIST];
    if (state.phase === PHASE.GAME_SELECT && state.isMaster) renderGameSelectList();
  }

  // Mount layout for active players entering PLAYING phase
  const myId = String(airconsole.getDeviceId());
  const myRole = (state.activePlayers ?? {})[myId] ?? null;

  // Compare against the mounted gameId (not just "is something mounted") so
  // a layout mounted from a stale/out-of-order state message self-heals into
  // the right one as soon as CURRENT_GAME catches up, instead of getting
  // stuck showing the previous game's controller.
  if (state.phase === PHASE.PLAYING && myRole === 'playing' && state.currentGameId
      && state._activeLayoutGameId !== state.currentGameId) {
    mountLayout(state.currentGameId);
  }
  if ((state.phase !== PHASE.PLAYING || myRole !== 'playing') && state._activeLayout) {
    unmountLayout();
  }

  // "你上場了！" notification — now first learned during PREP (the reveal),
  // not PLAYING, since that's when activePlayers actually gets populated.
  if ((state.phase === PHASE.PREP || state.phase === PHASE.PLAYING)
      && state._prevMyRole !== 'playing' && myRole === 'playing') {
    showYouAreUp();
  }
  state._prevMyRole = myRole;

  refreshUI();
};

// ---------------------------------------------------------------------------
// "你上場了！" notification
// ---------------------------------------------------------------------------
function showYouAreUp() {
  youAreUpEl.classList.remove('hidden');
  setTimeout(() => youAreUpEl.classList.add('hidden'), 2200);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
function showOnly(activeKey) {
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== activeKey);
  });
}

function renderTeamBadges() {
  if (!state.myTeam) return;
  const color = TEAM_COLOR[state.myTeam];
  const label = state.myTeam === 'red' ? '🔴 RED' : '🔵 BLUE';
  document.querySelectorAll('.team-badge').forEach(el => {
    el.textContent       = label;
    el.style.color       = color;
    el.style.borderColor = color;
    el.style.display     = 'block';
  });
}

function renderLobbyTeamInfo(badgeId, membersId, countId) {
  const badgeEl   = document.getElementById(badgeId);
  const membersEl = document.getElementById(membersId);
  const countEl   = document.getElementById(countId);
  if (!badgeEl || !membersEl) return;

  const myId   = String(airconsole.getDeviceId());
  const total  = Object.keys(state.players).length;
  const myTeam = state.myTeam;

  if (myTeam) {
    const isRed = myTeam === 'red';
    badgeEl.textContent = isRed ? '🔴 紅隊' : '🔵 藍隊';
    badgeEl.className   = 'ctrl-team-badge ' + (isRed ? 'red' : 'blue');

    membersEl.innerHTML = '';
    Object.entries(state.players).forEach(([id, p]) => {
      if (p.team !== myTeam) return;
      const chip = document.createElement('div');
      chip.className   = 'ctrl-member-chip' + (id === myId ? ' me' : '');
      chip.textContent = p.name + (id === myId ? ' （你）' : '') + (p.isMaster ? '（房主）' : '');
      membersEl.appendChild(chip);
    });
  }

  if (countEl) countEl.textContent = `${total} 位玩家已加入`;
}

function refreshUI() {
  const { phase, isMaster } = state;
  const myId   = String(airconsole.getDeviceId());
  const myRole = (state.activePlayers ?? {})[myId] ?? null;

  if (phase === PHASE.LOBBY) {
    showOnly(isMaster ? 'lobbyMaster' : 'lobbyPlayer');
    if (isMaster) renderLobbyTeamInfo('lobby-master-team-badge', 'lobby-master-members', 'lobby-master-count');
    else          renderLobbyTeamInfo('lobby-player-team-badge', 'lobby-player-members', 'lobby-player-count');

  } else if (phase === PHASE.GAME_SELECT) {
    if (isMaster) { renderGameSelectList(); showOnly('gameSelectMaster'); }
    else showOnly('gameSelectPlayer');

  } else if (phase === PHASE.MAP_SELECT) {
    if (isMaster) { renderMapSelectList(); showOnly('mapSelectMaster'); }
    else showOnly('mapSelectPlayer');

  } else if (phase === PHASE.PREP) {
    if (myRole === 'playing') {
      if (state.prepReady[myId]) {
        showOnly('prepReadyDone');
        const playingIds = Object.entries(state.activePlayers)
          .filter(([, r]) => r === 'playing').map(([id]) => id);
        const readyCount = playingIds.filter(id => state.prepReady[id]).length;
        prepReadyCount.textContent = `${readyCount}/${playingIds.length} 已準備`;
      } else {
        showOnly('prepReadyPending');
      }
    } else if (myRole === 'watching') {
      showOnly('prepWatching');
    } else {
      showOnly('prepWaiting'); // reveal hasn't landed yet — activePlayers still empty
    }

  } else if (phase === PHASE.PLAYING) {
    if (myRole === 'playing') showOnly('controls');
    else showOnly('cheering');

  } else if (phase === PHASE.RESULTS) {
    showOnly(isMaster ? 'resultsMaster' : 'resultsPlayer');

  } else {
    showOnly('waiting');
  }

  // Host's in-game escape hatch — PLAYING (mid-round abort) and PREP (bail
  // out of a bad pick before the round even starts); other phases have
  // their own back buttons inside the view.
  const showBack = isMaster && (phase === PHASE.PLAYING || phase === PHASE.PREP);
  ingameBackBtn.classList.toggle('hidden', !showBack);
  if (!showBack) {
    ingameBackBtn.classList.remove('confirming');
    ingameBackBtn.textContent = '重選遊戲';
  }

  // PREP host override panel — persistent overlay, same treatment as
  // ingameBackBtn, shown on top of whichever of the 4 PREP views above the
  // host is also seeing as a participant.
  const showPrepPanel = isMaster && phase === PHASE.PREP && state.prepUnlocked;
  prepHostPanel.classList.toggle('hidden', !showPrepPanel);
  if (showPrepPanel) renderPrepHostPanel();

  // How-to-play book reader — persistent overlay like ingameBackBtn, shown
  // to EVERY playing device while it's still browsing its own copy, layered
  // on top of its normal (held) game controls. Once this device has sent
  // TUTORIAL_READY, swap to the compact "waiting on others" badge instead.
  const tutorialPagesActive = phase === PHASE.PLAYING && (state.tutorialPages?.length ?? 0) > 0;
  const iAmReadingTutorial  = tutorialPagesActive && myRole === 'playing' && !state.tutorialReady[myId];
  const iAmWaitingOnOthers  = tutorialPagesActive && myRole === 'playing' && !!state.tutorialReady[myId];

  tutorialReaderEl.classList.toggle('hidden', !iAmReadingTutorial);
  if (iAmReadingTutorial) renderTutorialReader();
  tutorialWaitingEl.classList.toggle('hidden', !iAmWaitingOnOthers);
  // Re-enables this game's normally-inactive A/B buttons (see .abxy-btn.inactive
  // override in style.css) so this device can actually tap them to flip pages.
  document.body.classList.toggle('tutorial-controlling', iAmReadingTutorial);

  renderTeamBadges();
}

// ---------------------------------------------------------------------------
// How-to-play picture book — every playing device flips through its OWN
// copy at its own pace, using its own game's real A/B gamepad buttons
// (.abxy-btn.btn-a/.btn-b — every controller-layout renders these, active
// or not). Delegated on document so it works no matter which game's layout
// is mounted underneath. The game's own handler for these buttons (if any)
// may also fire — harmless, since gameplay input is already dropped
// screen-side while a tutorial is active. Reading position is purely local
// (never synced) — only the "I finished" signal (MSG.TUTORIAL_READY) goes
// to the screen, which then shows a ready-roster instead of one synced page.
// ---------------------------------------------------------------------------
const tutorialReaderEl      = document.getElementById('tutorial-reader');
const tutorialReaderImg     = document.getElementById('tutorial-reader-img');
const tutorialReaderCounter = document.getElementById('tutorial-reader-counter');
const tutorialReaderHint    = document.getElementById('tutorial-reader-hint');
const tutorialWaitingEl     = document.getElementById('tutorial-waiting');
let _tutorialLocalPage = 0;

function renderTutorialReader() {
  const pages = state.tutorialPages;
  if (!pages?.length) return;
  const idx = Math.min(_tutorialLocalPage, pages.length - 1);
  tutorialReaderImg.src = pages[idx];
  tutorialReaderCounter.textContent = `${idx + 1} / ${pages.length}`;
  const isLast = idx === pages.length - 1;
  tutorialReaderHint.textContent = isLast ? '🅰️ 上一頁　🅱️ 開始！' : '🅰️ 上一頁　🅱️ 下一頁';
}

document.addEventListener('click', e => {
  const pages = state.tutorialPages;
  if (!pages?.length) return;
  const myId = String(airconsole.getDeviceId());
  if (state.tutorialReady[myId]) return; // already dismissed my own reader
  const btn = e.target.closest?.('.abxy-btn.btn-a, .abxy-btn.btn-b');
  if (!btn) return;

  if (btn.classList.contains('btn-b')) {
    if (_tutorialLocalPage >= pages.length - 1) {
      airconsole.message(AirConsole.SCREEN, { type: MSG.TUTORIAL_READY });
      return;
    }
    _tutorialLocalPage += 1;
  } else if (_tutorialLocalPage > 0) {
    _tutorialLocalPage -= 1;
  }
  renderTutorialReader();
});

// ---------------------------------------------------------------------------
// PREP host override panel (master only, shown once STATE_KEY.PREP_UNLOCKED)
// ---------------------------------------------------------------------------
function renderPrepHostPanel() {
  prepRosterList.innerHTML = '';
  const notReady = Object.entries(state.activePlayers)
    .filter(([id, role]) => role === 'playing' && !state.prepReady[id]);

  if (!notReady.length) {
    prepRosterList.innerHTML = '<p class="hint">大家都準備好了！</p>';
    return;
  }

  notReady.forEach(([id]) => {
    const team = state.teams[id];
    const hasSpare = Object.entries(state.activePlayers)
      .some(([otherId, role]) => role === 'watching' && state.teams[otherId] === team);

    const row = document.createElement('div');
    row.className = 'prep-panel-row';
    row.innerHTML = `
      <span class="prep-panel-name">${state.players[id]?.name ?? '???'}</span>
      <button class="secondary-btn prep-redraw-btn"${hasSpare ? '' : ' disabled'}>🔄 重抽</button>
    `;
    row.querySelector('.prep-redraw-btn').addEventListener('click', () => {
      airconsole.message(AirConsole.SCREEN, { type: MSG.PREP_REDRAW, targetId: id });
    });
    prepRosterList.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Game select list (master)
// ---------------------------------------------------------------------------
function renderGameSelectList() {
  if (!state.gameList.length) return;
  gameSelectList.innerHTML = '';
  state.gameList.forEach(game => {
    const btn = document.createElement('button');
    // Cover art mirrors the screen's grid — the phone shows a shrunk-down
    // copy of what the TV shows, same order, same artwork.
    if (game.comingSoon) {
      // Cover art exists but the game isn't built yet — real thumbnail,
      // same non-clickable treatment as the screen's gold "即將推出" pill.
      btn.className = 'game-select-btn has-cover upcoming';
      btn.disabled = true;
      btn.innerHTML = `
        <img class="gs-cover" src="${game.cover}" alt="${game.name}" />
        <span class="gs-upcoming-badge">即將推出</span>
      `;
    } else {
      btn.className = game.cover ? 'game-select-btn has-cover' : 'game-select-btn';
      btn.style.setProperty('--game-color', game.color);
      btn.innerHTML = game.cover
        ? `<img class="gs-cover" src="${game.cover}" alt="${game.name}" />`
        : `<span class="gs-emoji">${game.emoji}</span><span class="gs-name">${game.name}</span>`;
      btn.addEventListener('click', () => {
        airconsole.message(AirConsole.SCREEN, { type: MSG.SELECT_GAME, gameId: game.id });
      });
    }
    gameSelectList.appendChild(btn);
  });

  // Same "coming soon" placeholders as the screen's game grid, so the
  // planned lineup (not just what's shipped so far) shows on the phone too.
  const comingSoonCount = Math.max(0, TOTAL_GAME_SLOTS - state.gameList.length);
  for (let i = 0; i < comingSoonCount; i++) {
    const btn = document.createElement('button');
    btn.className = 'game-select-btn coming-soon';
    btn.disabled = true;
    btn.innerHTML = `<span class="gs-emoji">❓</span><span class="gs-name">敬請期待</span>`;
    gameSelectList.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// Map select list (master)
// ---------------------------------------------------------------------------
function renderMapSelectList() {
  if (!state.mapList.length) return;
  mapSelectList.innerHTML = '';
  state.mapList.forEach((map, i) => {
    const btn = document.createElement('button');
    const disabled = map.enabled === false;
    btn.className = disabled ? 'map-select-btn disabled' : 'map-select-btn';
    // Stacked name-over-description, same reading order as the screen's
    // map cards.
    btn.innerHTML = `<span class="ms-name">${map.name}</span><span class="ms-desc">${map.description}</span>`;
    if (disabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => {
        airconsole.message(AirConsole.SCREEN, { type: MSG.SELECT_MAP, mapIndex: i });
      });
    }
    mapSelectList.appendChild(btn);
  });
}

// ---------------------------------------------------------------------------
// Cheer button bindings
// ---------------------------------------------------------------------------
document.querySelectorAll('.cheer-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const emoji = btn.dataset.emoji;
    if (emoji) airconsole.message(AirConsole.SCREEN, { type: MSG.CHEER, emoji });
  });
});

// ---------------------------------------------------------------------------
// Button bindings
// ---------------------------------------------------------------------------
document.getElementById('start-btn')?.addEventListener('click', () => {
  airconsole.message(AirConsole.SCREEN, { type: MSG.REQUEST_START });
});
document.getElementById('game-select-random-btn')?.addEventListener('click', () => {
  airconsole.message(AirConsole.SCREEN, { type: MSG.RANDOM_PICK });
});
document.querySelectorAll('.switch-team-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    airconsole.message(AirConsole.SCREEN, { type: MSG.SWITCH_TEAM });
  });
});

// ---------------------------------------------------------------------------
// Host transfer — guests apply, the current host gets an approve/deny
// dialog, approval hands the host role over (screen owns the state).
// ---------------------------------------------------------------------------
const hostRequestEl     = document.getElementById('host-request');
const hostRequestTextEl = document.getElementById('host-request-text');
const ctrlToastEl       = document.getElementById('ctrl-toast');
let _pendingHostRequestId = null;
let _toastTimer = null;

function showHostRequest(fromId, fromName) {
  _pendingHostRequestId = fromId;
  hostRequestTextEl.textContent = `${fromName ?? '玩家'} 想成為房主`;
  hostRequestEl.classList.remove('hidden');
}

function hideHostRequest() {
  _pendingHostRequestId = null;
  hostRequestEl.classList.add('hidden');
}

function showToast(text) {
  ctrlToastEl.textContent = text;
  ctrlToastEl.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => ctrlToastEl.classList.add('hidden'), 2200);
}

document.getElementById('claim-host-btn')?.addEventListener('click', () => {
  airconsole.message(AirConsole.SCREEN, { type: MSG.REQUEST_HOST });
  showToast('已送出申請');
});
document.getElementById('host-approve-btn')?.addEventListener('click', () => {
  if (_pendingHostRequestId == null) return;
  airconsole.message(AirConsole.SCREEN, { type: MSG.APPROVE_HOST, targetId: _pendingHostRequestId });
  hideHostRequest();
});
document.getElementById('host-deny-btn')?.addEventListener('click', () => {
  if (_pendingHostRequestId == null) return;
  airconsole.message(AirConsole.SCREEN, { type: MSG.DENY_HOST, targetId: _pendingHostRequestId });
  hideHostRequest();
});
document.getElementById('play-again-btn')?.addEventListener('click', () => {
  airconsole.message(AirConsole.SCREEN, { type: 'play_again' });
});
document.getElementById('game-select-back-btn')?.addEventListener('click', () => {
  airconsole.message(AirConsole.SCREEN, { type: 'back_to_lobby' });
});
document.getElementById('map-select-back-btn')?.addEventListener('click', () => {
  airconsole.message(AirConsole.SCREEN, { type: 'back_to_lobby' });
});
document.getElementById('prep-ready-btn')?.addEventListener('click', () => {
  airconsole.message(AirConsole.SCREEN, { type: MSG.PREP_READY });
});
document.getElementById('prep-force-start-btn')?.addEventListener('click', () => {
  airconsole.message(AirConsole.SCREEN, { type: MSG.PREP_FORCE_START });
});

// In-game back-to-game-select (host only). Two-tap confirm: mid-game the
// host's thumbs are busy, so a single stray tap shouldn't kill the round.
// Sends the same 'back_to_lobby' message the other back buttons use — the
// screen routes it by current phase, and during PLAYING that now lands on
// game select (teams stay as they are) rather than the team lobby.
const ingameBackBtn = document.getElementById('ingame-back-btn');
let _backConfirmTimer = null;

ingameBackBtn.addEventListener('click', () => {
  if (ingameBackBtn.classList.contains('confirming')) {
    clearTimeout(_backConfirmTimer);
    ingameBackBtn.classList.remove('confirming');
    ingameBackBtn.textContent = '重選遊戲';
    airconsole.message(AirConsole.SCREEN, { type: 'back_to_lobby' });
  } else {
    ingameBackBtn.classList.add('confirming');
    ingameBackBtn.textContent = '確定返回？';
    clearTimeout(_backConfirmTimer);
    _backConfirmTimer = setTimeout(() => {
      ingameBackBtn.classList.remove('confirming');
      ingameBackBtn.textContent = '重選遊戲';
    }, 3000);
  }
});

// ---------------------------------------------------------------------------
// PWA — players open the controller as a plain mobile-browser tab (via QR
// scan). Installing it to the home screen (manifest: display fullscreen +
// orientation portrait) is what actually hides the browser chrome on
// phones; the old tap-to-requestFullscreen hack never worked on iOS and
// was removed. The service worker exists only to satisfy installability
// checks — no offline caching (the game needs the network anyway).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---------------------------------------------------------------------------
// getUserMedia (optional)
// ---------------------------------------------------------------------------
export async function startMic() {
  try {
    const stream = await airconsole.getUserMedia({ audio: true });
    state.audio.context = new AudioContext();
    const source = state.audio.context.createMediaStreamSource(stream);
    state.audio.nodes.push(source);
  } catch (err) {
    const { kind, message } = classifyMediaError(err);
    if (kind === 'permission') alert(message);
    else console.warn('[Media]', message);
  }
}
