import { stdin, stdout } from "node:process";

import {
    configuredModelFallback,
    configuredReviewer,
    loadVeraConfig,
    VeraConfigError,
    type VeraConfig,
} from "../../src/config.ts";
import { renderCliFailure } from "../cli/main.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import { ProviderRoutingAdapter } from "../../src/providers/routing.ts";
import { runNdjsonBridge } from "./ndjson-bridge.ts";

export async function runNdjsonProcess(): Promise<void> {
    let config: VeraConfig;
    try {
        config = loadVeraConfig();
    } catch (error) {
        if (error instanceof VeraConfigError) {
            process.stderr.write(`${renderCliFailure(error)}\n`);
            process.exit(1);
        }
        throw error;
    }
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
