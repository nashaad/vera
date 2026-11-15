import type { DesktopExtensionEntry } from "../protocol/extensions.ts";

// The desktop extensions this window knows about, from the last list or change the desktop shell answered.
// Nothing is known until the first answer, so everything an extension adds stays hidden until then.
let entries: readonly DesktopExtensionEntry[] | undefined;
const listeners = new Set<() => void>();

export function setDesktopExtensions(next: readonly DesktopExtensionEntry[]): void {
    entries = next;
    for (const listener of listeners) listener();
}

export function isExtensionOn(id: string): boolean {
    return entries?.some((entry) => entry.id === id && entry.enabled) ?? false;
}

export function subscribeDesktopExtensions(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
