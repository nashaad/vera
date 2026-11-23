const listeners = new Set<() => void>();

export function subscribeProviderModelSelected(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function notifyProviderModelSelected(): void {
    for (const listener of listeners) listener();
}
