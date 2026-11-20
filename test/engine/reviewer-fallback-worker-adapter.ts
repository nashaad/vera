import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { emptyUsage, type AssistantMessage, type ModelAdapter } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

interface Options {
    readonly root: string;
    readonly recordPath: string;
}

export default function classifierFixture(raw: unknown): ModelAdapter {
    const options = raw as Options;
    const source = { provider: "faux", api: "fixture", model: "first" };
    const reply = (text: string): AssistantMessage => ({
        role: "assistant", content: [{ type: "text", text }],
        source, usage: emptyUsage(), stopReason: "stop",
    });
    const call = (id: string): AssistantMessage => ({
        role: "assistant",
        content: [{
            type: "tool_call", id, name: "bash",
            input: { command: `rm -rf ${JSON.stringify(join(options.root, "absent"))}` },
        }],
        source, usage: emptyUsage(), stopReason: "tool_use",
    });
    const verdict = reply(JSON.stringify({
        outcome: "allow", rationale: "clear", risk_level: "low", user_authorization: "unknown",
    }));
    const adapter = new FauxAdapter([
        call("first"), verdict, reply("done"),
        call("second"), verdict, reply("done"),
        call("third"), verdict, reply("done"),
        call("fourth"), verdict, reply("done"),
        call("fifth"), verdict, reply("done"),
    ]);
    return {
        stream(request) {
            appendFileSync(options.recordPath, `${JSON.stringify({
                model: request.model,
                reasoningEffort: request.reasoningEffort ?? null,
            })}\n`);
            return adapter.stream(request);
        },
    };
}
