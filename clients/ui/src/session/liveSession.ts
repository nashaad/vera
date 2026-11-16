import { CORE_VIEWS } from "../registry/core.ts";
import type { SessionWatch } from "./model.ts";

// `attach_failed` reasons that a second attach cannot change.
const FINAL_FAILURES: ReadonlySet<string> = new Set(["not_found", "history_paging_required"]);

// Views that read the session's transcript, which only a watch that has loaded holds.
// Files reads the folder from disk, and Output and Browser do not read a session.
const NEEDS_TRANSCRIPT: ReadonlySet<string> = new Set([CORE_VIEWS.plan, CORE_VIEWS.review]);

export type ViewGate =
    | { readonly kind: "open" }
    | { readonly kind: "start" }
    | { readonly kind: "unavailable"; readonly reason: string };

export function watchEnded(watch: SessionWatch): boolean {
    return watch.phase === "closed" || watch.phase === "failed";
}

// Starting a session is one more attach, which resumes it on the host without sending anything.
export function canStart(watch: SessionWatch): boolean {
    if (watch.phase === "closed") return true;
    return watch.phase === "failed" && !FINAL_FAILURES.has(watch.failedReason ?? "");
}

export function gateView(viewId: string, watch: SessionWatch): ViewGate {
    if (!NEEDS_TRANSCRIPT.has(viewId) || watch.loaded || !watchEnded(watch)) return { kind: "open" };
    if (canStart(watch)) return { kind: "start" };
    return { kind: "unavailable", reason: watch.error ?? "The session closed." };
}
