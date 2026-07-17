import { stdin, stdout } from "node:process";

import { loadVeraConfig } from "../../src/config.ts";
import { createInstanceDirectory } from "../../src/instances/directory.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import { runNdjsonBridge } from "./ndjson-bridge.ts";

export async function runNdjsonProcess(): Promise<void> {
    const config = loadVeraConfig();
    const adapter = createConfiguredModelAdapter(config);
    const presence = createInstanceDirectory().register({
        client: "stdio",
        workspacePath: process.cwd(),
    });

    try {
        await runNdjsonBridge(
            stdin,
            stdout,
            adapter,
            config.model,
            config.reasoning_effort,
            { approvalMode: config.approval_mode },
        );
    } finally {
        presence.remove();
    }
}
