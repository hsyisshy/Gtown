// AirConsole message types (screen <-> controller)
export const MSG = {
  // Controller -> Screen
  PLAYER_INPUT:    'player_input',
  REQUEST_START:   'request_start',
  SELECT_GAME:     'select_game',
  RANDOM_PICK:     'random_pick',    // master requests the bingo-spin random pick
  SELECT_MAP:      'select_map',     // master picks a map { type, mapIndex }
  CHEER:           'cheer',          // watcher sends emoji { type, emoji }
  REQUEST_RESULTS: 'request_results',
  SWITCH_TEAM:     'switch_team',    // lobby-only: self-serve red<->blue swap, no approval needed
  REQUEST_HOST:    'request_host',   // guest asks to become host; screen relays to current host
  APPROVE_HOST:    'approve_host',   // host grants: { type, targetId } → host role transfers
  DENY_HOST:       'deny_host',      // host declines: { type, targetId } → requester gets notified
  PREP_READY:       'prep_ready',        // drawn player taps 準備 (no payload — deviceId is the sender)
  PREP_FORCE_START: 'prep_force_start',  // host only, honored only once STATE_KEY.PREP_UNLOCKED is true
  PREP_REDRAW:      'prep_redraw',       // host only: { type, targetId } — targetId = drawn-but-not-ready player to replace
  TUTORIAL_READY:   'tutorial_ready',    // a playing device finished flipping through its own copy of the how-to-play book (no payload — deviceId is the sender)
};

// Game phases
export const PHASE = {
  LOBBY:       'lobby',
  GAME_SELECT: 'game_select',
  MAP_SELECT:  'map_select',   // intermediate: host picks map before playing
  PREP:        'prep',         // intermediate: reveal picks + wait for everyone to ready up
  PLAYING:     'playing',
  RESULTS:     'results',
};

// Screen broadcasts state via setCustomDeviceStateProperty using these keys
export const STATE_KEY = {
  PHASE:          'phase',
  SCORES:         'scores',
  PLAYERS:        'players',
  SILENCED:       'silenced',
  CURRENT_GAME:   'current_game',
  GAME_LIST:      'game_list',
  TEAMS:          'teams',           // { [deviceId]: 'red' | 'blue' }
  TEAM_SCORES:    'teamScores',      // { red: 0, blue: 0 } cumulative wins
  ACTIVE_PLAYERS: 'activePlayers',   // { [deviceId]: 'playing' | 'watching' } — only populated once the PREP reveal lands
  MAP_LIST:       'mapList',         // array of { name, description } for current game
  SELECTED_MAP:   'selectedMap',     // number | null
  SFX_VOLUME:     'sfxVolume',       // 0..1 — button-SFX loudness for all controllers
  PREP_READY:     'prepReady',       // { [deviceId]: true } — drawn players who've tapped 準備
  PREP_UNLOCKED:  'prepUnlocked',    // boolean — true once the 20s grace period has elapsed with stragglers left
  TUTORIAL_PAGES: 'tutorialPages',   // array of image paths | null — each playing device browses its own copy at its own pace; empty/null means no paged tutorial is active right now
  TUTORIAL_READY: 'tutorialReady',   // { [deviceId]: true } — playing devices who've finished their own copy
};

// PREP phase timing (src/screen/main.js), shared so the controller's own
// "抽籤中" hold matches the screen's reel-spin duration exactly.
export const PREP_REEL_DURATION_MS = 2400;   // CSS transition-duration for the reel scroll
export const PREP_READY_TIMEOUT_MS = 20000;  // grace period before host override buttons unlock

// How-to-play picture book (src/screen/main.js) — each playing device reads
// its own copy at its own pace; this is the safety net so the party doesn't
// stall forever waiting on someone who never dismisses their reader.
export const TUTORIAL_READY_TIMEOUT_MS = 45000;

export const MAX_PLAYERS = 20;

// Planned final lineup size for the game-select screen/controller — until
// this many games actually exist, the remaining slots render as "coming
// soon" placeholders instead of leaving an unbalanced/empty-looking grid.
// Laid out as 5 columns x 2 rows; comingSoonCount = TOTAL_GAME_SLOTS - GAMES.length.
export const TOTAL_GAME_SLOTS = 10;

export const TEAM = {
  RED:  'red',
  BLUE: 'blue',
};

export const TEAM_COLOR = {
  red:  '#ff6b6b',
  blue: '#4ecdc4',
};

// Delta-time cap (ms): prevents physics explosion after tab resume
export const DT_CAP_MS = 20;

// Message rate limit: max 1 message per this interval (ms) for high-freq data
export const MSG_THROTTLE_MS = 100;
