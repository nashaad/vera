import { expect, test } from "bun:test";

import {
    NOTES_OFFER_LIMIT,
    notesOfferForNewSession,
    readNotesOffer,
    recordNotesOfferSent,
    storeNotesOffer,
} from "../../clients/ui/src/state/notesOffer.ts";

function memoryStorage(initial?: string) {
    const items = new Map<string, string>(initial === undefined ? [] : [["vera.notesOffer", initial]]);
    return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
}

test("@core the notes offer is on until the window switches it off, and the choice is read back", () => {
    const storage = memoryStorage();
    expect(readNotesOffer(storage)).toBe(true);
    storeNotesOffer(false, storage);
    expect(readNotesOffer(storage)).toBe(false);
    storeNotesOffer(true, storage);
    expect(readNotesOffer(storage)).toBe(true);
});

test("an unreadable or unexpected stored value keeps the offer on", () => {
    expect(readNotesOffer(memoryStorage("maybe"))).toBe(true);
    expect(readNotesOffer(undefined)).toBe(true);
    expect(readNotesOffer({ getItem: () => { throw new Error("blocked"); }, setItem: () => undefined })).toBe(true);
    expect(() => storeNotesOffer(false, { getItem: () => null, setItem: () => { throw new Error("blocked"); } })).not.toThrow();
});

test("@core the window offers notes to the first sessions after the switch is on, then stops", () => {
    const storage = memoryStorage();
    for (let created = 0; created < NOTES_OFFER_LIMIT; created += 1) {
        expect(notesOfferForNewSession(storage)).toBe(true);
        recordNotesOfferSent(storage);
    }
    expect(notesOfferForNewSession(storage)).toBe(false);
    recordNotesOfferSent(storage);
    expect(notesOfferForNewSession(storage)).toBe(false);
});

test("a session that was not created with the offer does not use one up", () => {
    const storage = memoryStorage();
    for (let created = 0; created < NOTES_OFFER_LIMIT + 2; created += 1) {
        expect(notesOfferForNewSession(storage)).toBe(true);
    }
});

test("@core turning the switch off and on again starts the count over", () => {
    const storage = memoryStorage();
    for (let created = 0; created < NOTES_OFFER_LIMIT; created += 1) recordNotesOfferSent(storage);
    expect(notesOfferForNewSession(storage)).toBe(false);

    storeNotesOffer(false, storage);
    expect(notesOfferForNewSession(storage)).toBe(false);
    storeNotesOffer(true, storage);
    expect(notesOfferForNewSession(storage)).toBe(true);
    recordNotesOfferSent(storage);
    expect(notesOfferForNewSession(storage)).toBe(true);
    recordNotesOfferSent(storage);
    expect(notesOfferForNewSession(storage)).toBe(false);
});

test("storing the switch as it already is keeps the count", () => {
    const storage = memoryStorage();
    for (let created = 0; created < NOTES_OFFER_LIMIT; created += 1) recordNotesOfferSent(storage);
    storeNotesOffer(true, storage);
    expect(notesOfferForNewSession(storage)).toBe(false);
});

test("a count that cannot be read counts as used up", () => {
    expect(notesOfferForNewSession(undefined)).toBe(false);
    expect(notesOfferForNewSession(memoryStorage())).toBe(true);
    const items = new Map<string, string>([["vera.notesOfferSent", "many"]]);
    expect(notesOfferForNewSession({ getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) })).toBe(false);
    expect(notesOfferForNewSession({ getItem: () => { throw new Error("blocked"); }, setItem: () => undefined })).toBe(false);
    expect(() => recordNotesOfferSent({ getItem: () => null, setItem: () => { throw new Error("blocked"); } })).not.toThrow();
});
