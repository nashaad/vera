import { stdin, stdout } from "node:process";

import { createInstanceDirectory } from "./instances/directory.ts";
import { createOpenRouterAdapter } from "./model/openrouter.ts";
import { runNdjsonBridge } from "./rpc/ndjson.ts";

export async function runNdjsonProcess(): Promise<void> {
    // OpenRouter is the only live stage-0 adapter. S1-providers will replace
    // this temporary bootstrap with shared provider and model configuration.
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_MODEL;

    if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY is required");
    }
    if (!model) {
        throw new Error("OPENROUTER_MODEL is required");
    }

    const presence = createInstanceDirectory().register({
        client: "stdio",
        workspacePath: process.cwd(),
    });

    try {
        await runNdjsonBridge(
            stdin,
            stdout,
            createOpenRouterAdapter({ apiKey }),
            model,
        );
    } finally {
        presence.remove();
    }
}
