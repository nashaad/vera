import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHomeClient } from "../../../clients/tui/home-client.ts";
import type { TuiDependencies } from "../../../clients/tui/main.ts";
import { HostReplacementBusyError } from "../../../src/host/discovery.ts";
import { HostBuildChangedError } from "../../../src/host/reconnecting-agent-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

function homeDependencies(options: {
    readonly reconnectHome: NonNullable<TuiDependencies["reconnectHome"]>;
    readonly onCreate: () => void;
    readonly onReadSettings: () => void;
    readonly sessionsAvailable?: () => boolean;
}): TuiDependencies {
    return {
        client: createHomeClient("/work/vera", {
            readModelSettings: async () => {
                options.onReadSettings();
                return {
                    model: "refreshed-model",
                    mode: "review",
                } as never;
            },
        }),
        homeHasSessions: options.sessionsAvailable === undefined,
        reconnectHome: options.reconnectHome,
        readHostModelSettings: async () => {
            options.onReadSettings();
            return undefined;
        },
        listAgents: async () => options.sessionsAvailable?.() === true
            ? [{
                id: "prior-session",
                workspace: "/work/vera",
                session_path: "/work/vera/prior-session.jsonl",
                title: "Prior conversation",
                kind: "interactive",
                status: "completed",
                live: false,
            }]
            : [],
        createSession: async () => {
            options.onCreate();
            throw new Error("Home reconnect must not create a session");
        },
        searchSessions: async () => ({
            sessions: [],
            total: 0,
        }) as never,
    };
}

async function chooseReconnect(session: Awaited<ReturnType<typeof startTuiTestSession>>) {
    session.sendKey("C-p");
    await session.waitForVisiblePane("Commands");
    session.sendText("reconnect host");
    await session.waitForVisiblePane("Reconnect host");
    session.sendKey("Enter");
}

test("Home reconnect replaces the host, refreshes Home, and creates no session", async () => {
    const calls: unknown[] = [];
    let creates = 0;
    let settingsReads = 0;
    let reconnects = 0;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-home-reconnect-")),
        dependencies: () => homeDependencies({
            reconnectHome: async (options) => {
                calls.push(options);
                reconnects += 1;
            },
            onCreate: () => { creates += 1; },
            onReadSettings: () => { settingsReads += 1; },
            sessionsAvailable: () => reconnects > 0,
        }),
    });

    try {
        const initial = await session.waitForVisiblePane("V  E  R  A");
        expect(initial).not.toContain("All conversations");
        const settingsBefore = settingsReads;
        await chooseReconnect(session);
        const pane = await session.waitForVisiblePane("All conversations");
        expect(pane).toContain("New conversation");
        expect(calls).toEqual([{ replaceExisting: true, confirmWedge: true }]);
        expect(reconnects).toBe(1);
        expect(settingsReads).toBeGreaterThan(settingsBefore);
        expect(creates).toBe(0);

        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendKey("Escape");
        expect(await session.waitForVisiblePane("V  E  R  A")).toContain("New conversation");
        expect(creates).toBe(0);
    } finally {
        await session.close();
    }
}, 15_000);

test("busy Home reconnect explains the wait, dismisses, and does not retry", async () => {
    let calls = 0;
    let creates = 0;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-home-reconnect-busy-")),
        width: 80,
        height: 24,
        dependencies: () => homeDependencies({
            reconnectHome: async () => {
                calls += 1;
                throw new HostReplacementBusyError();
            },
            onCreate: () => { creates += 1; },
            onReadSettings: () => {},
        }),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        await chooseReconnect(session);
        const dialog = await session.waitForVisiblePane("Could not restart the host:");
        const text = dialog.replace(/\s+/g, " ");
        expect(text).toContain("Could not restart the host: other work is still using it. Choose Reconnect host again once that work finishes.");
        expect(dialog).toContain("Reconnect host");
        expect(dialog).toContain("enter copies all");
        expect(calls).toBe(1);
        session.sendKey("Escape");
        expect(await session.waitForVisiblePane("V  E  R  A")).toContain("New conversation");
        expect(calls).toBe(1);
        await chooseReconnect(session);
        await session.waitForVisiblePane("Could not restart the host:");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (pane) => pane.includes("V  E  R  A") && !pane.includes("Could not restart the host:"),
            "Home after dismissing the dialog with Escape",
        );
        expect(calls).toBe(2);
        expect(creates).toBe(0);
    } finally {
        await session.close();
    }
}, 15_000);

