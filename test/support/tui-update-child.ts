import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTui } from "../../clients/tui/main.ts";
import { createTuiUpdates } from "../../clients/tui/update-dependencies.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

installTestProcessGuard();

const home = process.env.VERA_HOME!;
const veraCommand = process.env.UPDATE_TEST_COMMAND!;

await startTui({
    client: createSettingsAnsweringClient({
        agentId: "update-tmux",
        model: "fixture",
        mode: "auto",
        initialUpdates: [{
            type: "history",
            entries: [{ kind: "assistant", text: "The crow is ready to sail." }],
            seq: 0,
        }],
    }),
    listAgents: async () => [],
    updates: createTuiUpdates({ veraCommand, home, tickMs: 200 }),
    // Holds the screen long enough for the test to read the notice, then exits like the launcher relaunch.
    relaunchTui: async (request) => {
        writeFileSync(join(home, "relaunch.json"), JSON.stringify(request));
        await Bun.sleep(1_500);
        process.exit(85);
    },
});
