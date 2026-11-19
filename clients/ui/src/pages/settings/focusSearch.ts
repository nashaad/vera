let pending = false;
const listeners = new Set<() => void>();

export function focusAndSelectSettingsSearch(input: Pick<HTMLInputElement, "focus" | "select">): void {
    input.focus();
    input.select();
}

export function requestSettingsSearchFocus(): void {
    pending = true;
    for (const listener of listeners) listener();
}

export function subscribeSettingsSearchFocus(listener: () => void): () => void {
    listeners.add(listener);
    if (pending) listener();
    return () => listeners.delete(listener);
}

export function takeSettingsSearchFocus(): boolean {
    const requested = pending;
    pending = false;
    return requested;
}
