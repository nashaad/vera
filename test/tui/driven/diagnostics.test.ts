import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
        await session.waitForVisiblePane("test · high");
        session.sendText("/diagnostics");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("This conversation");
        expect(pane).toContain("The host");
        expect(pane).not.toContain("SESSION USAGE");
        session.sendKey("Tab");
        session.sendKey("Right");
        await session.settle(100);
        expect(session.captureVisiblePane()).toContain("This conversation");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("SESSION USAGE");
        expect(pane).toContain("Diagnostics › Session");
        expect(pane).not.toContain("This conversation");
        expect(pane).toContain("SESSION USAGE");
        expect(pane).toContain("RUNTIME");
        expect(pane).toContain("enter copies all");
        expect(pane).not.toContain("## Session");
        expect(pane).not.toContain("EXTENSIONS");
        expect(pane).not.toContain("PRE-IMAGE STASH");
        expect(pane).toContain("PROVIDER HEALTH");
        expect(pane).toContain("not checked");
        expect(pane).toContain("press v");
        // The composer stays behind the overlay, and its frame carries the
        // row that says what the session is answering as.
        expect(pane).toContain("test · high");

        session.sendKey("C-p");
        await session.settle(100);
        pane = session.captureVisiblePane();
        expect(pane).toContain("SESSION USAGE");
        expect(pane).not.toContain("Commands");

        session.sendKey("Enter");
        await session.waitForVisiblePane("✓ copied");
        session.sendKey("Tab");
        await session.settle(100);
        expect(session.captureVisiblePane()).toContain("SESSION USAGE");
        session.sendKey("Escape");
        await session.waitForVisiblePane("This conversation");
        session.sendKey("Down");
        session.sendKey("Enter");
        pane = await session.waitForVisiblePane("BUILD");
        expect(pane).toContain("Diagnostics › Vera");
        expect(pane).toContain("BUILD");
        expect(pane).not.toContain("SESSION USAGE");
        session.sendKey("Enter");
        await session.waitForVisiblePane("✓ copied");
        session.sendKey("Escape");
        await session.waitForVisiblePane("This conversation");
        session.sendKey("Escape");
        pane = await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("Message Vera")
                && !visible.includes("Diagnostics"),
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
        await session.waitForVisiblePane("This conversation");
        session.sendKey("Enter");
        await session.waitForVisiblePane("finding session path…");
        session.sendKey("Escape");
        await session.waitForVisiblePane("This conversation");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (visible) => visible.includes("Message Vera")
                && !visible.includes("This conversation"),
            "diagnostics to close",
        );

        session.sendText("/diagnostics");
        session.sendKey("Enter");
        await session.waitForVisiblePane("This conversation");
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
        await session.waitForVisiblePane("This conversation");
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
        expect(pane).toContain("Resident host: not running");
        expect(pane).toContain("unrecognized host");
        expect(pane).toContain("PID 4242");
        expect(pane).toContain("1 stray process can be stopped safely.");
        expect(pane).toContain("Run vera doctor in a terminal to stop it.");
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
            "Extensions reloaded in the TUI with failures: some",
        );

        session.sendText("/diagnostics");
        session.sendKey("Enter");
        await session.waitForVisiblePane("This conversation");
        session.sendKey("Down");
        session.sendKey("Enter");
        await session.waitForVisiblePane("BUILD");
        session.sendKey("NPage");
        pane = await session.waitForVisiblePane("Status  partial");
        expect(pane).toContain("missing-client-extension");
        expect(pane).toContain("Error");
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
            "Extensions reloaded in the TUI with failures: some",
        );

        session.sendText("/diagnostics");
        session.sendKey("Enter");
        await session.waitForVisiblePane("This conversation");
        session.sendKey("Down");
        session.sendKey("Enter");
        await session.waitForVisiblePane("BUILD");
        session.sendKey("NPage");
        pane = await session.waitForVisiblePane("Status  partial");
        expect(pane).toContain("test.sidebar");
        expect(pane).toContain("Error");
    } finally {
        await session.close();
    }
}, 15_000);

