import { expect, test } from "bun:test";

import {
    handleTuiSettingsPickerKey,
    startTuiExtensionPicker,
    type TuiExtensionPickerState,
    type TuiSettingsPickerState,
} from "../../clients/tui/settings-picker.ts";
import type { TuiSettingsPickerKind } from "../../clients/tui/settings-picker-types.ts";
import {
    handleTuiCommandPaletteKey,
    startTuiCommandPalette,
} from "../../clients/tui/command-palette.ts";
import type { TuiPaletteEntry } from "../../clients/tui/commands.ts";
import {
    handleTuiTimelineKey,
    type TimelinePickerSelectState,
} from "../../clients/tui/timeline-picker.ts";
import {
    handleTuiPreferencesListKey,
    startTuiPreferencesList,
} from "../../clients/tui/preferences-list.ts";
import {
    handleTuiExtensionsListKey,
    openTuiExtensionsList,
} from "../../clients/tui/extensions-list.ts";
import { handleTuiHelpKey, startTuiHelp } from "../../clients/tui/help.ts";
import { handleTuiDiagnosticsDialogKey } from "../../clients/tui/diagnostics-dialog.ts";
import type { PermissionInspection } from "../../src/engine/permissions.ts";
import type { ExtensionListEntry } from "../../src/extensions/manager.ts";

// One-section screens from tui-keyboard-navigation.v1: Tab and the arrows a
// screen does not own are consumed, and ↑ ↓ stay at the edges.

interface Key {
    readonly name: string;
    readonly shift?: boolean;
    readonly sequence?: string;
}

interface Result {
    readonly handled: boolean;
    readonly index?: number;
}

interface Screen {
    readonly press: (key: Key) => { readonly next: Screen | undefined; readonly result: Result };
    readonly index: number;
}

const TAB_KEYS: readonly Key[] = [
    { name: "tab" },
    { name: "tab", shift: true },
    { name: "backtab" },
];

// A search box takes these before the list sees them.
const CARET_KEYS: readonly Key[] = [
    { name: "left" },
    { name: "right" },
    { name: "space", sequence: " " },
];

const rows = [
    { value: "one", label: "One", description: "" },
    { value: "two", label: "Two", description: "" },
    { value: "three", label: "Three", description: "" },
];

type PickerCase =
    | { readonly extra?: Partial<TuiSettingsPickerState> }
    | { readonly exception: string };

const PICKERS: Record<TuiSettingsPickerKind, PickerCase> = {
    model: { exception: "Switch model has several sections; its own tests cover them" },
    model_verification: { exception: "Verify library models: Tab toggles the unverified filter" },
    model_menu: {},
    provider: {},
    provider_actions: {},
    reasoning: {},
    permissions: {},
    theme: {},
    context_limit: {},
    overrides_settings: {},
    override_value: {},
    session: {},
    session_leave: {},
    session_preview: {
        exception: "Preview is a nested text page; Up/Down scroll, Escape returns to Resume",
    },
    session_create_leave: {},
    configure: {},
    settings: {},
    permission_settings: {},
    reviewer_settings: {},
    reviewer: {},
    model_assignment: {},
    model_defaults: {},
    pool_verify_scope: { extra: { verificationTargets: [] } },
    catalog_refresh_scope: {},
};

function listScreen<S extends { readonly selectedIndex: number }>(
    state: S,
    handle: (state: S, key: Key) => { readonly state?: S; readonly handled: boolean },
): Screen {
    return {
        index: state.selectedIndex,
        press: (key) => {
            const transition = handle(state, key);
            const next = transition.state;
            return {
                next: next === undefined ? undefined : listScreen(next, handle),
                result: { handled: transition.handled, index: next?.selectedIndex },
            };
        },
    };
}

function checkOneSection(
    name: string,
    open: () => Screen,
    options: { readonly searchable?: boolean } = {},
): void {
    const middle = open().press({ name: "down" }).next!;
    expect([name, middle.index]).toEqual([name, 1]);

    for (const key of options.searchable ? TAB_KEYS : [...TAB_KEYS, ...CARET_KEYS]) {
        const { result } = middle.press(key);
        expect([name, key, result]).toEqual([name, key, { handled: true, index: 1 }]);
    }
    if (options.searchable) {
        for (const key of CARET_KEYS) {
            const { next } = middle.press(key);
            expect([name, key, next?.index ?? 1]).toEqual([name, key, 1]);
        }
    }

    const top = open();
    expect([name, "up at the top", top.press({ name: "up" }).result])
        .toEqual([name, "up at the top", { handled: true, index: top.index }]);

    let bottom = top;
    for (let step = 0; step < 10; step += 1) {
        bottom = bottom.press({ name: "down" }).next!;
    }
    expect([name, "down at the bottom", bottom.press({ name: "down" }).result])
        .toEqual([name, "down at the bottom", { handled: true, index: bottom.index }]);
    expect(bottom.index).toBeGreaterThan(0);

    expect([name, "escape", open().press({ name: "escape" }).result.handled])
        .toEqual([name, "escape", true]);
}

