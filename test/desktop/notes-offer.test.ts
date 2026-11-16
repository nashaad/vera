import { expect, test } from "bun:test";

import { readNotesOffer, storeNotesOffer } from "../../clients/ui/src/state/notesOffer.ts";

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
