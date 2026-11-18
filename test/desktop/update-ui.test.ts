import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { DesktopEvent } from "../../clients/ui/src/protocol/bridge.ts";
import { INITIAL_UPDATE_STATE, type UpdateAction, type UpdateState } from "../../clients/ui/src/protocol/updates.ts";
import { UpdatesPanel } from "../../clients/ui/src/pages/settings/UpdatesSection.tsx";
import { UpdateChipButton } from "../../clients/ui/src/updates/UpdateChip.tsx";
import { UpdateSheetFrame } from "../../clients/ui/src/updates/UpdateSheet.tsx";
import { canCheckNow, chipOf, sheetOf, updateStatusLine, UPDATE_NOTE, waitDuration } from "../../clients/ui/src/updates/model.ts";
import { createUpdateStore, type UpdateBridge } from "../../clients/ui/src/updates/store.ts";

function state(over: Partial<UpdateState> = {}): UpdateState {
    return { ...INITIAL_UPDATE_STATE, capable: true, currentVersion: "1.0.0", ...over };
}

const AVAILABLE = state({ offer: { status: "available", latestVersion: "1.1.0" } });

test("@core the chip shows only for an offer, in a window that can update, with the mode on and nothing running", () => {
    expect(chipOf(AVAILABLE)).toEqual({ label: "Update available", title: "Vera 1.1.0 is available", busy: false });
    expect(chipOf(state({ offer: { status: "downloaded", latestVersion: "1.1.0" } }))).toEqual({ label: "Update ready", title: "Vera 1.1.0 is downloaded and ready", busy: false });
    expect(chipOf(state({ offer: { status: "available" } }))?.title).toBe("Vera is available");
    expect(chipOf(state())).toBeUndefined();
    expect(chipOf({ ...AVAILABLE, mode: "off" })).toBeUndefined();
    expect(chipOf({ ...AVAILABLE, capable: false })).toBeUndefined();
    expect(chipOf({ ...AVAILABLE, background: true })).toBeUndefined();
    expect(chipOf({ ...AVAILABLE, run: { kind: "downloading", bytes: 1 } })).toEqual({ label: "Updating", title: "Vera 1.1.0 is being installed", busy: true });
    expect(chipOf({ ...AVAILABLE, run: { kind: "ended", result: "failed" } })?.busy).toBe(false);
});

test("@core the sheet offers the update first, then follows the run, then says how it ended", () => {
    expect(sheetOf(AVAILABLE)).toEqual({ kind: "offer", lines: ["You have Vera 1.0.0.", "Vera 1.1.0 is available."], note: UPDATE_NOTE });
    expect(sheetOf(state({ offer: { status: "downloaded", latestVersion: "1.1.0" } }))).toMatchObject({ lines: ["You have Vera 1.0.0.", "Vera 1.1.0 is downloaded and ready."] });
    expect(sheetOf({ ...AVAILABLE, currentVersion: undefined, offer: { status: "available" } })).toMatchObject({ lines: ["A new version of Vera is available."] });

    expect(sheetOf({ ...AVAILABLE, run: { kind: "checking" } })).toMatchObject({ kind: "working", heading: "Checking for the update", cancellable: true });
    expect(sheetOf({ ...AVAILABLE, run: { kind: "downloading", bytes: 5_000_000, total: 10_000_000 } })).toMatchObject({ kind: "working", heading: "Downloading Vera 1.1.0", fraction: 0.5, cancellable: true });
    expect(sheetOf({ ...AVAILABLE, run: { kind: "downloading", bytes: 5_000_000 } })).not.toHaveProperty("fraction");
    expect(sheetOf({ ...AVAILABLE, run: { kind: "downloading", bytes: 20, total: 10 } })).toMatchObject({ fraction: 1 });
    expect(sheetOf({
        ...AVAILABLE,
        run: { kind: "waiting", sessions: [{ id: "a", title: "Fix the build" }, { id: "b", title: "" }], waitedMs: 30_000, limitMs: 600_000 },
    })).toEqual({
        kind: "working",
        heading: "Waiting for running work to finish",
        detail: "Waited 30 s of 10 min.",
        sessions: ["Fix the build", "b"],
        cancellable: true,
    });
    expect(sheetOf({ ...AVAILABLE, run: { kind: "switching" } })).toMatchObject({ kind: "working", heading: "Switching to the new version", cancellable: false });

    expect(sheetOf({ ...AVAILABLE, run: { kind: "ended", result: "done", version: "1.1.0" } })).toEqual({ kind: "ended", result: "done", heading: "Updated to Vera 1.1.0.", retry: false });
    expect(sheetOf({ ...AVAILABLE, run: { kind: "ended", result: "done" } })).toMatchObject({ heading: "Updated." });
    expect(sheetOf({ ...AVAILABLE, run: { kind: "ended", result: "up_to_date" } })).toMatchObject({ heading: "Vera is up to date.", retry: false });
    expect(sheetOf({ ...AVAILABLE, run: { kind: "ended", result: "held", message: "Vera.app cannot be replaced." } })).toEqual({ kind: "ended", result: "held", heading: "Update held", detail: "Vera.app cannot be replaced.", retry: false });
    expect(sheetOf({ ...AVAILABLE, run: { kind: "ended", result: "failed", message: "The download stopped." } })).toEqual({
        kind: "ended",
        result: "failed",
        heading: "The update did not finish. Nothing was changed.",
        detail: "The download stopped.",
        retry: true,
    });
    expect(sheetOf({ ...AVAILABLE, run: { kind: "ended", result: "cancelled" } })).toEqual({ kind: "ended", result: "cancelled", heading: "Update cancelled. Nothing was changed.", retry: true });
});

