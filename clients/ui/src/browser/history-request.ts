let version = 0;
let pending = false;
const listeners = new Set<() => void>();

export function requestHistory(): void {
    pending = true;
    version += 1;
    for (const listener of listeners) listener();
}

export function takeHistoryRequest(): boolean {
    if (!pending) return false;
    pending = false;
    return true;
}

export function subscribeHistoryRequest(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function historyRequestVersion(): number {
    return version;
}
