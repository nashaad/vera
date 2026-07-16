import { startTui } from "../../clients/tui/main.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";

const responses: AssistantMessage[] = [
    response(`PARTIAL ${"x".repeat(200)} FIRST-END`),
    response("STEER WORKED"),
];

await startTui({
    adapter: new FauxAdapter(responses, { chunkSize: 1, delayMs: 40 }),
    model: "test",
    reasoning: {
        requested: "high",
        providerEffort: "high",
        inferred: false,
    },
});

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
