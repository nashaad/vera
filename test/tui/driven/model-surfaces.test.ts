import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";
import type { ModelOperation } from "../../../src/model/model-operations.ts";

test("a favorite keeps through the host operation and verification can be left running", async () => {
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
        session.sendText("favorites");
        await session.waitForVisiblePane("Favorites");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Favorites (0)");
        expect(session.captureVisiblePane()).toContain("· not kept");
        session.sendKey("C-s");
        await session.waitForVisiblePane("✓ One added to favorites");
        await session.waitForVisiblePane("Favorites (1)");
        expect(operations[0]?.operation).toBe("keep");
        session.sendKey("C-y");
        await session.waitForVisiblePane("Verifying models");
        session.sendKey("Escape");
        await session.settle();
        expect(session.captureVisiblePane()).not.toContain("Verifying models");
        expect(session.captureVisiblePane()).toContain("Search models");
        finish();
        await session.settle(50);
        expect(operations.map((operation) => operation.operation)).toEqual(["keep", "verify"]);
        session.sendKey("Escape"); await session.settle();
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("favorites"); await session.waitForVisiblePane("Favorites");
        session.sendKey("Enter"); await session.waitForVisiblePane("Favorites (1)");
    } finally { finish(); await session.close(); }
}, 15_000);

test("the manage menu carries verify all, so no chord is the only way in", async () => {
    const operations: ModelOperation[] = [];
    const available = [{ provider: "openrouter", model: "one/model", label: "One", description: "", levels: [] }];
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-verify-row-")), width: 120, height: 36,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies({
            pooled: [{ ...available[0]!, available: true, verified: false }],
        }),
            operateModels: async (operation, onResult) => {
                operations.push(operation);
                onResult({ ...operation.models[0]!, status: "passed" });
                return { model: "one/model", provider: "openrouter", availableModels: available,
                    pooled: [{ ...available[0]!, available: true, verified: true }] };
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/models");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Browse models");
        session.sendKey("C-k");
        const menu = await session.waitForVisiblePane("Manage models");
        const rows = menu.split("\n").map((line) => line.trim());
        const at = rows.indexOf("Verify favorites");
        expect(at).toBeGreaterThan(0);
        const first = rows.findIndex((line) => line === "Remove from favorites");
        // The card prints a blank line between groups, so count rows, not lines.
        const steps = rows.slice(first, at).filter((line) => line !== "").length;
        for (let step = 0; step < steps; step += 1) session.sendKey("Down");
        await session.settle();
        session.sendKey("Enter");
        const scope = await session.waitForVisiblePane("All favorites");
        expect(scope).toContain("Verify favorites");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Verifying models");
        expect(operations.map((operation) => operation.operation)).toEqual(["verify"]);
    } finally { await session.close(); }
}, 20_000);

test("verification is explicit and all coverage includes only favorites", async () => {
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
        session.sendText("verify favorites"); await session.waitForVisiblePane("Verify favorites");
        session.sendKey("Enter"); await session.waitForVisiblePane("Unverified favorites");
        session.sendKey("Tab"); await session.waitForVisiblePane("All favorites");
        session.sendKey("Enter"); await session.waitForVisiblePane("Verification results");
        expect(operations).toHaveLength(1);
        expect(operations[0]?.operation).toBe("verify");
        expect(operations[0]?.models.map(({ provider, model }) => ({ provider, model })))
            .toEqual([{ provider: "openrouter", model: "saved" }]);
        expect(session.captureVisiblePane()).not.toContain("catalog-only");
    } finally { await session.close(); }
}, 15_000);

test("the switcher has a slash command and favorites is palette only", async () => {
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
        await session.waitForVisiblePane("│ /lib");
        expect(session.captureVisiblePane()).not.toContain("/library-model");
        for (const _ of "/lib") session.sendKey("BSpace");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("favorites");
        await session.waitForVisiblePane("Favorites");
        session.sendKey("Enter"); await session.waitForVisiblePane("Favorites (0)");
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
        const assign = await session.waitForVisiblePane("Assign a model to snappy");
        expect(assign).toContain("Choose any connected model");
        expect(assign).toContain("Not set");
        expect(assign).toContain("manage saved favorites");
    } finally { await session.close(); }
}, 15_000);

test("Home stages access without creating a session, then the switcher applies the model", async () => {
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
        const dials = await session.waitForVisiblePane("› AGENT");
        // The rebuilt HUD carries agent and access only.
        expect(dials).toContain("readonly");
        expect(dials).not.toContain("EFFORT");
        expect(dials).not.toContain("MODEL");
        session.sendKey("Tab"); session.sendKey("Right");
        await session.waitForVisiblePane("live: ask");
        session.sendKey("Enter"); await session.waitForVisiblePane("V  E  R  A");
        expect(created).toBe(0);
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("switch model"); await session.waitForVisiblePane("Switch model");
        session.sendKey("Enter"); await session.waitForVisiblePane("↑↓ move · ⏎ switch");
        session.sendKey("Enter"); await session.waitForVisiblePane("Start a conversation");
        await session.settle();
        expect(created).toBe(1);
        expect(commands.some((command) => command.type === "update_session_model_settings"
            && command.patch.model === "one/model")).toBe(true);
        expect(commands.some((command) => command.type === "update_session_permission_mode" && command.mode === "auto")).toBe(true);
        expect(commands.some((command) => command.type === "pool_add")).toBe(false);
    } finally { await session.close(); }
}, 15_000);

