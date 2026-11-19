// A Settings section asked for before the page is on screen. The page takes it when it mounts or
// while it is open; one that nobody took within a few seconds is dropped.

const FRESH_MS = 5000;

let requested: { readonly id: string; readonly at: number } | undefined;
const listeners = new Set<() => void>();

export function requestSettingsSection(id: string, now: number = Date.now()): void {
    requested = { id, at: now };
    for (const listener of [...listeners]) listener();
}

export function takeRequestedSection(now: number = Date.now()): string | undefined {
    const current = requested;
    requested = undefined;
    return current !== undefined && now - current.at <= FRESH_MS ? current.id : undefined;
}

export function subscribeRequestedSection(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
