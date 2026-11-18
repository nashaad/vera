let version = 0;
let pending: string | undefined;
const listeners = new Set<() => void>();

export function requestAddress(tab: string): void {
    pending = tab;
    version += 1;
    for (const listener of listeners) listener();
}

export function takeAddressRequest(tab: string): boolean {
    if (pending !== tab) return false;
    pending = undefined;
    return true;
}

export function subscribeAddressRequest(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function addressRequestVersion(): number {
    return version;
}
