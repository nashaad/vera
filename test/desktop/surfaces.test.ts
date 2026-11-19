import { expect, test } from "bun:test";

import { LAYOUT_COMMANDS } from "../../clients/ui/src/commands/layout-commands.ts";
import { NAVIGATION_COMMANDS } from "../../clients/ui/src/commands/navigation-commands.ts";
import { OVERLAY_COMMANDS } from "../../clients/ui/src/commands/overlay-ids.ts";
import { PAGE_COMMANDS } from "../../clients/ui/src/commands/page-commands.ts";
import { CORE_CONTAINERS } from "../../clients/ui/src/registry/core.ts";
import { FLAG_KEYS, FLAG_SPECS, defaultFlags, type DesktopFlags, type FlagKey } from "../../clients/ui/src/state/desktopFlags.ts";
import {
    ALL_VISIBLE,
    GATED_COMMANDS,
    NO_EVIDENCE,
    emptyLocations,
    hiddenCommands,
    hiddenCommandsFor,
    parseHiddenIds,
    resolveVisibility,
    unavailableContainers,
    type SurfaceEvidence,
} from "../../clients/ui/src/state/surfaces.ts";
import { SHOW_ROWS, choicesFor, rowsIn } from "../../clients/ui/src/pages/settings/show.ts";

function flags(patch: Partial<Record<FlagKey, DesktopFlags[FlagKey]>> = {}, packaged = true): DesktopFlags {
    return { ...defaultFlags(packaged), ...patch };
}

function seen(patch: Partial<SurfaceEvidence>): SurfaceEvidence {
    return { ...NO_EVIDENCE, ...patch };
}

test("@core a fresh window with every flag on default shows only the browser", () => {
    const visible = resolveVisibility(flags(), NO_EVIDENCE);
    expect(FLAG_KEYS.filter((key) => visible[key])).toEqual(["browser"]);
});

test("@core on shows a part with no evidence and off hides it with all of it", () => {
    const all = Object.fromEntries(FLAG_KEYS.map((key) => [key, "on"])) as DesktopFlags;
    expect(resolveVisibility(all, NO_EVIDENCE)).toEqual(ALL_VISIBLE);
    const none = Object.fromEntries(FLAG_KEYS.map((key) => [key, "off"])) as DesktopFlags;
    const everything = seen({ sessions: 9, hostReady: true, review: true, plan: true, files: true, context: true, output: true, hostFailed: true });
    expect(FLAG_KEYS.filter((key) => resolveVisibility(none, everything)[key])).toEqual([]);
});

test("@core auto waits for each part's own evidence", () => {
    const cases: ReadonlyArray<readonly [FlagKey, Partial<SurfaceEvidence>, Partial<SurfaceEvidence>]> = [
        ["search", { sessions: 1 }, { sessions: 0 }],
        ["work", { sessions: 2 }, { sessions: 1 }],
        ["customize", { hostReady: true }, { sessions: 5 }],
        ["review", { review: true }, { plan: true }],
        ["plan", { plan: true }, { review: true }],
        ["files", { files: true }, { sessions: 5 }],
        ["output", { output: true }, { hostFailed: true }],
        ["contextPill", { context: true }, { sessions: 5 }],
        ["doctor", { hostFailed: true }, { output: true }],
    ];
    for (const [key, on, off] of cases) {
        expect(resolveVisibility(flags(), seen(on))[key]).toBe(true);
        expect(resolveVisibility(flags(), seen(off))[key]).toBe(false);
    }
});

test("@core every part that offers auto has a condition, and no other part follows evidence", () => {
    const everything = seen({ sessions: 9, hostReady: true, review: true, plan: true, files: true, context: true, output: true, hostFailed: true });
    for (const spec of FLAG_SPECS) {
        const asAuto = resolveVisibility({ ...flags(), [spec.key]: "auto" }, everything)[spec.key];
        expect(asAuto).toBe(spec.auto);
    }
});

test("the containers each flag controls leave the layout when the flag is off", () => {
    const hidden = unavailableContainers(resolveVisibility(flags(), NO_EVIDENCE));
    expect([...hidden].sort()).toEqual([CORE_CONTAINERS.files, CORE_CONTAINERS.output, CORE_CONTAINERS.plan, CORE_CONTAINERS.review].sort());
    expect(unavailableContainers(ALL_VISIBLE).size).toBe(0);
});