test("the switcher applies a levelled model and clears the remembered effort", async () => {
    const { createSettingsAnsweringClient } = await import("../../support/settings-answering-client.ts");
    const commands: import("../../../src/engine/protocol.ts").ClientCommand[] = [];
    const levels = [{ id: "low" as const, label: "Low effort" }, { id: "high" as const, label: "High effort" }];
    const available = [
        { provider: "openrouter", model: "one/model", label: "One", description: "", levels: [] },
        { provider: "openrouter", model: "two/model", label: "Two", description: "", levels, defaultLevel: "low" as const },
    ];
    const settings = { provider: "openrouter", model: "one/model", availableModels: available, pooled: [] };
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-switch-effort-")), width: 120, height: 48,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies(),
            client: createSettingsAnsweringClient({ agentId: "switch-effort", workspace: "/work/vera", model: "one/model", mode: "ask",
                modelSettings: settings, onCommand: (command) => commands.push(command) }),
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("switch model"); await session.waitForVisiblePane("Switch model");
        session.sendKey("Enter"); await session.waitForVisiblePane("↑↓ move · ⏎ switch");
        session.sendText("two"); await session.waitForVisiblePane("1/1");
        session.sendKey("Enter"); await session.settle();
        // Effort is its own command, so choosing a model never interrupts, and the
        // level the old model carried does not follow the new one.
        expect(session.captureVisiblePane()).not.toContain("High effort");
        const applied = commands.filter((command) => command.type === "update_session_model_settings");
        expect(applied.map((command) => command.type === "update_session_model_settings" && command.patch))
            .toEqual([{ provider: "openrouter", model: "two/model", reasoningEffort: null }]);
        expect(commands.some((command) => command.type === "update_model_settings")).toBe(false);
    } finally { await session.close(); }
}, 15_000);

test("the switcher favorites with Ctrl+F and ignores the legacy Ctrl+S", async () => {
    const operations: ModelOperation[] = [];
    const commands: string[] = [];
    const available = [{ provider: "openrouter", model: "one/model", label: "One", description: "", levels: [] }];
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-switch-keep-")), width: 140, height: 40,
        dependencies: () => ({ ...createTuiCatalogRefreshDependencies({ pooled: [], onCommand: (command) => commands.push(command.type) }),
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
        session.sendKey("Enter"); await session.waitForVisiblePane("^f favorite");
        session.sendKey("C-s"); await session.settle();
        session.sendKey("C-s"); await session.settle();
        expect(operations).toEqual([]);
        expect(commands).not.toContain("pool_add");
        expect(session.captureVisiblePane()).toContain("Switch model");
        // Favoriting from the switcher goes through host admission, not a library write.
        session.sendKey("C-f"); await session.waitForVisiblePane("to favorites");
        expect(commands).toContain("pool_add");
        expect(operations).toEqual([]);
        expect(session.captureVisiblePane()).toContain("Switch model");
    } finally { await session.close(); }
}, 15_000);

test("clicking a cutoff tick filters browse without switching models", async () => {
    const commands: string[] = [];
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-cutoff-mouse-")), width: 130, height: 44,
        dependencies: () => createTuiCatalogRefreshDependencies({ pooled: [], onCommand: (command) => commands.push(command.type) }) });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/models"); session.sendKey("Enter");
        await session.waitForVisiblePane("Browse models");
        session.sendKey("Tab"); session.sendKey("Tab"); session.sendKey("Enter");
        const before = await session.waitForVisiblePane("Intelligence cutoff: any");
        const lines = before.split("\n");
        const tickRow = lines.findIndex((line) => line.includes("1400") && line.includes("1600"));
        await session.sendMouseClick(lines[tickRow]!.indexOf("1600") + 3, tickRow);
        const filtered = await session.waitForVisiblePane("Intelligence cutoff: 1600");
        const filteredLines = filtered.split("\n");
        const nextRow = filteredLines.findIndex((line) => line.includes("1400") && line.includes("1600"));
        expect(nextRow).toBe(tickRow);
        await session.sendMouseClick(filteredLines[nextRow]!.indexOf("any"), nextRow);
        await session.waitForVisiblePane("Intelligence cutoff: any");
        session.sendKey("Escape"); await session.waitForVisiblePane("Browse models");
        expect(commands).not.toContain("update_session_model_settings");
    } finally { await session.close(); }
}, 15_000);

test("Ctrl+K opens the manage menu and Escape restores the browse page untouched", async () => {
    const session = await startTuiTestSession({ home: mkdtempSync(join(tmpdir(), "vera-model-more-")), width: 130, height: 44,
        dependencies: () => createTuiCatalogRefreshDependencies({ pooled: [] }) });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/models"); session.sendKey("Enter");
        await session.waitForVisiblePane("No favorites yet");
        session.sendKey("C-k"); await session.waitForVisiblePane("Refresh model catalog");
        // With no row highlighted the menu offers nothing model specific.
        expect(session.captureVisiblePane()).not.toContain("extra variants");
        session.sendKey("Escape"); await session.waitForVisiblePane("No favorites yet");
        session.sendKey("C-g"); await session.waitForVisiblePane("All connected models");
        session.sendText("open"); await session.settle();
        const before = session.captureVisiblePane();
        expect(before).toContain("Ctrl+K manage highlighted model");
        session.sendKey("C-k"); await session.waitForVisiblePane("Selected: One · openrouter");
        session.sendKey("Escape"); await session.waitForVisiblePane("Browse models");
        await session.settle();
        expect(session.captureVisiblePane()).toBe(before);
        session.sendKey("C-k"); await session.waitForVisiblePane("Show extra variants and older models");
        session.sendKey("Down"); session.sendKey("Enter");
        await session.waitForVisiblePane("Browse models");
        session.sendKey("C-k"); await session.waitForVisiblePane("Hide extra variants and older models");
    } finally { await session.close(); }
}, 15_000);
