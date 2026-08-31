import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiChildDependencies } from "../../support/tui-child.ts";
import {
    createTuiReloadFailureDependencies,
} from "../../support/tui-reload-failure-child.ts";
import {
    createTuiPartialReloadDependencies,
} from "../../support/tui-partial-reload-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import type { RegisteredAgentSummary } from "../../../src/host/agent-registry.ts";

test("diagnostics opens as a large copyable overlay instead of transcript text", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-diagnostics-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 52,
        dependencies: () => createTuiChildDependencies(),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        // In-process input is faster than tmux keystrokes were, so give the
        // settings row the beat it needs before the overlay covers it.
        await session.waitForVisiblePane("test · HIGH");
        session.sendText("/diagnostics");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("enter copies all");
        expect(pane).toContain("› Session");
        expect(pane).toContain("Session usage");
        expect(pane).toContain("Runtime");
        expect(pane).toContain("enter copies all");
        expect(pane).toContain("## Session");
        expect(pane).not.toContain("Extensions");
        expect(pane).not.toContain("Pre-image stash");
        // The composer stays behind the overlay, and its frame carries the
        // row that says what the session is answering as.
        expect(pane).toContain("test · HIGH");

        session.sendKey("C-p");
        await session.settle(100);
        pane = session.captureVisiblePane();
        expect(pane).toContain("Session usage");
        expect(pane).not.toContain("Commands");

        session.sendKey("Enter");
        await session.waitForVisiblePane("✓ copied");
        session.sendKey("Tab");
        pane = await session.waitForVisiblePane("› Vera");
        expect(pane).toContain("Build");
        expect(pane).toContain("Extensions");
        expect(pane).toContain("Model failures");
        expect(pane).toContain("Pre-image stash");
        expect(pane).not.toContain("Session usage");
        session.sendKey("Enter");
        await session.waitForVisiblePane("✓ copied");
        session.sendKey("Escape");
        pane = await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("Message Vera")
                && !visible.includes("Pre-image stash"),
            "diagnostics overlay to close without transcript output",
        );
        expect(pane).not.toContain("Diagnostics");
    } finally {
        await session.close();
    }
}, 15_000);

test("a stale session-path lookup cannot update a reopened dialog", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-diagnostics-race-"));
    const firstLookup = deferred<readonly RegisteredAgentSummary[]>();
    const secondLookup = deferred<readonly RegisteredAgentSummary[]>();
    const agent: RegisteredAgentSummary = {
        id: "current-session",
        workspace: "/workspace",
        session_path: "/sessions/current.jsonl",
        kind: "interactive",
        status: "idle",
        live: true,
    };
    let listCalls = 0;
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 52,
        dependencies: () => {
            const base = createTuiChildDependencies();
            return {
                ...base,
                client: {
                    ...base.client,
                    agentId: agent.id,
                    workspace: agent.workspace,
                },
                listAgents: () => {
                    listCalls += 1;
                    if (listCalls === 1) return Promise.resolve([agent]);
                    if (listCalls === 2) return firstLookup.promise;
                    return secondLookup.promise;
                },
            };
        },
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/diagnostics");
        session.sendKey("Enter");
        await session.waitForVisiblePane("finding session path…");
        session.sendKey("Escape");
        await session.waitForVisiblePane("Message Vera");

        session.sendText("/diagnostics");
        session.sendKey("Enter");
        await session.waitForVisiblePane("finding session path…");
        firstLookup.resolve([{
            ...agent,
            session_path: "/sessions/stale.jsonl",
        }]);
        await session.settle(100);
        let pane = session.captureVisiblePane();
        expect(pane).toContain("finding session path…");
        expect(pane).not.toContain("/sessions/stale.jsonl");

        secondLookup.resolve([agent]);
        pane = await session.waitForVisiblePane("/sessions/current.jsonl");
        expect(pane).not.toContain("/sessions/stale.jsonl");
    } finally {
        await session.close();
    }
}, 15_000);

test("diagnostics shows the host-minted session identity", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-diagnostics-identity-"));
    const agent: RegisteredAgentSummary = {
        id: "identity-session",
        name: "calm-wren:0001",
        workspace: "/workspace",
        session_path: "/sessions/identity-session.jsonl",
        kind: "interactive",
        status: "idle",
        live: true,
    };
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 52,
        dependencies: () => {
            const base = createTuiChildDependencies();
            return {
                ...base,
                client: {
                    ...base.client,
                    agentId: agent.id,
                    workspace: agent.workspace,
                },
                listAgents: () => Promise.resolve([agent]),
            };
        },
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/diagnostics");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("calm-wren:0001");
        expect(pane).toContain("/sessions/identity-session.jsonl");
    } finally {
        await session.close();
    }
}, 15_000);

test("doctor opens the read-only process report inside the TUI", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-doctor-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 52,
        dependencies: () => createTuiChildDependencies({ staleDoctor: true }),
    });
    let pane = "";

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/doctor");
        session.sendKey("Enter");
        await session.waitForVisiblePane("checking process health…");
        session.sendKey("Escape");
        await session.waitForVisiblePane("Message Vera");
        session.sendText("/doctor");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("Result: issues found");
        expect(pane).toContain("Doctor");
        expect(pane).toContain("Process summary");
        expect(pane).toContain("Resident hosts: 1 (1 unrecognized");
        expect(pane).toContain("PID 4242");
        expect(pane).toContain("1 stray process can be stopped safely.");
        expect(pane).toContain("Run `vera doctor` in a terminal to stop it.");
        await session.settle(400);
        pane = session.captureVisiblePane();
        expect(pane).toContain("PID 4242");
        expect(pane).not.toContain("PID 1111");

        session.sendKey("Enter");
        await session.waitForVisiblePane("✓ copied");
        session.sendKey("Escape");
        pane = await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("Message Vera")
                && !visible.includes("Result: issues found"),
            "doctor overlay to close without transcript output",
        );
        expect(pane).not.toContain("Process summary");
    } finally {
        await session.close();
    }
}, 15_000);

function deferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
} {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

test("reload failure reaches the TUI diagnostics overlay", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-reload-failure-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 52,
        dependencies: () => createTuiReloadFailureDependencies(home),
    });
    let pane = "";

    try {
        // An extension that fails to load reports into the transcript, so
        // the empty-state line is already gone by the time the TUI is up.
        await session.waitForVisiblePane("Message Vera");

        session.sendText("/reload-extensions");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane(
            "Client extensions reloaded with failures: none",
        );

        session.sendText("/diagnostics");
        session.sendKey("Enter");
        await session.waitForVisiblePane("› Session");
        session.sendKey("Tab");
        pane = await session.waitForVisiblePane("reload       failed");
        expect(pane).toContain("reload error");
        expect(pane).not.toContain("reload       partial");
    } finally {
        await session.close();
    }
}, 15_000);

test("partial reload names the extensions that stayed active", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-partial-reload-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 52,
        dependencies: () => createTuiPartialReloadDependencies(home),
    });
    let pane = "";

    try {
        // An extension that fails to load reports into the transcript, so
        // the empty-state line is already gone by the time the TUI is up.
        await session.waitForVisiblePane("Message Vera");

        session.sendText("/reload-extensions");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane(
            "Client extensions reloaded with failures: some",
        );

        session.sendText("/diagnostics");
        session.sendKey("Enter");
        await session.waitForVisiblePane("› Session");
        session.sendKey("Tab");
        pane = await session.waitForVisiblePane("reload       partial (1 loaded)");
        expect(pane).toContain("active       test.sidebar");
        expect(pane).toContain("reload error");
    } finally {
        await session.close();
    }
}, 15_000);
