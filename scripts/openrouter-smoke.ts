import { loadVeraConfig } from "../src/config.ts";
import { createOpenRouterAdapter } from "../src/model/openrouter.ts";

const apiKey = process.env.OPENROUTER_API_KEY;
const config = loadVeraConfig();

if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required");
}

const adapter = createOpenRouterAdapter({ apiKey });
const stream = adapter.stream({
    model: config.model,
    ...(config.reasoning_effort === undefined
        ? {}
        : { reasoningEffort: config.reasoning_effort }),
    messages: [
        {
            role: "user",
            content: [
                {
                    type: "text",
                    text: "Reply with exactly: hello from Vera",
                },
            ],
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
