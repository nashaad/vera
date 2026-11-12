// Every timer rate in the desktop UI.

// Streamed text is applied to the transcript at most this often.
export const STREAM_FLUSH_MS = 250;
// The same, while the window is hidden or not focused.
export const STREAM_BACKGROUND_FLUSH_MS = 1_000;
// Session list refresh while attached to the host.
export const HOST_POLL_MS = 3_000;
// Relative times on the work page ("5m ago").
export const NOW_TICK_MS = 60_000;
