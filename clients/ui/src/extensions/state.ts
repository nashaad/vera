import type { DesktopExtensionDiagnostic, DesktopExtensionEntry } from "../protocol/extensions.ts";

// The desktop extensions this window knows about, from the last list or change the desktop shell answered.
// Nothing is known until the first answer, so everything an extension adds stays hidden until then.
let entries: readonly DesktopExtensionEntry[] | undefined;
let diagnostics: readonly DesktopExtensionDiagnostic[] = [];
let listingNote: string | undefined;
const listeners = new Set<(replacedId?: string) => void>();

export function setDesktopExtensions(next: readonly DesktopExtensionEntry[], replacedId?: string, problems: readonly DesktopExtensionDiagnostic[] = [], note?: string): void {
    entries = next;
    diagnostics = problems;
    listingNote = note;
    for (const listener of listeners) listener(replacedId);
}

export function desktopExtensions(): readonly DesktopExtensionEntry[] | undefined {
    return entries;
}

export function desktopExtensionDiagnostics(): readonly DesktopExtensionDiagnostic[] {
    return diagnostics;
}

export function desktopExtensionListingNote(): string | undefined {
    return listingNote;
}

export function isExtensionOn(id: string): boolean {
    return entries?.some((entry) => entry.id === id && entry.enabled) ?? false;
}

export function subscribeDesktopExtensions(listener: (replacedId?: string) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