test("@core a flag that is off hides its commands, and one that is on keeps them", () => {
    const hidden = hiddenCommands(resolveVisibility(flags(), NO_EVIDENCE), emptyLocations(resolveVisibility(flags(), NO_EVIDENCE)));
    for (const id of [
        NAVIGATION_COMMANDS.search,
        NAVIGATION_COMMANDS.work,
        NAVIGATION_COMMANDS.customize,
        NAVIGATION_COMMANDS.devices,
        NAVIGATION_COMMANDS.tour,
        NAVIGATION_COMMANDS.coverage,
        OVERLAY_COMMANDS.doctor.id,
        OVERLAY_COMMANDS.diagnostics.id,
        OVERLAY_COMMANDS.failures.id,
        OVERLAY_COMMANDS.configure.id,
        OVERLAY_COMMANDS.nudges.id,
        OVERLAY_COMMANDS.extensions.id,
        LAYOUT_COMMANDS.togglePanel,
    ]) {
        expect(hidden.has(id)).toBe(true);
    }
    for (const id of Object.values(PAGE_COMMANDS)) expect(hidden.has(id)).toBe(false);
    expect(hidden.has(LAYOUT_COMMANDS.toggleRightPane)).toBe(false);
    expect(hidden.has(LAYOUT_COMMANDS.toggleSidebar)).toBe(false);
    expect(hidden.has(OVERLAY_COMMANDS.feedback.id)).toBe(false);
});

test("core commands are never gated", () => {
    for (const id of [
        LAYOUT_COMMANDS.toggleSidebar,
        OVERLAY_COMMANDS.palette.id,
        OVERLAY_COMMANDS.sessions.id,
        OVERLAY_COMMANDS.shortcuts.id,
        OVERLAY_COMMANDS.agent.id,
        OVERLAY_COMMANDS.themes.id,
        OVERLAY_COMMANDS.feedback.id,
        NAVIGATION_COMMANDS.newChat,
        NAVIGATION_COMMANDS.settings,
    ]) {
        expect(GATED_COMMANDS.has(id)).toBe(false);
    }
});

test("a toggle with nothing to open is hidden, and the browser keeps the right pane", () => {
    const off = flags({ browser: "off" });
    const visible = resolveVisibility(off, NO_EVIDENCE);
    expect(emptyLocations(visible)).toEqual({ rightPane: true, panel: true });
    expect(hiddenCommands(visible, emptyLocations(visible)).has(LAYOUT_COMMANDS.toggleRightPane)).toBe(true);
    const withFiles = resolveVisibility(off, seen({ files: true }));
    expect(emptyLocations(withFiles).rightPane).toBe(false);
});

test("the menu before the window reports follows only what the file turns on", () => {
    expect(hiddenCommandsFor(flags()).has(NAVIGATION_COMMANDS.work)).toBe(true);
    expect(hiddenCommandsFor(flags({ work: "on" })).has(NAVIGATION_COMMANDS.work)).toBe(false);
    expect(hiddenCommandsFor(flags({}, false)).has(NAVIGATION_COMMANDS.devices)).toBe(false);
});

test("@core the shell takes only gated command ids from the window", () => {
    expect([...(parseHiddenIds([NAVIGATION_COMMANDS.work, "layout.toggleSidebar", "no.such", NAVIGATION_COMMANDS.search]) ?? [])]).toEqual([
        NAVIGATION_COMMANDS.work,
        NAVIGATION_COMMANDS.search,
    ]);
    expect(parseHiddenIds([])?.size).toBe(0);
    for (const bad of [undefined, null, "go.work", { length: 1 }, [1], [NAVIGATION_COMMANDS.work, null], Array.from({ length: 65 }, () => "x")]) {
        expect(parseHiddenIds(bad)).toBeUndefined();
    }
});

test("@core Settings lists every flag once, and offers auto only where a condition exists", () => {
    expect(SHOW_ROWS.map((row) => row.key).sort()).toEqual([...FLAG_KEYS].sort());
    const listed = [...rowsIn("window"), ...rowsIn("developer")].map((row) => row.key);
    expect(listed.sort()).toEqual([...FLAG_KEYS].sort());
    for (const row of [...rowsIn("window"), ...rowsIn("developer")]) {
        expect(choicesFor(row.spec)).toEqual(row.spec.auto ? ["auto", "on", "off"] : ["on", "off"]);
    }
    expect(rowsIn("developer").every((row) => !row.spec.auto)).toBe(true);
});
