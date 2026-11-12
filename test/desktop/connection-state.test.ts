import { expect, test } from "bun:test";

import type { DesktopEvent } from "../../clients/ui/src/protocol/bridge.ts";
import {
    INITIAL_STATE,
    bannerFor,
    reduceConnection,
    toneOf,
    type UiAction,
    type UiState,
} from "../../clients/ui/src/state/connection.ts";

const READY: DesktopEvent = {
    type: "ready",
    pid: 42,
    socketPath: "/tmp/vera.sock",
    buildId: "abcdef1234",
    home: "/tmp/home",
};

function run(...actions: UiAction[]): UiState {
    return actions.reduce(reduceConnection, INITIAL_STATE);
}

const event = (value: DesktopEvent): UiAction => ({ type: "event", event: value });

test("@core a ready host attaches and the status bar facts fill in from the polls", () => {
    const state = run(
        event(READY),
        { type: "identity", identity: { pid: 42, protocol_version: 7 } },
        { type: "sessions", count: 3 },
    );
    expect(state).toMatchObject({
        phase: "attached",
        ready: { pid: 42, buildId: "abcdef1234", home: "/tmp/home" },
        identity: { protocol_version: 7 },
        sessions: 3,
    });
    expect(bannerFor(state)).toBeUndefined();
    expect(toneOf(state)).toBe("success");
});

test("@core losing the host drops live facts, keeps the last known build and home, and offers Reconnect", () => {
    const state = run(
        event(READY),
        { type: "identity", identity: { pid: 42, protocol_version: 7 } },
        { type: "sessions", count: 3 },
        event({ type: "disconnected", reason: "The host is not running." }),
    );
    expect(state.phase).toBe("disconnected");
    expect(state.ready?.home).toBe("/tmp/home");
    expect(state.identity).toBeUndefined();
    expect(state.sessions).toBeUndefined();
    expect(bannerFor(state)).toMatchObject({
        kind: "disconnected",
        tone: "warning",
        detail: "The host is not running.",
    });
});

test("@core a second loss report keeps the first reason", () => {
    const state = run(
        event(READY),
        { type: "lost", reason: "first" },
        { type: "lost", reason: "second" },
    );
    expect(state.failure).toBe("first");
});

test("@core a loss clears a pending question and reconnecting starts over with the old home", () => {
    const asked = run(event({ type: "question", id: "q1", text: "Restart?" }));
    expect(bannerFor(asked)).toMatchObject({ kind: "question", questionId: "q1" });
    const lost = reduceConnection(reduceConnection(asked, event(READY)), { type: "lost", reason: "x" });
    expect(lost.question).toBeUndefined();
    const again = reduceConnection(lost, { type: "reconnecting" });
    expect(again).toEqual({ phase: "starting", ready: lost.ready });
});

test("@core an answered question leaves the banner", () => {
    const state = run(
        event({ type: "question", id: "q1", text: "Restart?" }),
        { type: "answered" },
    );
    expect(state.question).toBeUndefined();
    expect(bannerFor(state)).toBeUndefined();
});

test("@core a missing install and a failed start are danger banners with their reason", () => {
    const missing = run(event({ type: "missing_cli", message: "not installed", checked: ["/a"] }));
    expect(bannerFor(missing)).toMatchObject({ kind: "missing", tone: "danger" });
    expect(missing.checked).toEqual(["/a"]);
    const failed = run(event({ type: "failed", message: "boom" }));
    expect(bannerFor(failed)).toMatchObject({ kind: "failed", tone: "danger", detail: "boom" });
});

test("@core a new ready event replaces the old connection's facts", () => {
    const state = run(
        event(READY),
        { type: "sessions", count: 9 },
        event({ ...READY, pid: 43 } as DesktopEvent),
    );
    expect(state.ready?.pid).toBe(43);
    expect(state.sessions).toBeUndefined();
});
