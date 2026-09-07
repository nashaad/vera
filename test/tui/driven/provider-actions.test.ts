import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiCatalogRefreshDependencies } from "../../support/tui-catalog-refresh-child.ts";
import type { ClientCommand } from "../../../src/engine/protocol.ts";

test("provider actions edit the selected connection or refresh its catalog", async () => {
    const commands: ClientCommand[] = [];
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-provider-actions-")),
        width: 120, height: 36,
        dependencies: () => ({
            ...createTuiCatalogRefreshDependencies({ onCommand: (command) => commands.push(command) }),
            authStorage: {
                getCredential: (id: string) => id === "openrouter" ? { type: "api_key" as const, key: "fixture" } : undefined,
                setCredential() {}, deleteCredential() {},
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p"); await session.waitForVisiblePane("Commands");
        session.sendText("configure providers"); await session.waitForVisiblePane("Configure providers");
        session.sendKey("Enter"); await session.waitForVisiblePane("API keys");
        session.sendText("openrouter"); await session.settle();
        session.sendKey("Enter"); await session.waitForVisiblePane("Read this provider's model catalog");
        expect(commands.filter((command) => command.type === "catalog_refresh")).toHaveLength(0);
        session.sendKey("Enter");
        const form = await session.waitForVisiblePane("https://openrouter.ai/api/v1");
        expect(form).toContain("Edit openrouter");
        session.sendKey("Escape");
        const parent = await session.waitForVisiblePane("Configure providers");
        expect(parent).toContain("openrouter");
        session.sendKey("Enter"); await session.waitForVisiblePane("Read this provider's model catalog");
        session.sendKey("Down"); session.sendKey("Enter");
        await session.waitForVisiblePane("Configure providers");
        await session.settle();
        expect(commands.filter((command) => command.type === "catalog_refresh")).toMatchObject([
            { type: "catalog_refresh", provider: "openrouter" },
        ]);
        expect(commands.some((command) => command.type === "pool_add" || command.type === "prompt")).toBe(false);
    } finally { await session.close(); }
}, 15_000);
