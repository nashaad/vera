import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { createLockedJourney } from "./support/locked-journey.ts";
import type { TuiTestSession } from "../support/tui-harness.ts";

const FIRST = "vera-journey/first";
const SWITCHED = "vera-journey/switched";

// OpenRouter counts as connected because it is the configured provider. With a
// test adapter the host lists config `models`; the cached catalog supplies the levels.
const home = {
    config: {
        schema_version: 1,
        provider: "openrouter",
        model: FIRST,
        approval_mode: "auto",
        curated_models_url: "",
        models: [
            { name: "journey-first", provider: "openrouter", model: FIRST },
            { name: "journey-switched", provider: "openrouter", model: SWITCHED },
        ],
        model_routes: {},
        reviewer_profiles: {},
    },
    extraFiles: {
        "runtime/cache/openrouter.json": {
            schema_version: 2,
            provider: "openrouter",
            fetched_at: new Date().toISOString(),
            models: [
                { id: FIRST, label: "Journey First", tool_support: true },
                {
                    id: SWITCHED,
                    label: "Journey Switched",
                    tool_support: true,
                    thinking_support: true,
                    levels: [
                        { id: "low", label: "Low" },
                        { id: "high", label: "High" },
                    ],
                    default_level: "high",
                },
            ],
        },
    },
};

function footerLine(pane: string): string | undefined {
    return pane.split("\n").find((row) => row.includes("default · auto"));
}

// The footer reads "loading", then the session's starting model, before a switch lands.
async function footerShowing(session: TuiTestSession, expected: string): Promise<string> {
    const pane = await session.waitForVisiblePaneWhere(
        (text) => footerLine(text)?.includes(expected) === true,
        `the composer footer showing ${expected}`,
    );
    return footerLine(pane) ?? "";
}

async function openSwitchModel(session: TuiTestSession): Promise<void> {
    session.sendKey("C-x");
    session.sendText("m");
    // Until Home has the host's settings the list reads "No models", and a row
    // that arrives mid-search can leave Enter on Browse models.
    await session.waitForVisiblePane("Your favorite models land here.");
}

test("a model switch is what a new conversation starts on after Vera restarts", async () => {
    const journey = createLockedJourney({ home });
    try {
        const first = await journey.launch();
        await first.waitForVisiblePane("V  E  R  A");
        await openSwitchModel(first);
        first.sendText("switched");
        await first.waitForVisiblePane("journey-switched");
        first.sendKey("Enter");
        await first.waitForVisiblePane("Reasoning");
        first.sendText("high");
        await first.waitForVisiblePaneWhere(
            (pane) => pane.includes("High") && !pane.includes("Low"),
            "the High level alone",
        );
        first.sendKey("Enter");
        await first.waitForVisiblePane("Applies to the next request.");
        await footerShowing(first, `openrouter/${SWITCHED} · high`);
        await journey.quit();

        expect(JSON.parse(readFileSync(journey.configPath, "utf8"))).toMatchObject({
            provider: "openrouter",
            model: SWITCHED,
            reasoning_effort: "high",
        });

        const second = await journey.launch();
        await second.waitForVisiblePane("V  E  R  A");
        second.sendKey("C-n");
        await second.waitForVisiblePane("Message Vera");
        const footer = await footerShowing(second, `openrouter/${SWITCHED} · high`);
        expect(footer).not.toContain(FIRST);
        await journey.quit();
    } finally {
        await journey.dispose();
    }
}, 60_000);
