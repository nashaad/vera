import { appendFileSync } from "node:fs";
import { FauxAdapter } from "../../support/faux-adapter.ts";
import {
    emptyUsage,
    type AssistantContent,
    type ModelAdapter,
} from "../../../src/model/types.ts";

export default function explorerAdapter(options: unknown): ModelAdapter {
    const { requestsPath } = options as { readonly requestsPath: string };
    return {
        stream(request) {
            appendFileSync(requestsPath, JSON.stringify({
                pid: process.pid,
                model: request.model,
                effort: request.reasoningEffort,
                system: request.systemPrompt,
                messages: request.messages,
                tools: request.tools,
            }) + "\n");
            const hasResults = request.messages.some((message) => message.role === "tool_result");
            let content: AssistantContent;
            if (request.model === "parent" && !hasResults) {
                content = {
                    type: "tool_call", id: "investigate", name: "subagent",
                    input: { agent: "explorer", description: "Find the appointment date in record.txt." },
                };
            } else if (request.model === "small" && !hasResults) {
                content = {
                    type: "tool_call", id: "source", name: "read",
                    input: { path: "record.txt", offset: 1, limit: 2 },
                };
            } else {
                content = {
                    type: "text",
                    text: request.model === "small"
                        ? "The appointment moved to Friday (record.txt:2)."
                        : "Investigation completed.",
                };
            }
            return new FauxAdapter([{
                role: "assistant", content: [content],
                source: { provider: "faux", api: "scripted", model: request.model },
                usage: emptyUsage(),
                stopReason: content.type === "tool_call" ? "tool_use" : "stop",
            }]).stream(request);
        },
    };
}
