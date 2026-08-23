import { FauxAdapter } from "../../support/faux-adapter.ts";
import type { AssistantMessage, ModelAdapter } from "../../../src/model/types.ts";
import { writeFileSync } from "node:fs";

/**
 * A worker's model, built inside the worker from JSON.
 *
 * The adapter is a live object holding credentials, so it never crosses the
 * pipe. What crosses is the module to import and the options to pass, which is
 * how a worker gets a model without the host handing it one.
 */
export default function scriptedAdapter(
    options: unknown,
): ModelAdapter {
    const configured = options as {
        readonly script: AssistantMessage[];
        readonly pidPath?: string;
    };
    if (configured.pidPath !== undefined) {
        writeFileSync(configured.pidPath, `${process.pid}\n`, "utf8");
    }
    const script = configured.script;
    return new FauxAdapter(script);
}
