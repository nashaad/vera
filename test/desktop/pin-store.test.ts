import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PinStore, pinsPath } from "../../clients/desktop/src/pin-store.ts";
import { MAX_PINS, NO_PINS, parsePins, togglePin } from "../../clients/ui/src/protocol/pins.ts";

const homes: string[] = [];

function trialHome(): string {
    const home = mkdtempSync(join(tmpdir(), "vera-pin-store-"));
    homes.push(home);
    return home;
}

afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("@core pins live in the desktop directory of the home and read back from a real file", () => {
    const home = trialHome();
    const path = pinsPath(home);
    expect(path).toBe(join(home, "machine", "desktop", "pins.json"));
    const store = new PinStore(path);
    expect(store.load()).toBeUndefined();
    expect(existsSync(join(home, "machine"))).toBe(false);
    expect(store.save({ sessions: ["crow-1", "crow-2"] })).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ sessions: ["crow-1", "crow-2"] });
    expect(new PinStore(path).load()).toEqual({ sessions: ["crow-1", "crow-2"] });
});

test("@core a damaged pins file is kept aside and a later pin still saves", () => {
    for (const text of ["{ not json", "[]", JSON.stringify({ sessions: "crow-1" }), JSON.stringify({ sessions: [""] })]) {
        const home = trialHome();
        const path = pinsPath(home);
        mkdirSync(join(home, "machine", "desktop"), { recursive: true });
        writeFileSync(path, text);
        const store = new PinStore(path);
        expect(store.load()).toBeUndefined();
        expect(readFileSync(`${path}.bad`, "utf8")).toBe(text);
        expect(store.save(togglePin(NO_PINS, "crow-1"))).toBe(true);
        expect(store.load()).toEqual({ sessions: ["crow-1"] });
    }
});

test("a save of something that is not a pin list writes nothing", () => {
    const home = trialHome();
    const store = new PinStore(pinsPath(home));
    expect(store.save({ sessions: [42] })).toBe(false);
    expect(store.save(null)).toBe(false);
    expect(existsSync(pinsPath(home))).toBe(false);
});

test("pinning appends, unpinning removes, and past the cap the oldest pin goes", () => {
    const one = togglePin(NO_PINS, "a");
    const two = togglePin(one, "b");
    expect(two.sessions).toEqual(["a", "b"]);
    expect(togglePin(two, "a").sessions).toEqual(["b"]);
    let full = NO_PINS;
    for (let index = 0; index < MAX_PINS; index += 1) full = togglePin(full, `s${index}`);
    const over = togglePin(full, "newest");
    expect(over.sessions).toHaveLength(MAX_PINS);
    expect(over.sessions[0]).toBe("s1");
    expect(over.sessions.at(-1)).toBe("newest");
});

test("a read drops repeats and keeps only the newest pins", () => {
    expect(parsePins({ sessions: ["a", "b", "a"] })).toEqual({ sessions: ["a", "b"] });
    const many = Array.from({ length: MAX_PINS + 5 }, (_, index) => `s${index}`);
    expect(parsePins({ sessions: many })?.sessions).toEqual(many.slice(-MAX_PINS));
    expect(parsePins({ sessions: ["x".repeat(257)] })).toBeUndefined();
});