test("the sheet with no offer says the build is current, or why the update is held", () => {
    expect(sheetOf(state())).toEqual({ kind: "none", text: "Vera is up to date." });
    expect(sheetOf(state({ held: "Vera.app cannot be replaced." }))).toEqual({ kind: "none", text: "Vera.app cannot be replaced." });
});

test("waits are shown in seconds under a minute and minutes after", () => {
    expect(waitDuration(0)).toBe("0 s");
    expect(waitDuration(59_400)).toBe("59 s");
    expect(waitDuration(60_000)).toBe("1 min");
    expect(waitDuration(600_000)).toBe("10 min");
});

test("the settings line says what the last check found, and Check now is off while anything runs", () => {
    expect(updateStatusLine(state({ capable: false }))).toBe("Updates are not available in this window.");
    expect(updateStatusLine(state({ mode: "off" }))).toBe("Updates are off.");
    expect(updateStatusLine({ ...AVAILABLE, run: { kind: "switching" } })).toBe("Updating.");
    expect(updateStatusLine(state({ checking: true }))).toBe("Checking for updates.");
    expect(updateStatusLine({ ...AVAILABLE, background: true })).toBe("Downloading Vera 1.1.0 in the background.");
    expect(updateStatusLine(AVAILABLE)).toBe("Vera 1.1.0 is available.");
    expect(updateStatusLine(state({ offer: { status: "downloaded", latestVersion: "1.1.0" } }))).toBe("Vera 1.1.0 is downloaded and ready.");
    expect(updateStatusLine(state({ held: "Held for a newer shell." }))).toBe("Held for a newer shell.");
    expect(updateStatusLine(state({ problem: "no network" }))).toBe("Could not check: no network");
    expect(updateStatusLine(state())).toBe("Vera 1.0.0 is up to date.");
    expect(updateStatusLine({ ...INITIAL_UPDATE_STATE, capable: true })).toBe("Not checked yet.");

    expect(canCheckNow(state())).toBe(true);
    expect(canCheckNow(state({ capable: false }))).toBe(false);
    expect(canCheckNow(state({ mode: "off" }))).toBe(false);
    expect(canCheckNow(state({ checking: true }))).toBe(false);
    expect(canCheckNow(state({ background: true }))).toBe(false);
    expect(canCheckNow({ ...AVAILABLE, run: { kind: "waiting", sessions: [], waitedMs: 0, limitMs: 1 } })).toBe(false);
    expect(canCheckNow({ ...AVAILABLE, run: { kind: "ended", result: "failed" } })).toBe(true);
});

test("@core the chip draws a button with its label, and nothing when there is no update", () => {
    const html = renderToStaticMarkup(createElement(UpdateChipButton, { state: AVAILABLE }));
    expect(html).toContain('data-item="update"');
    expect(html).toContain("Update available");
    expect(html).toContain('title="Vera 1.1.0 is available"');
    expect(renderToStaticMarkup(createElement(UpdateChipButton, { state: state() }))).toBe("");
    expect(renderToStaticMarkup(createElement(UpdateChipButton, { state: { ...AVAILABLE, mode: "off" } }))).toBe("");
});

function sheet(value: UpdateState): string {
    return renderToStaticMarkup(createElement(UpdateSheetFrame, { state: value, onClose: () => undefined }));
}

