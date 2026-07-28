import { expect, test } from "bun:test";
import { basename } from "node:path";

import {
    TUI_KEYMAP,
    tuiBindingId,
    tuiChordOwner,
    tuiKeyHint,
    tuiKeymapConflicts,
} from "../../clients/tui/keymap.ts";

/** Files allowed to name a chord, because they are where the table lives. */
const KEYMAP_OWNERS = new Set(["keymap.ts"]);

/**
 * The one place a key name is read without the table, and why.
 *
 * An extension pane declares its own actions as `{ key: "delete", label: ... }`,
 * so the four names an extension may ask for are a slot list, not chords Vera
 * claims. Reading them through the keymap would mean inventing a binding per
 * extension at runtime to describe keys the extension already named.
 */
const SLOT_PARSER = /function extensionPickerActionKey\([^]*?\n}/;

/**
 * The chords this test hunts for: a modified key, or one of the named action
 * keys a binding can claim. Cursor movement, enter, escape and backspace are
 * deliberately absent, since those are structural input rather than bindings.
 */
const CHORD_MATCH =
    /key\.ctrl\s*&&\s*key\.name\s*===|key\.name\s*===\s*"(?:delete|tab)"/g;

test("no TUI surface matches a chord outside the keymap", async () => {
    const files = new Bun.Glob("clients/tui/**/*.ts").scan({
        cwd: process.cwd(),
        absolute: true,
    });
    const offenders: string[] = [];

    for await (const path of files) {
        if (KEYMAP_OWNERS.has(basename(path))) {
            continue;
        }
        const source = (await Bun.file(path).text()).replace(SLOT_PARSER, "");
        if ((source.match(CHORD_MATCH) ?? []).length > 0) {
            offenders.push(basename(path));
        }
    }

    // A chord claimed at a handler is a chord nothing else can see, which is
    // how ctrl+p ended up owned by three places at once.
    expect(offenders).toEqual([]);
});

test("no two reachable bindings claim the same chord", () => {
    expect(tuiKeymapConflicts()).toEqual([]);
});

test("a scope sees its own bindings, the ones it inherits, and the globals", () => {
    expect(tuiBindingId("model_picker", { name: "s", ctrl: true }))
        .toBe("toggle_pinned");
    // Inherited from every picker rather than repeated per pane.
    expect(tuiBindingId("session_picker", { name: "d", ctrl: true }))
        .toBe("half_page_down");
    // Global reaches everywhere, which is what makes ctrl+c an escape hatch.
    expect(tuiBindingId("secret_prompt", { name: "c", ctrl: true }))
        .toBe("interrupt");
    // And a pane's own chord does not leak into a pane that never claimed it.
    expect(tuiBindingId("session_picker", { name: "s", ctrl: true }))
        .toBeUndefined();
});

test("the escape hatches survive the modifiers a terminal invents", () => {
    // A terminal that delivers ESC immediately before ctrl+c reports the pair
    // as meta+ctrl+c. Quitting must not depend on how fast the bytes arrived.
    expect(tuiBindingId("global", { name: "c", ctrl: true, meta: true }))
        .toBe("interrupt");
    // Everything else stays exact, so a stray modifier does not pin a model.
    expect(tuiBindingId("model_picker", { name: "s", ctrl: true, meta: true }))
        .toBeUndefined();
});

test("an extension chord that a built-in owns is reported, not silently lost", () => {
    expect(tuiChordOwner("ctrl+p")?.id).toBe("open_palette");
    expect(tuiChordOwner("ctrl+j")).toBeUndefined();
    // The two bundled extensions are in the table, so they are answerable as
    // "what is this key" without being reported against themselves.
    expect(tuiChordOwner("ctrl+t")?.extensionId).toBe("cycle-reasoning");
});

test("every hint belongs to a binding that exists", () => {
    for (const binding of TUI_KEYMAP) {
        if (binding.hint !== undefined) {
            expect(tuiKeyHint(binding.id)).toBe(binding.hint);
        }
    }
    expect(tuiKeyHint("not-a-binding")).toBe("");
});
