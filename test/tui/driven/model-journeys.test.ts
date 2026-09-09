import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";
import type { ModelOperation } from "../../../src/model/model-operations.ts";

async function showCatalog(session: Awaited<ReturnType<typeof startTuiTestSession>>): Promise<void> {
    session.sendKey("Tab"); session.sendKey("Tab");
    await session.waitForVisiblePane("⏎ choose which models to show");
    session.sendKey("Enter"); await session.waitForVisiblePane("Show models");
    session.sendKey("Down"); session.sendKey("Enter");
    await session.waitForVisiblePane("Models from your connected providers");
    await session.waitForVisiblePane("↑↓ choose · ⏎ switch model");
}


test("live library keeps through the host operation and verification can be left running", async () => {
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
        session.sendText("model lib");
        await session.waitForVisiblePane("Model Library");
        session.sendKey("Enter");
        await session.waitForVisiblePane("not kept ✗");
        expect(session.captureVisiblePane()).toContain("Model Library (0)");
        session.sendKey("C-s");
        await session.waitForVisiblePane("✓ One added to library");
        expect(session.captureVisiblePane()).toContain("Model Library (1)");
        expect(operations[0]?.operation).toBe("keep");
        session.sendKey("C-y");
        await session.waitForVisiblePane("Verifying models");
        session.sendKey("Escape");
        await session.settle();
        expect(session.captureVisiblePane()).not.toContain("Verifying models");
        expect(session.captureVisiblePane()).toContain("Model Library");
        finish();
        await session.settle(50);
        expect(operations.map((operation) => operation.operation)).toEqual(["keep", "verify"]);
        expect(session.captureVisiblePane()).toContain("Model Library");
    } finally { finish(); await session.close(); }
}, 15_000);

test("verification is explicit and all coverage includes only library models", async () => {
    const { createSettingsAnsweringClient } = await import("../../support/settings-answering-client.ts");
    const operations: ModelOperation[] = [];
    const available = ["saved", "catalog-only"].map((model) => ({ provider: "openrouter", model, label: model, levels: [], description: "" }));
    const settings = { provider: "openrouter", model: "saved", availableModels: available,
        pooled: [{ ...available[0]!, available: true, verified: false }] };
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-library-verification-")), width: 130, height: 40,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies(),
            client: createSettingsAnsweringClient({ agentId: "library-verification", workspace: "/work/vera", model: "saved", mode: "ask", modelSettings: settings }),
            operateModels: async (operation, onResult) => {
                operations.push(operation);
                for (const model of operation.models) onResult({ ...model, status: "passed" });
                return settings;
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        await session.settle();
        expect(session.captureVisiblePane()).not.toContain("haven't been verified");
        expect(session.captureVisiblePane()).not.toContain("hasn't been verified");
        expect(session.captureVisiblePane()).not.toContain("Not now");
        expect(operations).toEqual([]);
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("verify library"); await session.waitForVisiblePane("Verify library models");
        session.sendKey("Enter"); await session.waitForVisiblePane("Unverified models in your library");
        session.sendKey("Tab"); await session.waitForVisiblePane("All models in your library");
        session.sendKey("Enter"); await session.waitForVisiblePane("Verification results");
        expect(operations).toHaveLength(1);
        expect(operations[0]?.operation).toBe("verify");
        expect(operations[0]?.models.map(({ provider, model }) => ({ provider, model })))
            .toEqual([{ provider: "openrouter", model: "saved" }]);
        expect(session.captureVisiblePane()).not.toContain("catalog-only");
    } finally { await session.close(); }
}, 15_000);

test("model switching and Model Library have separate slash completion prefixes", async () => {
    const commands: string[] = [];
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-model-slash-")), width: 120, height: 36,
        dependencies: () => createTuiCatalogRefreshDependencies({ pooled: [], onCommand: (command) => commands.push(command.type) }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/mod"); session.sendKey("Tab");
        await session.waitForVisiblePane("│ /model");
        expect(session.captureVisiblePane()).not.toContain("/library-model");
        session.sendKey("Enter"); await session.waitForVisiblePane("Switch model");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere((pane) => !pane.includes("Switch model"), "Switch model to close");
        session.sendText("/lib"); session.sendKey("Tab");
        await session.waitForVisiblePane("│ /library-model");
        session.sendKey("Enter"); await session.waitForVisiblePane("Model Library (0)");
        expect(commands).not.toContain("prompt");
        expect(commands).not.toContain("pool_add");
    } finally { await session.close(); }
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
        const assign = await session.waitForVisiblePane("Only verified models in your library are eligible");
        expect(assign).toContain("Verify library models");
        expect(assign).toContain("Model Library");
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
        session.sendKey("Tab"); session.sendKey("Left");
        await session.waitForVisiblePane("›readonly");
        session.sendKey("Enter"); await session.waitForVisiblePane("V  E  R  A");
        expect(created).toBe(0);
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("dial strip"); await session.waitForVisiblePane("Dial strip");
        session.sendKey("Enter"); await session.waitForVisiblePane("›readonly");
        session.sendKey("Tab"); session.sendKey("Right"); session.sendKey("Right");
        await session.waitForVisiblePane("live: readonly");
        session.sendKey("Enter"); await session.waitForVisiblePane("V  E  R  A");
        expect(created).toBe(0);
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("switch model"); await session.waitForVisiblePane("Switch model");
        session.sendKey("Enter"); await session.waitForVisiblePane("Your library is empty");
        await showCatalog(session); await session.waitForVisiblePane("One");
        session.sendKey("Enter"); await session.waitForVisiblePane("Start a conversation");
        await session.settle();
        expect(created).toBe(1);
        expect(commands.some((command) => command.type === "update_session_model_settings"
            && command.patch.model === "one/model")).toBe(true);
        expect(commands.some((command) => command.type === "update_session_permission_mode" && command.mode === "auto")).toBe(true);
        expect(commands.some((command) => command.type === "pool_add")).toBe(false);
    } finally { await session.close(); }
}, 15_000);


