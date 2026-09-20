import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../src/config.ts";
import { DEFAULT_PROMPT_CONTRIBUTION_ORDER } from "../src/engine/prompt-contributions.ts";
import { configuredTurnPolicy } from "../src/turn-policy.ts";

test("a config with no turn settings names none", () => {
    const path = temporaryConfigPath();
    writeFileSync(
        path,
        JSON.stringify({ schema_version: 1, model: "anthropic/example-model" }),
    );

    expect(configuredTurnPolicy(loadVeraConfig({ path }))).toEqual({});
});

test("every turn setting a config decides reaches one policy", () => {
    const order = [...DEFAULT_PROMPT_CONTRIBUTION_ORDER];
    const path = temporaryConfigPath();
    writeFileSync(
        path,
        JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "anthropic/example-model",
            fallback: { model: "anthropic/other-model", after_failures: 2 },
            permission_modes: {
                cautious: {
                    default: "ask",
                    rules: [{ when: { verb: "read" }, then: "allow" }],
                },
            },
            disabled_prompt_contributions: ["core.narration"],
            prompt_contribution_order: order,
        }),
    );

    expect(configuredTurnPolicy(loadVeraConfig({ path }))).toEqual({
        modelFallback: {
            provider: "openrouter",
            model: "anthropic/other-model",
            afterFailures: 2,
        },
        permissionModes: {
            cautious: {
                name: "cautious",
                defaultOutcome: "ask",
                rules: [{
                    name: "cautious.rules.0",
                    when: { verb: "read" },
                    then: "allow",
                }],
            },
        },
        disabledPromptContributions: ["core.narration"],
        promptContributionOrder: order,
    });
});

function temporaryConfigPath(): string {
    return join(mkdtempSync(join(tmpdir(), "vera-turn-policy-")), "config.json");
}