test("every settings picker kind is one section or a named exception", () => {
    for (const [kind, entry] of Object.entries(PICKERS) as [TuiSettingsPickerKind, PickerCase][]) {
        if ("exception" in entry) {
            continue;
        }
        const state: TuiSettingsPickerState = {
            kind,
            title: kind,
            query: "",
            selectedIndex: 0,
            allOptions: rows,
            options: rows,
            ...entry.extra,
        } as TuiSettingsPickerState;
        checkOneSection(kind, () => listScreen(state, (current, key) => {
            const transition = handleTuiSettingsPickerKey(current, key);
            return { handled: transition.handled, state: transition.state as TuiSettingsPickerState | undefined };
        }));
    }
});

test("extension pickers are one section", () => {
    const state = startTuiExtensionPicker(
        "Agents",
        rows.map((row) => ({ id: row.value, label: row.label })),
    );
    checkOneSection("extension", () => listScreen(state, (current: TuiExtensionPickerState, key) => {
        const transition = handleTuiSettingsPickerKey(current, key);
        return { handled: transition.handled, state: transition.state };
    }));
});

const paletteEntries: readonly TuiPaletteEntry[] = ["rename", "model", "theme"].map((name) => ({
    name,
    label: name,
    description: "",
    group: "Session",
    slashName: name,
    action: { type: "prefill_composer", text: `/${name} ` },
}));

test("the command palette is one section", () => {
    checkOneSection(
        "command palette",
        () => listScreen(startTuiCommandPalette(paletteEntries), handleTuiCommandPaletteKey),
        { searchable: true },
    );
});

test("the rewind list is one section", () => {
    const boundary = (position: number) => ({
        userMessageId: `message-${position}`,
        timestamp: "2026-07-19T09:51:00.000Z",
        prompt: `prompt ${position}`,
        position,
    });
    const state: TimelinePickerSelectState = {
        screen: "select",
        boundaries: [boundary(4), boundary(2), boundary(0)],
        query: "",
        selectedIndex: 0,
    };
    checkOneSection("rewind", () => listScreen(state, (current, key) => {
        const transition = handleTuiTimelineKey(
            current,
            { ctrl: false, meta: false, super: false, hyper: false, sequence: "", ...key },
            () => "unused",
        );
        return { handled: transition.handled, state: transition.state as TimelinePickerSelectState | undefined };
    }), { searchable: true });
});

test("preferences are one section", () => {
    const inspection = {
        activeGrants: ["git", "ls", "cat"].map((executable) => ({
            id: executable,
            kind: "command",
            when: { tool: "bash", executable },
            scope: "session",
            lifetime: "session",
        })),
        activePreferences: [],
    } as unknown as PermissionInspection;
    checkOneSection(
        "preferences",
        () => listScreen(startTuiPreferencesList(inspection), handleTuiPreferencesListKey),
    );
});

test("the extensions list is one section", () => {
    const entries: ExtensionListEntry[] = ["alpha", "beta", "gamma"].map((id) => ({
        id,
        scope: "profile",
        enabled: true,
        managed: false,
        path: `/managed/${id}`,
        version: "0.1.0",
        capabilities: [],
    }));
    checkOneSection(
        "extensions",
        () => listScreen(openTuiExtensionsList(entries), handleTuiExtensionsListKey),
    );
});

test("the Help menu is one section", () => {
    const tabs = ["general", "keys", "slash_commands", "extensions"];
    const screen = (state: ReturnType<typeof startTuiHelp>): Screen => ({
        index: tabs.indexOf(state.tab),
        press: (key) => {
            const transition = handleTuiHelpKey(state, key);
            const next = transition.state;
            return {
                next: next === undefined ? undefined : screen(next),
                result: {
                    handled: transition.handled,
                    index: next === undefined ? undefined : tabs.indexOf(next.tab),
                },
            };
        },
    });
    checkOneSection("help menu", () => screen(startTuiHelp([], [])));
});

test("inspect dialogs consume Tab and the arrows they do not use", () => {
    for (const key of [...TAB_KEYS, { name: "left" }, { name: "right" }, { name: "space" }]) {
        expect([key, handleTuiDiagnosticsDialogKey(key)]).toEqual([key, "consume"]);
    }
});