test("inspect health stays idle until v and reports red with no selected model", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-health-idle-"));
    let probed = 0;
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 52,
        dependencies: () => ({
            ...createTuiChildDependencies(),
            healthEnv: {},
            probeHealthRung: async () => {
                probed += 1;
                return true;
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        await session.waitForVisiblePane("test · high");
        session.sendText("/diagnostics");
        session.sendKey("Enter");
        await session.waitForVisiblePane("This conversation");
        session.sendKey("Enter");
        let pane = await session.waitForVisiblePane("not checked");
        expect(pane).toContain("press v");
        expect(probed).toBe(0);
        session.sendKey("v");
        pane = await session.waitForVisiblePane("no model in your favorites");
        expect(pane).toContain("red");
        expect(pane).toContain("/model");
        expect(probed).toBe(0);
    } finally {
        await session.close();
    }
}, 15_000);

test("inspect health is green when a library rung answers", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-health-green-"));
    mkdirSync(join(home, ".vera"), { recursive: true });
    writeFileSync(
        join(home, ".vera/config.json"),
        JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "glm-flash",
        }),
    );
    let probed = 0;
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 52,
        dependencies: () => ({
            ...createTuiChildDependencies({
                modelSettings: {
                    model: "glm-flash",
                    provider: "openrouter",
                    reasoningEffort: "high",
                    pooled: [
                        pooledRung("openrouter", "glm-flash"),
                        pooledRung("ollama", "qwen3:1.7b"),
                    ],
                },
            }),
            probeHealthRung: async (rung) => {
                probed += 1;
                return rung.model === "glm-flash";
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        await session.waitForVisiblePane("glm-flash");
        session.sendText("/diagnostics");
        session.sendKey("Enter");
        await session.waitForVisiblePane("This conversation");
        session.sendKey("Enter");
        await session.waitForVisiblePane("not checked");
        expect(probed).toBe(0);
        session.sendKey("v");
        const pane = await session.waitForVisiblePane(
            "openrouter/glm-flash answered",
        );
        expect(pane).toContain("green");
        expect(pane).toContain("qwen3:1.7b failed");
        expect(probed).toBe(2);
    } finally {
        await session.close();
    }
}, 15_000);

test("inspect health is green when a local ollama rung answers", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-health-ollama-"));
    mkdirSync(join(home, ".vera"), { recursive: true });
    writeFileSync(
        join(home, ".vera/config.json"),
        JSON.stringify({
            schema_version: 1,
            provider: "ollama",
            model: "qwen3:1.7b",
        }),
    );
    let probed = 0;
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 52,
        dependencies: () => ({
            ...createTuiChildDependencies({
                modelSettings: {
                    model: "qwen3:1.7b",
                    provider: "ollama",
                    reasoningEffort: "high",
                    pooled: [
                        pooledRung("ollama", "qwen3:1.7b"),
                        pooledRung("openrouter", "glm-flash"),
                    ],
                },
            }),
            healthEnv: {},
            probeHealthRung: async () => {
                probed += 1;
                return true;
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        await session.waitForVisiblePane("qwen3:1.7b");
        session.sendText("/diagnostics");
        session.sendKey("Enter");
        await session.waitForVisiblePane("This conversation");
        session.sendKey("Enter");
        await session.waitForVisiblePane("not checked");
        expect(probed).toBe(0);
        session.sendKey("v");
        const pane = await session.waitForVisiblePane(
            "ollama/qwen3:1.7b answered",
        );
        expect(pane).toContain("green");
        expect(probed).toBe(2);
    } finally {
        await session.close();
    }
}, 15_000);

function pooledRung(provider: string, model: string) {
    return {
        provider,
        model,
        label: model,
        available: true,
        verified: true,
        levels: [],
    };
}
