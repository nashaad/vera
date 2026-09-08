import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";
import type { ModelOperation } from "../../../src/model/model-operations.ts";

test("live shortlist keeps through the host operation and verification can be left running", async () => {
    const operations: ModelOperation[] = [];
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const available = [{ provider: "openrouter", model: "one/model", label: "One", description: "", levels: [] }];
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-journeys-")), width: 120, height: 36,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies({ pooled: [] }),
            operateModels: async (operation, onResult) => {
                operations.push(operation);
                if (operation.operation === "verify") await gate;
                onResult({ ...operation.models[0]!, status: "passed" });
                return { model: "one/model", provider: "openrouter", availableModels: available,
                    pooled: [{ ...available[0]!, available: true, verified: operation.operation === "verify" }] };
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("manage short");
        await session.waitForVisiblePane("Manage shortlist");
        session.sendKey("Enter");
        await session.waitForVisiblePane("not kept ✗");
        session.sendKey("C-s");
        await session.waitForVisiblePane("✓ One added to shortlist");
        expect(operations[0]?.operation).toBe("keep");
        session.sendKey("C-y");
        await session.waitForVisiblePane("Verifying models");
        session.sendKey("Escape");
        await session.settle();
        expect(session.captureVisiblePane()).not.toContain("Verifying models");
        expect(session.captureVisiblePane()).toContain("Manage shortlist");
        finish();
        await session.settle(50);
        expect(operations.map((operation) => operation.operation)).toEqual(["keep", "verify"]);
        expect(session.captureVisiblePane()).toContain("Manage shortlist");
    } finally { finish(); await session.close(); }
}, 15_000);

test("defaults expose six slots and empty eligibility offers recovery", async () => {
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-defaults-journey-")), width: 120, height: 36,
        dependencies: () => createTuiCatalogRefreshDependencies({ pooled: [] }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("assign model defaults"); await session.waitForVisiblePane("Assign model defaults");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("unset, inherits its intent");
        for (const label of ["snappy", "eco", "extra", "classifier", "compaction", "subagents"]) expect(pane).toContain(label);
        session.sendKey("Enter");
        const assign = await session.waitForVisiblePane("Only shortlisted and verified models are eligible");
        expect(assign).toContain("Verify shortlisted models");
        expect(assign).toContain("Manage shortlist");
    } finally { await session.close(); }
}, 15_000);

test("Home stages empty dials without creating a session, then switching applies the chosen model", async () => {
    const { createHomeClient } = await import("../../../clients/tui/home-client.ts");
    const { createSettingsAnsweringClient } = await import("../../support/settings-answering-client.ts");
    const commands: import("../../../src/engine/protocol.ts").ClientCommand[] = [];
    let created = 0;
    const settings = { provider: "openrouter", model: "one/model", pooled: [],
        availableModels: [{ provider: "openrouter", model: "one/model", label: "One", description: "", levels: [] }] };
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-home-dials-")), width: 120, height: 36,
        dependencies: () => ({
            client: createHomeClient("/work/vera", { readModelSettings: async () => settings }),
            authStorage: { getCredential: () => ({ type: "api_key", key: "fixture" }), setCredential() {}, deleteCredential() {} },
            createSession: async () => {
                created++;
                return createSettingsAnsweringClient({ agentId: "new-model-session", workspace: "/work/vera", model: "one/model", mode: "ask",
                    modelSettings: settings, onCommand: (command) => commands.push(command) });
            },
        }),
    });
    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("dial strip"); await session.waitForVisiblePane("Dial strip");
        session.sendKey("Enter");
        const dials = await session.waitForVisiblePane("EFFORT");
        expect(dials).toContain("readonly");
        session.sendKey("Down"); session.sendKey("Left");
        await session.waitForVisiblePane("‹ readonly ›");
        session.sendKey("Enter"); await session.waitForVisiblePane("V  E  R  A");
        expect(created).toBe(0);
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("dial strip"); await session.waitForVisiblePane("Dial strip");
        session.sendKey("Enter"); await session.waitForVisiblePane("‹ readonly ›");
        session.sendKey("Down"); session.sendKey("Right"); session.sendKey("Right");
        await session.waitForVisiblePane("live: readonly");
        session.sendKey("Enter"); await session.waitForVisiblePane("V  E  R  A");
        expect(created).toBe(0);
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("switch model"); await session.waitForVisiblePane("Switch model");
        session.sendKey("Enter"); await session.waitForVisiblePane("Your shortlist is empty");
        session.sendKey("Tab"); await session.waitForVisiblePane("One");
        session.sendKey("Enter"); await session.waitForVisiblePane("Start a conversation");
        await session.settle();
        expect(created).toBe(1);
        expect(commands.some((command) => command.type === "update_session_model_settings"
            && command.patch.model === "one/model")).toBe(true);
        expect(commands.some((command) => command.type === "update_session_permission_mode" && command.mode === "auto")).toBe(true);
        expect(commands.some((command) => command.type === "pool_add")).toBe(false);
    } finally { await session.close(); }
}, 15_000);


test("Switch model Ctrl+S keeps and unkeeps without switching or verifying", async () => {
    const operations: ModelOperation[] = [];
    const available = [{ provider: "openrouter", model: "one/model", label: "One", description: "", levels: [] }];
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-switch-keep-")), width: 140, height: 40,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies({ pooled: [] }),
            operateModels: async (operation) => {
                operations.push(operation);
                return { model: "one/model", provider: "openrouter", availableModels: available,
                    pooled: operation.operation === "keep" ? [{ ...available[0]!, available: true, verified: false }] : [] };
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("switch model"); await session.waitForVisiblePane("Switch model");
        session.sendKey("Enter"); await session.waitForVisiblePane("Your shortlist is empty");
        session.sendKey("Tab"); await session.waitForVisiblePane("not shortlisted");
        session.sendKey("C-s"); await session.waitForVisiblePane("on your shortlist");
        session.sendKey("C-s"); await session.waitForVisiblePane("not shortlisted");
        expect(operations.map((operation) => operation.operation)).toEqual(["keep", "unkeep"]);
        expect(session.captureVisiblePane()).toContain("Switch model");
    } finally { await session.close(); }
}, 15_000);