test("Switch model cannot mutate the library through legacy Ctrl+S or Ctrl+Shift+S", async () => {
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
        session.sendKey("Enter"); await session.waitForVisiblePane("Your library is empty");
        await showCatalog(session); await session.waitForVisiblePane("not in your library");
        session.sendKey("C-s"); await session.settle();
        session.sendKey("C-s"); await session.settle();
        expect(session.captureVisiblePane()).toContain("not in your library");
        expect(session.captureVisiblePane()).not.toContain("Model Library");
        expect(session.captureVisiblePane()).not.toContain("tab to switch");
        expect(operations).toEqual([]);
        expect(session.captureVisiblePane()).toContain("Switch model");
    } finally { await session.close(); }
}, 15_000);

test("clicking a cutoff tick reaches the live picker without switching models", async () => {
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-cutoff-mouse-")), width: 130, height: 44,
        dependencies: () => createTuiCatalogRefreshDependencies({ pooled: [] }) });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("switch model"); await session.waitForVisiblePane("Switch model");
        session.sendKey("Enter"); await session.waitForVisiblePane("Your library is empty");
        await showCatalog(session);
        const before = await session.waitForVisiblePane("Models from your connected providers");
        const lines = before.split("\n");
        const tickRow = lines.findIndex((line) => line.includes("1400") && line.includes("1600"));
        await session.sendMouseClick(lines[tickRow]!.indexOf("1600") + 3, tickRow);
        const filtered = await session.waitForVisiblePane("hidden below the cutoff");
        expect(filtered).toContain("Switch model");
        expect(filtered).toContain("No model");
        const filteredLines = filtered.split("\n");
        const nextRow = filteredLines.findIndex((line) => line.includes("1400") && line.includes("1600"));
        expect(nextRow).toBe(tickRow);
        await session.sendMouseClick(filteredLines[nextRow]!.indexOf("any"), nextRow);
        await session.settle();
        expect(session.captureVisiblePane()).not.toContain("hidden below the cutoff");
        expect(session.captureVisiblePane()).toContain("Switch model");
    } finally { await session.close(); }
}, 15_000);

test("Ctrl+K opens the relevant menu and Escape restores the live filtered picker", async () => {
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-model-more-")), width: 130, height: 44,
        dependencies: () => createTuiCatalogRefreshDependencies({ pooled: [] }) });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("switch model"); await session.waitForVisiblePane("Switch model");
        session.sendKey("Enter"); await session.waitForVisiblePane("Your library is empty");
        session.sendKey("C-k"); await session.waitForVisiblePane("Refresh model catalog");
        expect(session.captureVisiblePane()).not.toContain("extra variants");
        session.sendKey("Escape"); await session.waitForVisiblePane("Your library is empty");
        await showCatalog(session);
        session.sendText("open"); await session.settle();
        const before = session.captureVisiblePane();
        expect(before).toContain("Ctrl+K More: variants, refresh");
        session.sendKey("C-k"); await session.waitForVisiblePane("Show extra variants and older models");
        session.sendKey("Escape"); await session.waitForVisiblePane("Switch model");
        await session.settle();
        expect(session.captureVisiblePane()).toBe(before);
        session.sendKey("C-k"); await session.waitForVisiblePane("Show extra variants and older models");
        session.sendKey("Enter"); await session.waitForVisiblePane("Switch model");
        session.sendKey("C-k"); await session.waitForVisiblePane("Hide extra variants and older models");
        session.sendKey("Down"); session.sendKey("Enter");
        const refreshed = await session.waitForVisiblePane("Refreshed 1 catalogs");
        expect(refreshed).toContain("Switch model");
        expect(refreshed).toContain("Two");
    } finally { await session.close(); }
}, 15_000);
