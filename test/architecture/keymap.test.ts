import { expect, test } from "bun:test";
import { basename } from "node:path";

import {
    TUI_KEYMAP,
    TUI_KEY_SCOPES,
    isTuiComposerClearKey,
    tuiBindingId,
    tuiChordOwner,
    tuiKeyHint,
    tuiKeymapConflicts,
    WORKSPACE_JUMP_IDS,
} from "../../clients/tui/keymap.ts";
import type { TuiKeyScope } from "../../clients/tui/keymap.ts";

/** `dials` is a scope the table uses but `TUI_KEY_SCOPES` does not list. */
const EVERY_SCOPE: readonly TuiKeyScope[] = [...TUI_KEY_SCOPES, "dials"];

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

/**
 * Every binding that changes state without showing the user a picker.
 *
 * Frozen on purpose. A new id may be picker-opening, or movement inside a
 * picker, or structural input this list already names; adding a new silent
 * toggle means editing this list, which is the review this test exists to
 * force. Blind cycling is the thing being kept out.
 */
const GRANDFATHERED_SILENT_BINDINGS = new Set([
    "interrupt",
    "toggle_thinking",
    "toggle_session_header",
    "cycle_agent_layout",
    "switch_pane",
    "toggle_workspace_sidebar",
    "cycle_live_session_prev",
    "cycle_live_session_next",
    // Not blind: the row moves under the pinned heading as the key is pressed,
    // and the side bar showing it is already on screen.
    "toggle_workspace_pin",
    ...WORKSPACE_JUMP_IDS,
    "workspace_new_session",
    "toggle_tool_details",
    "scroll_line_up",
    "scroll_line_down",
    "scroll_half_page_up",
    "scroll_half_page_down",
    "jump_to_bottom",
    "cycle-reasoning",
    "complete_command",
    "close_session",
    "focus_composer",
    "half_page_down",
    "half_page_up",
    "toggle_pooled",
    "undo_pool_change",
    "verify_pool",
    "refresh_catalog",
    "verify_model",
    "name_pooled",
    "open_providers",
    "declare_provider",
    "edit_endpoint",
    "forget_provider",
    "reveal_all_models",
    "switch_tab",
    "rename_session",
    "background_switch",
    "trash_session",
    "write_notes",
    "expand_call",
    "clear_secret",
    "next_form_field",
    "previous_form_field",
    "revoke_permission",
    "collapse_all",
    "expand_all",
    "next_help_tab",
    "cycle_search_filter",
    "toggle_search_scope",
    "switch_diagnostics_scope",
]);

test("no new binding changes state without showing a picker", () => {
    const offenders = TUI_KEYMAP
        .filter((binding) =>
            binding.remappable !== true
            && !GRANDFATHERED_SILENT_BINDINGS.has(binding.id)
        )
        .map((binding) => binding.id);
    expect(offenders).toEqual([]);
});

test("every remappable binding is one a user could find again", () => {
    // A remappable id has to be reachable from a surface that names it, which
    // in practice means it opens something. Movement ids live inside a picker
    // the user already opened, so they are named by that picker's hint line.
    for (const binding of TUI_KEYMAP) {
        if (binding.remappable === true) {
            expect(binding.description.length).toBeGreaterThan(0);
        }
    }
});

test("no two reachable bindings claim the same chord", () => {
    expect(tuiKeymapConflicts()).toEqual([]);
});

test("a surface can explicitly override a global chord while it is open", () => {
    expect(tuiBindingId("global", { name: "tab", shift: true }))
        .toBe("dials.open");
    expect(tuiBindingId("model_picker", { name: "tab", shift: true }))
        .toBe("switch_tab");
});

