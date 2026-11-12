import type { CompactionState, NoticeTone } from "./model.ts";
import type { ModelFailure, Substitution } from "./wireTools.ts";

// Words for substitution, failure and compaction notices. Mirrors the host's own substitution sentence.

export function substitutionText(substitution: Substitution): string {
    const { model, requested, using, reason } = substitution;
    if (substitution.scope === "model") {
        return using === undefined
            ? `Requested model ${requested}, and nothing ran in its place, because ${reason}.`
            : `Requested model ${requested}, ran ${using} instead, because ${reason}.`;
    }
    const on = model.length === 0 ? "" : ` on ${model}`;
    return using === undefined
        ? `Requested reasoning effort "${requested}"${on}, ran with no reasoning level at all, because ${reason}.`
        : `Requested reasoning effort "${requested}"${on}, ran at "${using}" instead, because ${reason}.`;
}

const FAILURE_TITLES: Readonly<Record<string, string>> = {
    connection: "Could not reach the provider",
    timeout: "The provider timed out",
    rate_limit: "Rate limited",
    server: "The provider had an error",
    authentication: "The provider did not accept the key",
    payment_required: "The provider account needs credit",
    permission: "No access to this model",
    invalid_request: "The provider refused the request",
    request_build: "The request could not be built",
    not_found: "The provider does not know this model",
    request_too_large: "The request is too large for this model",
};

export function failureTitle(failure: ModelFailure): string {
    const title = FAILURE_TITLES[failure.kind] ?? "The model request failed";
    return `${title} (${failure.model})`;
}

// The provider's own words when it gave any, then the turn's error.
export function failureText(failure: ModelFailure | undefined, detail: string | undefined): string {
    const provider = failure?.providerMessage?.trim();
    if (provider !== undefined && provider.length > 0 && provider !== detail) {
        return detail === undefined ? provider : `${detail}\n${provider}`;
    }
    return detail ?? "The turn failed.";
}

export const EMPTY_TURN_TEXT = "This turn ended with nothing to show.";

export interface CompactionNotice {
    readonly tone: NoticeTone;
    readonly text: string;
}

export function compactionNotice(compaction: CompactionState): CompactionNotice | undefined {
    if (compaction.phase !== "finished") return undefined;
    const why = compaction.reason === undefined ? "" : ` ${compaction.reason}`;
    switch (compaction.outcome) {
        case "compacted": {
            const { tokensBefore, tokensAfter } = compaction;
            const counts = tokensBefore !== undefined && tokensAfter !== undefined
                ? ` from ${tokenCount(tokensBefore)} to ${tokenCount(tokensAfter)} tokens`
                : "";
            return { tone: "info", text: `Compacted the conversation${counts}.` };
        }
        case "not_needed":
            return { tone: "info", text: `Nothing to compact yet.${why}` };
        case "no_boundary":
            return { tone: "info", text: `Nothing older to summarize yet.${why}` };
        case "busy":
            return { tone: "warning", text: "Compact waits until the turn ends and the queue is empty." };
        case "cancelled":
            return { tone: "info", text: "Compaction was cancelled." };
        case "rejected":
        case "unavailable":
            return { tone: "warning", text: `Compaction did not run.${why}` };
        default:
            return undefined;
    }
}

export function tokenCount(tokens: number): string {
    if (tokens < 1_000) return String(tokens);
    if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}K`;
    if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}K`;
    return `${(tokens / 1_000_000).toFixed(1)}M`;
}
