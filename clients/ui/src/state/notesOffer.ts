// Whether sessions started from this window may offer to keep notes, and how many offers it has sent since the switch was last turned on. Kept in this window's storage; on unless switched off.
const STORAGE_KEY = "vera.notesOffer";
const SENT_KEY = "vera.notesOfferSent";

export const NOTES_OFFER_LIMIT = 2;

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
        const turnedOn = on && !readNotesOffer(storage);
        storage?.setItem(STORAGE_KEY, on ? "true" : "false");
        if (turnedOn) storage?.setItem(SENT_KEY, "0");
    } catch {
        // Storage can be unavailable in a sandboxed renderer; the choice still applies until reload.
    }
}

// A count that cannot be read counts as used up, so a window without storage never offers more than it is allowed to.
function offersSent(storage: NotesOfferStorage | undefined): number {
    if (storage === undefined) return NOTES_OFFER_LIMIT;
    try {
        const stored = storage.getItem(SENT_KEY);
        if (stored === null) return 0;
        const sent = Number(stored);
        return Number.isInteger(sent) && sent >= 0 ? sent : NOTES_OFFER_LIMIT;
    } catch {
        return NOTES_OFFER_LIMIT;
    }
}

export function notesOfferForNewSession(storage: NotesOfferStorage | undefined = defaultStorage()): boolean {
    return readNotesOffer(storage) && offersSent(storage) < NOTES_OFFER_LIMIT;
}

export function recordNotesOfferSent(storage: NotesOfferStorage | undefined = defaultStorage()): void {
    try {
        storage?.setItem(SENT_KEY, String(offersSent(storage) + 1));
    } catch {
        // A count that cannot be saved is not carried over; the session already has its offer.
    }
}