test("a scope sees its own bindings, the ones it inherits, and the globals", () => {
    expect(tuiBindingId("model_picker", { name: "s", ctrl: true }))
        .toBe("toggle_pooled");
    // Inherited from every picker rather than repeated per pane.
    expect(tuiBindingId("session_picker", { name: "d", ctrl: true }))
        .toBe("half_page_down");
    // Global reaches everywhere, which is what makes ctrl+c an escape hatch.
    expect(tuiBindingId("secret_prompt", { name: "c", ctrl: true }))
        .toBe("interrupt");
    // And a pane's own chord does not leak into a pane that never claimed it.
    expect(tuiBindingId("session_picker", { name: "s", ctrl: true }))
        .toBeUndefined();
    expect(tuiBindingId("session_picker", { name: "tab" }))
        .toBe("background_switch");
    // Ctrl+T belongs to transcript detail on the conversation surface, and
    // ctrl+E to provider connections inside the model picker; those surfaces
    // never overlap.
    expect(tuiBindingId("conversation", { name: "t", ctrl: true }))
        .toBe("toggle_tool_details");
    expect(tuiBindingId("model_picker", { name: "e", ctrl: true }))
        .toBe("open_providers");
    expect(tuiBindingId("global", { name: "[", ctrl: true, shift: true }))
        .toBe("cycle_live_session_prev");
    expect(tuiBindingId("global", { name: "]", ctrl: true, shift: true }))
        .toBe("cycle_live_session_next");
});

test("left and right move between the composer and workspace sidebar", () => {
    expect(tuiBindingId("unfocused", { name: "i" })).toBe("focus_composer");
    expect(tuiBindingId("unfocused", { name: "right" }))
        .toBe("focus_composer");
    // Left is structural pane movement, like the arrow movement inside lists,
    // so it stays outside the remappable keymap.
    expect(tuiBindingId("composer", { name: "left" })).toBeUndefined();
    expect(tuiBindingId("unfocused", { name: "tab" })).toBeUndefined();
    // Tab remains command completion, and a typed "i" remains text once the
    // composer holds focus.
    expect(tuiBindingId("composer", { name: "tab" })).toBe("complete_command");
    expect(tuiBindingId("composer", { name: "i" })).toBeUndefined();
});

test("Command or Super-Delete clears the focused composer draft", () => {
    expect(isTuiComposerClearKey({ name: "delete", meta: true })).toBe(true);
    expect(isTuiComposerClearKey({ name: "backspace", super: true })).toBe(true);
    expect(isTuiComposerClearKey({ name: "delete" })).toBe(false);
    expect(isTuiComposerClearKey({ name: "delete", option: true })).toBe(false);
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
    expect(tuiChordOwner("ctrl+y")?.extensionId).toBe("cycle-reasoning");
});

test("every hint belongs to a binding that exists", () => {
    for (const binding of TUI_KEYMAP) {
        if (binding.hint !== undefined) {
            expect(tuiKeyHint(binding.id)).toBe(binding.hint);
        }
    }
    expect(tuiKeyHint("not-a-binding")).toBe("");
});

test("the model picker chord is bound only in its shifted form", () => {
    expect(tuiBindingId("global", { name: "m", ctrl: true, shift: true }))
        .toBe("open_model_picker");
    // Ctrl+m is the byte Enter sends. Binding it would take the submit key.
    expect(tuiBindingId("global", { name: "m", ctrl: true })).toBeUndefined();
    expect(tuiBindingId("composer", { name: "m", ctrl: true })).toBeUndefined();
});

test("ctrl backslash and ctrl slash cycle the attached-agent layout", () => {
    expect(tuiBindingId("global", { name: "\\", ctrl: true }))
        .toBe("cycle_agent_layout");
    expect(tuiBindingId("global", { name: "/", ctrl: true }))
        .toBe("cycle_agent_layout");
    // Terminals commonly encode Ctrl+/ as the same control byte as Ctrl+_.
    expect(tuiBindingId("global", { name: "_", ctrl: true }))
        .toBe("cycle_agent_layout");
});

test("every binding id appears exactly once", () => {
    const seen = new Set<string>();
    const repeated: string[] = [];
    for (const binding of TUI_KEYMAP) {
        if (seen.has(binding.id)) {
            repeated.push(binding.id);
        }
        seen.add(binding.id);
    }
    expect(repeated).toEqual([]);
});

test("no binding claims the tmux prefix", () => {
    const offenders = TUI_KEYMAP
        .filter((binding) => binding.keys.includes("ctrl+b"))
        .map((binding) => binding.id);
    expect(offenders).toEqual([]);
});

/** The bindings the workspace side bar adds. */
const WORKSPACE_BINDINGS = [
    "switch_pane",
    "toggle_workspace_sidebar",
    // Not blind: the row moves under the pinned heading as the key is pressed,
    // and the side bar showing it is already on screen.
    "toggle_workspace_pin",
    ...WORKSPACE_JUMP_IDS,
];

