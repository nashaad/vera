interface SearchFocusRequest {
    request(): void;
    subscribe(listener: () => void): () => void;
    take(): boolean;
}

export function createSearchFocusRequest(): SearchFocusRequest {
    let pending = false;
    const listeners = new Set<() => void>();
    return {
        request() {
            pending = true;
            for (const listener of listeners) listener();
        },
        subscribe(listener) {
            listeners.add(listener);
            if (pending) listener();
            return () => listeners.delete(listener);
        },
        take() {
            const requested = pending;
            pending = false;
            return requested;
        },
    };
}

export const settingsSearchFocus = createSearchFocusRequest();
export const sessionSearchFocus = createSearchFocusRequest();

export function focusAndSelectSearch(input: Pick<HTMLInputElement, "focus" | "select">): void {
    input.focus();
    input.select();
}
