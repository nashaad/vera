import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultVeraConfigPath, loadVeraConfig } from "../../../src/config.ts";
import { recordModelVerification } from "../../../src/model/pool-file-store.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";

for (const outcome of ["passed", "failed", "canceled"] as const) {
    test(`default verification ${outcome} preserves assignment boundaries`, async () => {
        let configPath = "";
        let calls = 0;
        const previousPool = process.env.VERA_POOL_FILE;
        const gate = Promise.withResolvers<void>();
        const session = await startTuiTestSession({
            home: mkdtempSync(join(tmpdir(), "vera-default-check-")), width: 120, height: 40,
            dependencies: () => {
                configPath = defaultVeraConfigPath();
                process.env.VERA_POOL_FILE = join(configPath, "..", "pool.json");
                writeFileSync(configPath, JSON.stringify({ schema_version: 1, provider: "openrouter", model: "one/model", approval_mode: "ask", verify_model_assignments: true,
                    model_assignments: { eco: { models: [{ name: "prior", provider: "openrouter", model: "prior" }] } },
                }));
                return { ...createTuiCatalogRefreshDependencies({ pooled: [] }),
                    operateModels: async (operation, onResult) => {
                        calls++;
                        await gate.promise;
                        const target = operation.models[0]!;
                        if (outcome !== "failed") recordModelVerification(`${target.provider}/${target.model}`, { probe: { ok: true, seen: "2026-09-16" } });
                        onResult({ ...target, status: outcome === "failed" ? "failed" : "passed", ...(outcome === "failed" ? { reason: "Test verification refused" } : {}) });
                        return undefined;
                    },
                };
            },
        });
        try {
            await session.waitForVisiblePane("Start a conversation");
            session.sendKey("C-p");
            await session.waitForVisiblePane("Commands");
            session.sendText("assign model");
            await session.waitForVisiblePane("Assign model defaults");
            session.sendKey("Enter");
            await session.waitForVisiblePane("eco");
            session.sendKey("Down"); session.sendKey("Enter");
            await session.waitForVisiblePane("Assign a model to eco");
            session.sendText("One"); session.sendKey("Enter");
            await session.waitForVisiblePane("Verifying model before assignment");
            expect(calls).toBe(1);
            expect(loadVeraConfig({ path: configPath }).model_assignments?.eco?.models?.[0]?.model).toBe("prior");
            if (outcome === "canceled") {
                session.sendKey("Escape");
                await session.waitForVisiblePaneWhere((pane) => !pane.includes("Verifying model before assignment"), "verification assignment canceled");
            }
            gate.resolve();
            if (outcome === "failed") await session.waitForVisiblePane("Test verification refused");
            else await session.settle(150);
            expect(loadVeraConfig({ path: configPath }).model_assignments?.eco?.models?.[0]?.model).toBe(outcome === "passed" ? "one/model" : "prior");
        } finally {
            gate.resolve(); await session.close();
            if (previousPool === undefined) delete process.env.VERA_POOL_FILE;
            else process.env.VERA_POOL_FILE = previousPool;
        }
    }, 15_000);
}

test("default verification finishes when model settings arrive while it runs", async () => {
    let configPath = "";
    const previousPool = process.env.VERA_POOL_FILE;
    const gate = Promise.withResolvers<void>();
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-default-check-")), width: 120, height: 40,
        dependencies: () => {
            configPath = defaultVeraConfigPath();
            process.env.VERA_POOL_FILE = join(configPath, "..", "pool.json");
            writeFileSync(configPath, JSON.stringify({ schema_version: 1, provider: "openrouter", model: "one/model", approval_mode: "ask", verify_model_assignments: true,
                model_assignments: { eco: { models: [{ name: "prior", provider: "openrouter", model: "prior" }] } },
            }));
            const dependencies = createTuiCatalogRefreshDependencies({ pooled: [] });
            return { ...dependencies,
                operateModels: async (operation, onResult) => {
                    await dependencies.client.send({ type: "get_model_settings", requestId: "mid-verification" });
                    await gate.promise;
                    const target = operation.models[0]!;
                    recordModelVerification(`${target.provider}/${target.model}`, { probe: { ok: true, seen: "2026-09-16" } });
                    onResult({ ...target, status: "passed" });
                    return undefined;
                },
            };
        },
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        // Opened from /models, so a settings snapshot rebuilds the picker underneath.
        session.sendText("/models"); session.sendKey("Enter");
        await session.waitForVisiblePane("Compare models");
        session.sendKey("C-k");
        await session.waitForVisiblePane("Manage models");
        session.sendKey("Down"); session.sendKey("Down"); session.sendKey("Enter");
        await session.waitForVisiblePane("Assign model defaults");
        await session.waitForVisiblePane("eco");
        session.sendKey("Down"); session.sendKey("Enter");
        await session.waitForVisiblePane("Assign a model to eco");
        session.sendText("One"); session.sendKey("Enter");
        await session.waitForVisiblePane("Verifying model before assignment");
        await session.settle(200);
        gate.resolve();
        await session.waitForVisiblePaneWhere((pane) => !pane.includes("Verifying model before assignment"), "verification finished");
        await session.settle(150);
        expect(loadVeraConfig({ path: configPath }).model_assignments?.eco?.models?.[0]?.model).toBe("one/model");
    } finally {
        gate.resolve(); await session.close();
        if (previousPool === undefined) delete process.env.VERA_POOL_FILE;
        else process.env.VERA_POOL_FILE = previousPool;
    }
}, 15_000);

test("assigning a default runs no verification unless the setting asks for it", async () => {
    let configPath = "";
    let calls = 0;
    const previousPool = process.env.VERA_POOL_FILE;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-default-nocheck-")), width: 120, height: 40,
        dependencies: () => {
            configPath = defaultVeraConfigPath();
            process.env.VERA_POOL_FILE = join(configPath, "..", "pool.json");
            writeFileSync(configPath, JSON.stringify({ schema_version: 1, provider: "openrouter", model: "one/model", approval_mode: "ask",
                model_assignments: { eco: { models: [{ name: "prior", provider: "openrouter", model: "prior" }] } },
            }));
            return { ...createTuiCatalogRefreshDependencies({ pooled: [] }),
                operateModels: async () => { calls++; return undefined; },
            };
        },
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("assign model");
        await session.waitForVisiblePane("Assign model defaults");
        session.sendKey("Enter");
        await session.waitForVisiblePane("eco");
        session.sendKey("Down"); session.sendKey("Enter");
        await session.waitForVisiblePane("Assign a model to eco");
        session.sendText("One"); session.sendKey("Enter");
        await session.waitForVisiblePaneWhere(() => loadVeraConfig({ path: configPath }).model_assignments?.eco?.models?.[0]?.model === "one/model", "assignment saved");
        expect(session.captureVisiblePane()).not.toContain("Verifying model before assignment");
        expect(calls).toBe(0);
    } finally {
        await session.close();
        if (previousPool === undefined) delete process.env.VERA_POOL_FILE;
        else process.env.VERA_POOL_FILE = previousPool;
    }
}, 15_000);
