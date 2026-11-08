import { FauxAdapter } from "../../support/faux-adapter.ts";
import type { AssistantMessage, ModelAdapter } from "../../../src/model/types.ts";
import { appendFileSync, writeFileSync } from "node:fs";

/**
 * A worker's model, built inside the worker from JSON.
 *
 * The adapter is a live object holding credentials, so it never crosses the
 * pipe. What crosses is the module to import and the options to pass, which is
 * how a worker gets a model without the host handing it one.
 */
export default async function scriptedAdapter(
    options: unknown,
): Promise<ModelAdapter> {
    const configured = options as {
        readonly script: AssistantMessage[];
        readonly pidPath?: string;
        readonly startupDelayMs?: number;
        readonly requestLogPath?: string;
        readonly delayMs?: number;
    };
    // The worker loads its adapter before its loop listens for events.
    if (configured.startupDelayMs !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, configured.startupDelayMs));
    }
    if (configured.pidPath !== undefined) {
        writeFileSync(configured.pidPath, `${process.pid}\n`, "utf8");
    }
    const script = configured.script;
    const adapter = new FauxAdapter(script, { delayMs: configured.delayMs });
    if (configured.requestLogPath === undefined) return adapter;
    const stream = adapter.stream.bind(adapter);
    adapter.stream = (request) => {
        appendFileSync(configured.requestLogPath!, "request\n", "utf8");
        return stream(request);
    };
    return adapter;
}
