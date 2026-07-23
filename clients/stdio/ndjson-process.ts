import { stdin, stdout } from "node:process";

import {
    configuredModelFallback,
    configuredReviewer,
    loadVeraConfig,
    type VeraConfig,
} from "../../src/config.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import { ProviderRoutingAdapter } from "../../src/providers/routing.ts";
import { runNdjsonBridge } from "./ndjson-bridge.ts";

export async function runNdjsonProcess(): Promise<void> {
    const config = loadVeraConfig();
    // Routed, matching the resident host and the interactive stdio client. The
    // reviewer can be configured on a different provider than the agent, and a
    // fixed adapter would silently send those reviews to the agent's backend
    // under the reviewer's model name.
    const adapter = new ProviderRoutingAdapter(
        (provider) => createConfiguredModelAdapter({
            ...config,
            provider: provider as VeraConfig["provider"],
        }),
        config.provider ?? "openrouter",
        createConfiguredModelAdapter(config),
    );
    await runNdjsonBridge(
        stdin,
        stdout,
        adapter,
        config.model,
        config.reasoning_effort,
        {
            approvalMode: config.approval_mode,
            modelFallback: configuredModelFallback(config),
            reviewer: configuredReviewer(config),
        },
    );
}
