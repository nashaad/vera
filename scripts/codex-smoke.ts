import { loadVeraConfig } from "../src/config.ts";
import { createOpenAICodexAdapter } from "../src/model/openai-codex.ts";

const config = loadVeraConfig();
const model = process.env.OPENAI_CODEX_MODEL
    ?? (config.provider === "openai-codex" ? config.model : undefined);
if (model === undefined) {
    throw new Error(
        "Set provider to openai-codex or provide OPENAI_CODEX_MODEL",
    );
}

const stream = createOpenAICodexAdapter().stream({
    model,
    ...(config.provider !== "openai-codex"
        || config.reasoning_effort === undefined
        ? {}
        : { reasoningEffort: config.reasoning_effort }),
    messages: [
        {
            role: "user",
            content: [{
                type: "text",
                text: "Reply with exactly: hello from Vera Codex",
            }],
        },
    ],
});

for await (const event of stream) {
    if (event.type === "text_delta") {
        process.stdout.write(event.text);
    }
}
process.stdout.write("\n");

const result = await stream.result();
if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw new Error(result.errorMessage ?? `Model stopped: ${result.stopReason}`);
}
