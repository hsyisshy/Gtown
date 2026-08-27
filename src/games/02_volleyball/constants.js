export const W = 1280;
export const H = 720;
export const GROUND_Y = 610;
export const NET_X = 640;
export const NET_H = 160;
export const NET_W = 14;
export const NET_TOP = GROUND_Y - NET_H;
export const LEFT_WALL = 150;
export const RIGHT_WALL = W - 150;
export const GRAVITY_BASE = 980;
export const PLAYER_GRAVITY = 3200;
export const PLAYER_SPEED = 400;
export const JUMP_VELOCITY = -1000;
// Back-row (slot 0, the wall-side player) jumps higher than front-row —
// they stand farther from the net, so without extra height they rarely
// reach the isSpike threshold in physics.js before the ball drops past them.
export const JUMP_VELOCITY_BACK = -1150;
export const BALL_R = 22;
export const PLAYER_W = 58;
export const PLAYER_H = 92;
export const WIN_SCORE = 6;
export const POINT_PAUSE = 2.0;
export const HIT_RADIUS = 120;
export const HIT_WINDOW = 0.55;
export const HIT_COOLDOWN = 0.5;

// Spike steering — joystick tilt at the moment of the spike hit angles the
// shot instead of always firing straight across. Tilting toward the net
// (same direction the spike is already going) steepens vy into a fast,
// close-in kill; tilting back toward your own baseline flattens vy toward
// SPIKE_VY_MIN so the ball hangs in the air longer and carries deep into
// the opponent's court instead. See checkHits() in physics.js.
export const SPIKE_VX_BASE = 750;
export const SPIKE_VX_STEER = 150;
export const SPIKE_VY_BASE = 320;
export const SPIKE_VY_STEER = 280;
export const SPIKE_VY_MIN = 40;
