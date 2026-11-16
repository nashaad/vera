// Whether sessions started from this window may offer to keep notes. Kept in this window's storage; on unless switched off.
const STORAGE_KEY = "vera.notesOffer";

type NotesOfferStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): NotesOfferStorage | undefined {
    try {
        return window.localStorage;
    } catch {
        return undefined;
    }
}

export function readNotesOffer(storage: NotesOfferStorage | undefined = defaultStorage()): boolean {
    try {
        return storage?.getItem(STORAGE_KEY) !== "false";
    } catch {
        return true;
    }
}

export function storeNotesOffer(on: boolean, storage: NotesOfferStorage | undefined = defaultStorage()): void {
    try {
        storage?.setItem(STORAGE_KEY, on ? "true" : "false");
    } catch {
        // Storage can be unavailable in a sandboxed renderer; the choice still applies until reload.
    }
}

