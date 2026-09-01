import { PreimageStash, sweepStaleStashes } from "../store/preimage-stash.ts";
import type { ManagedProcessRegistry } from "../tools/process-runtime.ts";
import { ToolRuntime } from "../tools/runtime.ts";

let sweepStarted = false;

export function newStashingToolRuntime(
    workspace: string,
    sessionId: string,
    env?: Readonly<Record<string, string>>,
    instructionRoot?: string,
    processRegistry?: ManagedProcessRegistry,
    isSubagent?: boolean,
): ToolRuntime {
    if (!sweepStarted) {
        sweepStarted = true;
        void sweepStaleStashes();
    }
    const stash = new PreimageStash(sessionId);
    return new ToolRuntime(
        workspace,
        (path, content) => stash.capture(path, content),
        stash.directory,
        env,
        instructionRoot,
        processRegistry?.scope(sessionId),
        isSubagent,
    );
}
