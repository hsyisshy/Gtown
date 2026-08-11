import { PHASE } from './constants.js';

const TRANSITIONS = {
  [PHASE.LOBBY]:       [PHASE.GAME_SELECT],
  [PHASE.GAME_SELECT]: [PHASE.MAP_SELECT, PHASE.PREP, PHASE.LOBBY],
  [PHASE.MAP_SELECT]:  [PHASE.PREP, PHASE.GAME_SELECT, PHASE.LOBBY],
  [PHASE.PREP]:        [PHASE.PLAYING, PHASE.GAME_SELECT],
  [PHASE.PLAYING]:     [PHASE.RESULTS, PHASE.LOBBY, PHASE.GAME_SELECT],
  [PHASE.RESULTS]:     [PHASE.GAME_SELECT, PHASE.LOBBY],
};

export class StateMachine {
  constructor(onChange) {
    this._phase = PHASE.LOBBY;
    this._onChange = onChange;
  }

  get phase() { return this._phase; }
  is(phase)   { return this._phase === phase; }

  transition(newPhase) {
    if (this._phase === newPhase) return;
    const allowed = TRANSITIONS[this._phase] ?? [];
    if (!allowed.includes(newPhase)) {
      console.warn(`[SM] invalid transition: ${this._phase} → ${newPhase}`);
      return;
    }
    this._phase = newPhase;
    this._onChange?.(newPhase);
  }

  toLobby()      { this.transition(PHASE.LOBBY); }
  toGameSelect() { this.transition(PHASE.GAME_SELECT); }
  toMapSelect()  { this.transition(PHASE.MAP_SELECT); }
  toPrep()       { this.transition(PHASE.PREP); }
  toPlaying()    { this.transition(PHASE.PLAYING); }
  toResults()    { this.transition(PHASE.RESULTS); }
}
