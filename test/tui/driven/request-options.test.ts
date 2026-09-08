import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTuiCatalogRefreshDependencies } from
    "../../support/tui-catalog-refresh-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("the model inspector saves and clears request options through the real profile store", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-request-options-"));
    const profile = join(home, ".vera");
    const configPath = join(profile, "config.json");
    mkdirSync(profile, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "one/model",
        approval_mode: "ask",
        model_request_options: {
            "openrouter/other/model": {
                body: { provider: { only: ["other"] } },
            },
        },
    }));
    const session = await startTuiTestSession({
        home,
        width: 90,
        height: 30,
        dependencies: () => createTuiCatalogRefreshDependencies({
            pooled: [{
                provider: "openrouter",
                model: "one/model",
                label: "One",
                available: true,
                verified: false,
                levels: [],
            }],
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("shortlist");
        await session.waitForVisiblePane("Open your library");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Models you keep close");
        session.sendKey("Down");
        await session.settle();
        session.sendKey("Right");
        await session.waitForVisiblePane("⏎ run · ← list");
        session.sendKey("Down");
        session.sendKey("Down");
        session.sendKey("Down");
        session.sendKey("Enter");
        let pane = await session.waitForVisiblePane(
            "default profile · every use of this model",
        );
        expect(pane).toContain("ctrl+s save");
        expect(pane).toContain("\"provider\" selects the");
        expect(pane).toContain("upstream host used by OpenRouter");

        session.sendKey("BSpace");
        session.sendKey("BSpace");
        session.sendText(
            '{"provider":{"only":["z-ai"],"allow_fallbacks":false}}',
        );
        session.sendKey("C-s");
        pane = await session.waitForVisiblePane("configured");
        expect(pane).toContain("Request options");
        expect(readConfig(configPath).model_request_options).toEqual({
            "openrouter/other/model": {
                body: { provider: { only: ["other"] } },
            },
            "openrouter/one/model": {
                body: {
                    provider: {
                        only: ["z-ai"],
                        allow_fallbacks: false,
                    },
                },
            },
        });

        session.sendKey("Enter");
        await session.waitForVisiblePane("default profile · every use of this model");
        session.sendKeyWithModifiers("home", { shift: true });
        session.sendText("{}");
        session.sendKey("C-s");
        await session.waitForVisiblePane("none");
        expect(readConfig(configPath).model_request_options).toEqual({
            "openrouter/other/model": {
                body: { provider: { only: ["other"] } },
            },
        });
    } finally {
        await session.close();
    }
}, 15_000);

function readConfig(path: string): Record<string, any> {
    return JSON.parse(readFileSync(path, "utf8"));
}
