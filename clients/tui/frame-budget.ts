// How often the TUI draws. Animations keep their speed and skip frames between ticks.

// Upper bound on every requested frame, including keypress echo.
export const RENDERER_MAX_FPS = 15;

// Transcript repaint while agent updates stream in.
export const STREAM_RENDER_INTERVAL_MS = 250;

// Status line tick while any status element animates.
export const STATUS_ANIMATING_INTERVAL_MS = 250;

// Status line tick while a turn runs with effects off.
export const STATUS_STATIC_INTERVAL_MS = 1_000;

// Status line tick while nothing on it is running.
export const STATUS_IDLE_INTERVAL_MS = 1_000;

// Minimum gap between refreshes of timed surfaces such as the resume caret and workspace rail.
export const TIMED_SURFACE_REFRESH_INTERVAL_MS = 100;
