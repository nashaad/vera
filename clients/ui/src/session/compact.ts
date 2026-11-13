import { freshRequestId } from "../composer/requests.ts";
import type { ActiveSession } from "./activeSession.ts";
import { compactCommand } from "./wireTools.ts";

// The host says nothing to a second request while one compaction runs, so none is sent.
export function requestCompaction(session: ActiveSession): void {
    if (session.watch.compaction?.phase === "started") return;
    session.send(compactCommand(freshRequestId("compact")));
}
