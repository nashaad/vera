// Pinned sessions, oldest pin first. The desktop keeps them in its own file under the home.
export interface SavedPins {
    readonly sessions: readonly string[];
}

export const MAX_PINS = 50;
const MAX_PIN_ID_CHARS = 256;

export const NO_PINS: SavedPins = { sessions: [] };

function isPinId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_PIN_ID_CHARS;
}

// Repeats are dropped and only the newest MAX_PINS are kept; any other damage rejects the whole value.
export function parsePins(value: unknown): SavedPins | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const sessions = (value as Record<string, unknown>).sessions;
    if (!Array.isArray(sessions) || !sessions.every(isPinId)) return undefined;
    return { sessions: [...new Set(sessions)].slice(-MAX_PINS) };
}

// A new pin goes last; past the cap the oldest pin is dropped.
export function togglePin(pins: SavedPins, id: string): SavedPins {
    if (pins.sessions.includes(id)) return { sessions: pins.sessions.filter((pinned) => pinned !== id) };
    return { sessions: [...pins.sessions, id].slice(-MAX_PINS) };
}
