import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import { wizardAdopts } from "../../clients/tui/main/onboarding-wizard-ops.ts";
import { startingVeraConfig } from "../../src/config.ts";
import { VERA_HOME_ENV } from "../../src/profile-paths.ts";

test("@core onboarding adopts a configured provider from its focused unused starter session", () => {
    const previousHome = process.env[VERA_HOME_ENV];
    const home = mkdtempSync(join(tmpdir(), "vera-onboarding-adoption-"));
    const config = startingVeraConfig();
    const activeState = {
        entries: [],
        modelSettings: {
            provider: config.provider,
            model: config.model,
        },
        modelSettingsOrigin: "agent-default",
    };
    const rt = {
        sidebar: { isFocused: () => true },
        hostedSidebar: {
            pane: { state: { state: activeState } },
        },
        state: {
            entries: [{ kind: "assistant", text: "A previous answer" }],
        },
    } as unknown as TuiRuntime;

    try {
        process.env[VERA_HOME_ENV] = home;
        writeFileSync(join(home, "config.json"), JSON.stringify(config));

        expect(wizardAdopts(rt, "deepseek")).toBe(true);
    } finally {
        if (previousHome === undefined) delete process.env[VERA_HOME_ENV];
        else process.env[VERA_HOME_ENV] = previousHome;
        rmSync(home, { recursive: true, force: true });
    }
});
