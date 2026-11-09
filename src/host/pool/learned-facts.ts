import { join } from "node:path";

import { classifyCapabilityRejection } from "../../model/capability-rejection.ts";
import { createPoolEffortPool, learnedFact, learnedSupportedFact } from "../../model/effort-pool.ts";
import { effortLearnedKey, IMAGES_LEARNED_KEY, type LearnedFact } from "../../model/pool-file.ts";
import { ProviderFailureError } from "../../model/provider-failure.ts";
import type { ModelRequest, ModelStreamEvent } from "../../model/types.ts";
import type { HostLog } from "../host-log.ts";
import type { WorkerGlobals } from "./worker-globals.ts";

export function createLearnedFactObserver(globals: WorkerGlobals, home: string, log: HostLog) {
    return async (workspace: string, request: ModelRequest, event: ModelStreamEvent, contentStarted: boolean): Promise<void> => {
        let key: string | undefined;
        let fact: LearnedFact | undefined;
        if (event.type === "error" && request.signal?.aborted !== true && !contentStarted
            && event.error instanceof ProviderFailureError) {
            const rejection = classifyCapabilityRejection(event.error.failure);
            if (rejection !== undefined) {
                key = rejection.parameter === "reasoning_effort"
                    ? request.reasoningEffort === undefined ? undefined : effortLearnedKey(request.reasoningEffort)
                    : rejection.parameter;
                if (key !== undefined) fact = learnedFact(rejection.message);
            }
        } else if (event.type === "done" && request.provider !== undefined
            && event.message.stopReason !== "error" && event.message.stopReason !== "aborted") {
            const ref = { provider: request.provider, model: request.model };
            const pool = createPoolEffortPool({ projectRoot: workspace, userPath: join(home, "pool.json") });
            if (pool.resolveImageSupport(ref) === undefined && request.messages.some((message) =>
                message.role === "user" && message.content.some((block) => block.type === "image")
            )) {
                key = IMAGES_LEARNED_KEY;
                fact = learnedSupportedFact();
            }
        }
        if (key === undefined || fact === undefined) return;
        try {
            await globals.request<void>("poolLearned", `${request.provider ?? ""}/${request.model}`, key, fact);
        } catch (error) {
            if (!(error instanceof Error) || error.name !== "PoolFileWriteRefusedError") throw error;
            log({ type: "pool_write_refused", message: error.message });
        }
    };
}
