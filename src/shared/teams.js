import { TEAM } from './constants.js';

/** Count players per team. Returns { red: n, blue: n } */
export function teamCounts(teams) {
  return Object.values(teams).reduce(
    (acc, t) => { acc[t] = (acc[t] ?? 0) + 1; return acc; },
    { red: 0, blue: 0 }
  );
}

/** Team with fewer members currently assigned. Ties broken randomly. */
function smallerTeam(teams) {
  const counts = teamCounts(teams);
  if (counts.red === counts.blue) return Math.random() < 0.5 ? TEAM.RED : TEAM.BLUE;
  return counts.red < counts.blue ? TEAM.RED : TEAM.BLUE;
}

/**
 * Assign any player ids missing a team to whichever team is currently
 * smaller, without disturbing players who already have a team.
 * Lets manual switch-team swaps (and existing balance) survive
 * connects/disconnects instead of being reshuffled away.
 * Returns a new teams map; does not mutate the input.
 */
export function fillMissingTeams(teams, playerIds) {
  const next = { ...teams };
  for (const id of playerIds) {
    if (next[id] === TEAM.RED || next[id] === TEAM.BLUE) continue;
    next[id] = smallerTeam(next);
  }
  return next;
}

/**
 * Flip one player's team red<->blue — no confirmation needed.
 * No-op if the player doesn't have a team yet.
 * Returns a new teams map; does not mutate the input.
 */
export function toggleTeam(teams, deviceId) {
  const current = teams[deviceId];
  if (current !== TEAM.RED && current !== TEAM.BLUE) return teams;
  return { ...teams, [deviceId]: current === TEAM.RED ? TEAM.BLUE : TEAM.RED };
}
