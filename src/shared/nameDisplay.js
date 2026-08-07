// Shared nickname-display rules for in-game nameplates (hospital, pong,
// volleyball): real AirConsole nicknames instead of generic team/number
// labels, clipped so a long custom nickname can't blow out the HUD.
export const MAX_NAME_CHARS = 10;

export function truncateName(name, maxChars = MAX_NAME_CHARS) {
  return name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name;
}
