import { stdin, stdout } from "node:process";

import { loadVeraConfig } from "./config.ts";
import { createInstanceDirectory } from "./instances/directory.ts";
import { createConfiguredModelAdapter } from "./providers/configured.ts";
import { runNdjsonBridge } from "./rpc/ndjson.ts";

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
        );
    } finally {
        presence.remove();
    }
}
