import type { InboundCommandRouter } from "../engine/inbound-command-router.ts";

const IDLE_POLL_MS = 10;

// Clearing the halt while the cut turn is still live lets its next step run.
// A block that lands meanwhile owns the halt, so it is left in place.
export async function clearCutHaltWhenIdle(
    router: Pick<InboundCommandRouter, "timelineBlocked" | "clearHalt">,
    isBlockHeld: () => boolean,
): Promise<void> {
    while (router.timelineBlocked()) {
        await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
    }
    if (!isBlockHeld()) router.clearHalt();
}
