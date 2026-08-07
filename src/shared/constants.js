// AirConsole message types (screen <-> controller)
export const MSG = {
  // Controller -> Screen
  PLAYER_INPUT:    'player_input',
  REQUEST_START:   'request_start',
  SELECT_GAME:     'select_game',
  SELECT_MAP:      'select_map',     // master picks a map { type, mapIndex }
  CHEER:           'cheer',          // watcher sends emoji { type, emoji }
  REQUEST_RESULTS: 'request_results',
  SWITCH_TEAM:     'switch_team',    // lobby-only: self-serve red<->blue swap, no approval needed
  REQUEST_HOST:    'request_host',   // guest asks to become host; screen relays to current host
  APPROVE_HOST:    'approve_host',   // host grants: { type, targetId } → host role transfers
  DENY_HOST:       'deny_host',      // host declines: { type, targetId } → requester gets notified
};

// Game phases
export const PHASE = {
  LOBBY:       'lobby',
  GAME_SELECT: 'game_select',
  MAP_SELECT:  'map_select',   // intermediate: host picks map before playing
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
  ACTIVE_PLAYERS: 'activePlayers',   // { [deviceId]: 'playing' | 'watching' }
  MAP_LIST:       'mapList',         // array of { name, description } for current game
  SELECTED_MAP:   'selectedMap',     // number | null
  SFX_VOLUME:     'sfxVolume',       // 0..1 — button-SFX loudness for all controllers
};

export const MAX_PLAYERS = 20;

// Planned final lineup size for the game-select screen/controller — until
// this many games actually exist, the remaining slots render as "coming
// soon" placeholders instead of leaving an unbalanced/empty-looking grid.
// Laid out as 5 columns x 2 rows; slot 1 is the "random pick" card, not a
// game, so comingSoonCount = TOTAL_GAME_SLOTS - GAMES.length - 1.
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
