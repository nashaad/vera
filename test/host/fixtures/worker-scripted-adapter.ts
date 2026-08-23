import { FauxAdapter } from "../../support/faux-adapter.ts";
import type { AssistantMessage, ModelAdapter } from "../../../src/model/types.ts";

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
    const script = (options as { readonly script: AssistantMessage[] }).script;
    return new FauxAdapter(script);
}
