export function otherTeam(team) {
  return team === 'red' ? 'blue' : 'red';
}

export function rollPlacementCount(random = Math.random) {
  return 1 + Math.floor(random() * 3);
}

export function createTurnState(startingTeam, shapeChangesPerTeam) {
  return {
    currentTeam: startingTeam,
    placementsRequired: 0,
    placementsRemaining: 0,
    shapeChangesRemaining: {
      red: shapeChangesPerTeam,
      blue: shapeChangesPerTeam,
    },
  };
}

export function beginRolledTurn(state, diceValue) {
  const placements = Math.max(1, Math.min(3, Math.round(diceValue)));
  return {
    ...state,
    placementsRequired: placements,
    placementsRemaining: placements,
  };
}

export function completePlacement(state) {
  const placementsRemaining = Math.max(0, state.placementsRemaining - 1);
  if (placementsRemaining > 0) {
    return {
      handoff: false,
      state: { ...state, placementsRemaining },
    };
  }

  return {
    handoff: true,
    state: {
      ...state,
      currentTeam: otherTeam(state.currentTeam),
      placementsRequired: 0,
      placementsRemaining: 0,
    },
  };
}

export function spendShapeChange(state, team) {
  if (team !== state.currentTeam) return { accepted: false, state };
  const remaining = state.shapeChangesRemaining[team] ?? 0;
  if (remaining <= 0) return { accepted: false, state };

  return {
    accepted: true,
    state: {
      ...state,
      shapeChangesRemaining: {
        ...state.shapeChangesRemaining,
        [team]: remaining - 1,
      },
    },
  };
}