test("@core the sheet shows the versions and the note with Update now and Later, then Cancel while it waits, then the outcome", () => {
    const offer = sheet(AVAILABLE);
    expect(offer).toContain("Update Vera");
    expect(offer).toContain("You have Vera 1.0.0.");
    expect(offer).toContain("Vera 1.1.0 is available.");
    expect(offer).toContain(UPDATE_NOTE);
    expect(offer).toContain('data-action="update"');
    expect(offer).toContain('data-action="later"');
    expect(offer).not.toContain('data-action="cancel"');

    const waiting = sheet({ ...AVAILABLE, run: { kind: "waiting", sessions: [{ id: "a", title: "Fix the build" }], waitedMs: 1000, limitMs: 600_000 } });
    expect(waiting).toContain("Waiting for running work to finish");
    expect(waiting).toContain("Fix the build");
    expect(waiting).toContain('data-action="cancel"');
    expect(waiting).not.toContain('data-action="update"');

    const switching = sheet({ ...AVAILABLE, run: { kind: "switching" } });
    expect(switching).toContain("Switching to the new version");
    expect(switching).not.toContain("data-action=");

    const downloading = sheet({ ...AVAILABLE, run: { kind: "downloading", bytes: 1_000_000, total: 4_000_000 } });
    expect(downloading).toContain("<progress");

    const failed = sheet({ ...AVAILABLE, run: { kind: "ended", result: "failed", message: "The download stopped." } });
    expect(failed).toContain("The update did not finish. Nothing was changed.");
    expect(failed).toContain("The download stopped.");
    expect(failed).toContain("Try again");
    expect(failed).toContain('data-action="close"');

    const held = sheet({ ...AVAILABLE, offer: undefined, run: { kind: "ended", result: "held", message: "Vera.app cannot be replaced." } });
    expect(held).toContain("Update held");
    expect(held).toContain("Vera.app cannot be replaced.");
    expect(held).not.toContain('data-action="update"');

    const current = sheet({ ...AVAILABLE, offer: undefined, run: { kind: "ended", result: "up_to_date" } });
    expect(current).toContain("Vera is up to date.");
});

test("@core Settings > Updates shows the three modes with the saved one chosen, any problem, and Check now", () => {
    const html = renderToStaticMarkup(createElement(UpdatesPanel, { state: state({ mode: "automatic" }) }));
    expect(html).toContain("Updates");
    for (const label of ["Ask", "Automatic", "Off"]) expect(html).toContain(label);
    expect(html).toContain("Check now");
    expect(html).toContain("Vera 1.0.0 is up to date.");
    expect(html).not.toContain("Could not save");
    expect(html).not.toMatch(/data-action="check"[^>]*disabled/);

    const off = renderToStaticMarkup(createElement(UpdatesPanel, { state: state({ mode: "off", modeProblem: "config.json could not be read" }) }));
    expect(off).toContain("Could not save the setting: config.json could not be read");
    expect(off).toContain("Updates are off.");
    expect(off).toMatch(/data-action="check"[^>]*disabled|disabled[^>]*data-action="check"/);
});

interface FakeBridge extends UpdateBridge {
    readonly acts: UpdateAction[];
    emit(state: UpdateState): void;
    listeners(): number;
    answerInitial(state: UpdateState | undefined): void;
}

function fakeBridge(): FakeBridge {
    const listeners = new Set<(event: DesktopEvent) => void>();
    const acts: UpdateAction[] = [];
    let answer: (state: UpdateState | undefined) => void = () => undefined;
    return {
        acts,
        onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        updateState: () => new Promise((resolve) => { answer = resolve; }),
        updateAct: (action) => { acts.push(action); },
        emit: (value) => { for (const listener of listeners) listener({ type: "update_state", state: value }); },
        listeners: () => listeners.size,
        answerInitial: (value) => answer(value),
    } as FakeBridge;
}

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

test("@core the store listens only while something is subscribed, takes the first answer and then the shell's events", async () => {
    const bridge = fakeBridge();
    const store = createUpdateStore(() => bridge);
    expect(store.current()).toBe(INITIAL_UPDATE_STATE);
    expect(bridge.listeners()).toBe(0);

    const seen: UpdateState[] = [];
    const stop = store.subscribe(() => seen.push(store.current()));
    expect(bridge.listeners()).toBe(1);
    bridge.answerInitial(AVAILABLE);
    await settle();
    expect(store.current()).toBe(AVAILABLE);

    const next = state({ mode: "off" });
    bridge.emit(next);
    expect(store.current()).toBe(next);
    expect(seen).toHaveLength(2);

    store.act({ kind: "run" });
    expect(bridge.acts).toEqual([{ kind: "run" }]);

    stop();
    expect(bridge.listeners()).toBe(0);
});

test("an event that arrives before the first answer is not replaced by it, and a window with no bridge stays at the start", async () => {
    const bridge = fakeBridge();
    const store = createUpdateStore(() => bridge);
    store.subscribe(() => undefined);
    bridge.emit(AVAILABLE);
    bridge.answerInitial(state({ mode: "off" }));
    await settle();
    expect(store.current()).toBe(AVAILABLE);

    const none = createUpdateStore(() => undefined);
    const stop = none.subscribe(() => undefined);
    none.act({ kind: "check" });
    expect(none.current()).toBe(INITIAL_UPDATE_STATE);
    stop();
});
