/**
 * Thin wrapper around the AirConsole SDK.
 *
 * Best practices enforced here:
 *  - Message rate limiting for high-frequency sends (BP #5)
 *  - Delta-time capping helper (BP #6)
 *  - getUserMedia error classification (BP #8)
 */

import { MSG_THROTTLE_MS, DT_CAP_MS } from './constants.js';

/** Rate-limited message sender. Returns true if message was sent. */
export function throttledMessage(airconsole, to, data, state) {
  const now = performance.now();
  const key = `${to}:${data.type}`;
  if (state._lastSent && now - (state._lastSent[key] ?? 0) < MSG_THROTTLE_MS) {
    return false;
  }
  state._lastSent = state._lastSent ?? {};
  state._lastSent[key] = now;
  airconsole.message(to, data);
  return true;
}

/** Cap delta-time to prevent physics explosion after tab resume (BP #6). */
export function cappedDt(rawMs) {
  return Math.min(rawMs, DT_CAP_MS);
}

/**
 * Classify getUserMedia errors into platform vs browser permission (BP #8).
 * Returns { kind: 'platform' | 'permission' | 'other', message: string }
 */
export function classifyMediaError(err) {
  if (err?.name === 'AirConsoleUserMediaError') {
    return { kind: 'platform', message: 'AirConsole platform denied microphone access.' };
  }
  if (err?.name === 'NotAllowedError') {
    return { kind: 'permission', message: 'Browser permission denied. Please allow microphone access.' };
  }
  return { kind: 'other', message: err?.message ?? 'Unknown media error.' };
}

/** Safely close an AudioContext and disconnect nodes (BP #7). */
export async function teardownAudio({ context, nodes = [] } = {}) {
  nodes.forEach(n => { try { n.disconnect(); } catch (_) {} });
  if (context && context.state !== 'closed') {
    try { await context.close(); } catch (_) {}
  }
}
