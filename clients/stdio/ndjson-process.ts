import { stdin, stdout } from "node:process";

import {
    configuredModelFallback,
    loadVeraConfig,
} from "../../src/config.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import { runNdjsonBridge } from "./ndjson-bridge.ts";

export async function runNdjsonProcess(): Promise<void> {
    const config = loadVeraConfig();
    const adapter = createConfiguredModelAdapter(config);
    await runNdjsonBridge(
        stdin,
        stdout,
        adapter,
        config.model,
        config.reasoning_effort,
        {
            approvalMode: config.approval_mode,
            modelFallback: configuredModelFallback(config),
        },
    );
}
