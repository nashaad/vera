import { appendFileSync } from "node:fs";

import { createWorkerRequestPreparer, type WorkerAdapterOptions } from
    "../../../src/host/worker/adapter.ts";
import { ModelEventStream } from "../../../src/model/stream.ts";
import { emptyUsage, type ModelAdapter } from "../../../src/model/types.ts";

interface FixtureOptions extends WorkerAdapterOptions {
    readonly recordPath: string;
}

export default function requestOptionsAdapter(raw: unknown): ModelAdapter {
    const options = raw as FixtureOptions;
    const prepare = createWorkerRequestPreparer(options);
    return {
        stream(request) {
            const stream = new ModelEventStream();
            const prepared = prepare(
                request,
                request.provider ?? options.provider,
            );
            if (prepared instanceof Promise) {
                throw new Error("fixture request preparation must be synchronous");
            }
            appendFileSync(
                options.recordPath,
                `${JSON.stringify(prepared.bodyExtensions)}\n`,
                "utf8",
            );
            stream.push({ type: "start" });
            stream.push({
                type: "done",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "worker answered" }],
                    source: {
                        provider: options.provider,
                        api: "fixture",
                        model: request.model,
                    },
                    usage: emptyUsage(),
                    stopReason: "stop",
                },
            });
            return stream;
        },
    };
}