test("a workspace chord is free in every scope it can be reached from", () => {
    const collisions: string[] = [];
    for (const id of WORKSPACE_BINDINGS) {
        const binding = TUI_KEYMAP.find((row) => row.id === id);
        expect(binding).toBeDefined();
        for (const chord of binding?.keys ?? []) {
            for (const scope of EVERY_SCOPE) {
                const owner = tuiChordOwner(chord, scope)?.id;
                if (owner !== undefined && owner !== id) {
                    collisions.push(`${chord} in ${scope}: ${owner} not ${id}`);
                }
            }
        }
    }
    expect(collisions).toEqual([]);
});

test("the workspace chords resolve to their own bindings", () => {
    expect(tuiBindingId("global", { name: "g", ctrl: true }))
        .toBe("switch_pane");
    expect(tuiBindingId("global", { name: "e", ctrl: true }))
        .toBe("toggle_workspace_sidebar");
    expect(WORKSPACE_JUMP_IDS).toHaveLength(9);
});

test("the workspace list inherits picker half-page movement", () => {
    expect(tuiBindingId("workspace", { name: "d", ctrl: true }))
        .toBe("half_page_down");
    expect(tuiBindingId("workspace", { name: "u", ctrl: true }))
        .toBe("half_page_up");
    expect(tuiChordOwner("ctrl+d", "workspace")?.id).toBe("half_page_down");
    // Other picker chords stay off the rail, so a later pane-only key does
    // not become a workspace key by descent.
    expect(tuiBindingId("workspace", { name: "s", ctrl: true }))
        .toBeUndefined();
});

test("ctrl+w closes the conversation from the composer, not from search", () => {
    expect(tuiBindingId("composer", { name: "w", ctrl: true }))
        .toBe("close_session");
    expect(tuiBindingId("search", { name: "w", ctrl: true }))
        .toBe("toggle_search_scope");
    expect(tuiBindingId("global", { name: "w", ctrl: true }))
        .toBeUndefined();
});

test("ctrl+n starts a new chat only while the agent sidebar holds focus", () => {
    expect(tuiBindingId("workspace", { name: "n", ctrl: true }))
        .toBe("workspace_new_session");
    // The model picker already names a pooled model with this chord.
    expect(tuiBindingId("model_picker", { name: "n", ctrl: true }))
        .toBe("name_pooled");
    expect(tuiBindingId("composer", { name: "n", ctrl: true }))
        .toBeUndefined();
    expect(tuiBindingId("global", { name: "n", ctrl: true }))
        .toBeUndefined();
});

test("a digit jumps only while the side bar holds focus", () => {
    for (const digit of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
        expect(tuiBindingId("workspace", { name: digit }))
            .toBe(`workspace_jump_${digit}`);
        // The composer types the digit. Nothing else in the TUI claims it.
        expect(tuiBindingId("composer", { name: digit })).toBeUndefined();
        expect(tuiBindingId("conversation", { name: digit })).toBeUndefined();
        expect(tuiBindingId("global", { name: digit })).toBeUndefined();
        // A ctrl digit is what the old shape bound, and no terminal reports it
        // outside the kitty keyboard protocol.
        expect(tuiBindingId("workspace", { name: digit, ctrl: true }))
            .toBeUndefined();
    }
});

test("the moved chords take nothing that already resolved", () => {
    // ctrl+e opens the side bar everywhere except inside the model picker,
    // which owns the chord for as long as it is open.
    expect(tuiBindingId("conversation", { name: "e", ctrl: true }))
        .toBe("toggle_workspace_sidebar");
    expect(tuiBindingId("composer", { name: "e", ctrl: true }))
        .toBe("toggle_workspace_sidebar");
    expect(tuiBindingId("model_picker", { name: "e", ctrl: true }))
        .toBe("open_providers");
    // ctrl+t reads tool details in the transcript, where nothing else answered.
    expect(tuiBindingId("conversation", { name: "t", ctrl: true }))
        .toBe("toggle_tool_details");
    expect(tuiBindingId("global", { name: "t", ctrl: true })).toBeUndefined();
    // ctrl+y is the reasoning cycle, and was free before this.
    expect(tuiBindingId("global", { name: "y", ctrl: true }))
        .toBe("cycle-reasoning");
    expect(tuiChordOwner("ctrl+y")?.extensionId).toBe("cycle-reasoning");
    // ctrl+shift+e is no longer bound anywhere.
    expect(tuiChordOwner("ctrl+shift+e")).toBeUndefined();
});
