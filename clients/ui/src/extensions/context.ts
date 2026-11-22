import type { WhenContext } from "./when.ts";

type Value = string | number | boolean;

// An extension may set only keys that start with its own id and a dot.
export function ownsContextKey(extensionId: string, key: string): boolean {
    return key.startsWith(`${extensionId}.`) && key.length > extensionId.length + 1;
}

// The values `when` clauses read. A key with no value is absent, so it is false and equals nothing.
export class ContextKeys {
    private readonly values = new Map<string, Value>();
    private readonly listeners = new Set<() => void>();
    private cached: WhenContext | undefined;

    set(key: string, value: Value | undefined): void {
        if (value === undefined) {
            if (!this.values.delete(key)) return;
        } else {
            if (this.values.get(key) === value) return;
            this.values.set(key, value);
        }
        this.cached = undefined;
        for (const listener of [...this.listeners]) listener();
    }

    // Removes every key that starts with the prefix, as when an extension stops.
    clearPrefix(prefix: string): void {
        let changed = false;
        for (const key of [...this.values.keys()]) {
            if (key.startsWith(prefix) && this.values.delete(key)) changed = true;
        }
        if (!changed) return;
        this.cached = undefined;
        for (const listener of [...this.listeners]) listener();
    }

    // The same object until a key changes.
    snapshot(): WhenContext {
        this.cached ??= new Map(this.values);
        return this.cached;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

export interface FocusKeys {
    readonly view: string | undefined;
    readonly container: string | undefined;
    readonly entryKind: string | undefined;
}

// Where focus is, as the workbench marks it. Dialogs and menus keep the last place focus was.
export function readFocusKeys(target: Element | null): FocusKeys | undefined {
    if (target === null || target.closest("[aria-modal='true'], [data-overlay], [role='menu'], [role='listbox']") !== null) return undefined;
    return {
        view: target.closest("[data-view]")?.getAttribute("data-view") ?? undefined,
        container: target.closest("[data-container-body]")?.getAttribute("data-container-body") ?? undefined,
        entryKind: target.closest("[data-entry-kind]")?.getAttribute("data-entry-kind") ?? undefined,
    };
}
