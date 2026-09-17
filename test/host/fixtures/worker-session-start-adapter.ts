import { appendFileSync } from "node:fs";
import { emptyUsage, type ModelAdapter } from "../../../src/model/types.ts";
import { FauxAdapter } from "../../support/faux-adapter.ts";

export default function adapter(options: unknown): ModelAdapter {
    const { requestPath } = options as { readonly requestPath: string };
    return {
        stream(request) {
            appendFileSync(requestPath, JSON.stringify(request) + "\n");
            return new FauxAdapter([{
                role: "assistant", content: [{ type: "text", text: "done" }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(), stopReason: "stop",
            }]).stream(request);
        },
    };
}
