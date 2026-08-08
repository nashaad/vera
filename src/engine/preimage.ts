import { PreimageStash, sweepStaleStashes } from "../store/preimage-stash.ts";
import { ToolRuntime } from "../tools/runtime.ts";

let sweepStarted = false;

/**
 * Builds the engine's ToolRuntime with pre-image capture wired in, so the
 * tools layer never imports the stash store. The first construction per
 * process also sweeps stash directories past their retention age.
 */
export function newStashingToolRuntime(
    workspace: string,
    sessionId: string,
    env?: Readonly<Record<string, string>>,
    instructionRoot?: string,
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
    );
}