test("Home reconnect relaunches a changed installed build without a session", async () => {
    const requests: unknown[] = [];
    let reconnects = 0;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-home-reconnect-build-")),
        dependencies: () => ({
            ...homeDependencies({
                reconnectHome: async () => { reconnects += 1; },
                onCreate: () => {},
                onReadSettings: () => {},
            }),
            clientBuildId: "old-build",
            installedBuildId: () => "new-build",
            relaunchTui: async (request) => { requests.push(request); },
        }),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        await chooseReconnect(session);
        await session.settle(300);
        expect(requests).toEqual([{}]);
        expect(reconnects).toBe(0);
    } finally {
        await session.close();
    }
}, 15_000);

test("Home reconnect refuses a changed installed build without a launcher", async () => {
    let reconnects = 0;
    let buildChecks = 0;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-home-reconnect-install-refusal-")),
        width: 140,
        dependencies: () => ({
            ...homeDependencies({
                reconnectHome: async () => { reconnects += 1; },
                onCreate: () => {},
                onReadSettings: () => {},
            }),
            clientBuildId: "vera-crow-1",
            installedBuildId: () => "vera-kraken-2",
            refuseOtherHostBuild: async () => { buildChecks += 1; },
        }),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        await chooseReconnect(session);
        const dialog = await session.waitForVisiblePane("Quit and reopen Vera to continue.");
        expect(dialog).toContain("The installed Vera is now build vera-kraken-2");
        expect(buildChecks).toBe(1);
        expect(reconnects).toBe(0);
        session.sendKey("Escape");
        expect(await session.waitForVisiblePane("V  E  R  A")).toContain("New conversation");
    } finally {
        await session.close();
    }
}, 15_000);

test("Home reconnect shows the existing host-build refusal", async () => {
    let reconnects = 0;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-home-reconnect-host-refusal-")),
        width: 140,
        dependencies: () => homeDependencies({
            reconnectHome: async () => {
                reconnects += 1;
                throw new HostBuildChangedError("vera-crow-1", "vera-kraken-2");
            },
            onCreate: () => {},
            onReadSettings: () => {},
        }),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        await chooseReconnect(session);
        const dialog = await session.waitForVisiblePane("Quit and reopen Vera to continue.");
        expect(dialog).toContain("The Vera host is now build vera-kraken-2");
        expect(reconnects).toBe(1);
        session.sendKey("Escape");
        expect(await session.waitForVisiblePane("V  E  R  A")).toContain("New conversation");
    } finally {
        await session.close();
    }
}, 15_000);

test("a Home reconnect error stays in Home and does not create a session", async () => {
    let creates = 0;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-home-reconnect-error-")),
        dependencies: () => homeDependencies({
            reconnectHome: async () => { throw new Error("host unavailable"); },
            onCreate: () => { creates += 1; },
            onReadSettings: () => {},
        }),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        await chooseReconnect(session);
        const dialog = await session.waitForVisiblePane("Could not reconnect: host unavailable");
        expect(dialog).toContain("Reconnect host");
        expect(creates).toBe(0);
        session.sendKey("Escape");
        expect(await session.waitForVisiblePane("V  E  R  A")).toContain("New conversation");
        expect(creates).toBe(0);
    } finally {
        await session.close();
    }
}, 15_000);
