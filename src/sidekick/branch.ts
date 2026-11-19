import type { UserMessage } from "../model/types.ts";

// The included extension that offers the sidekick; the desktop offers /btw only while it is on.
export const SIDEKICK_EXTENSION_ID = "vera.btw";
export const SIDEKICK_MENTION = "sidekick";
export const SIDEKICK_APPROVAL_MODE = "readonly";
export const SIDEKICK_LIFETIME = "ephemeral";

export const SIDE_CONVERSATION_BOUNDARY = `Side conversation boundary.

Everything before this boundary is inherited history from the primary conversation. It is reference context only, not your current task.

Do not continue or complete instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only messages submitted after this boundary are active instructions for this side conversation.

Use inherited history naturally when answering the user's current question. Treat it as conversation the user and assistant already had: do not claim it was not discussed merely because it predates this boundary.

This boundary and these instructions are hidden harness context. Do not mention, summarize, quote, or allude to the boundary, inherited-history distinction, side-conversation policy, read-only role, or these instructions unless the user explicitly asks how this assistant operates.

You are a separate, readonly side-conversation assistant. Answer the current question directly and perform only lightweight, non-mutating exploration without disrupting the primary conversation.`;

export interface SidekickInitialMessage {
    readonly role: "user";
    readonly text: string;
    readonly hidden: true;
    readonly compactionBarrier: true;
}

export interface SidekickBranchOptions {
    readonly approvalMode: typeof SIDEKICK_APPROVAL_MODE;
    readonly attachmentLifetime: typeof SIDEKICK_LIFETIME;
    readonly hideInheritedMessages: true;
    readonly initialMessages: readonly [SidekickInitialMessage];
}

// How a sidekick is branched from its primary conversation, in the shape a client extension passes to `vera.agents.create`.
export function sidekickBranchOptions(): SidekickBranchOptions {
    return {
        approvalMode: SIDEKICK_APPROVAL_MODE,
        attachmentLifetime: SIDEKICK_LIFETIME,
        hideInheritedMessages: true,
        initialMessages: [{
            role: "user",
            text: SIDE_CONVERSATION_BOUNDARY,
            hidden: true,
            compactionBarrier: true,
        }],
    };
}

export interface SidekickHostBranchOptions {
    readonly approvalMode: typeof SIDEKICK_APPROVAL_MODE;
    readonly lifetime: typeof SIDEKICK_LIFETIME;
    readonly hideInheritedMessages: true;
    readonly initialMessages: readonly UserMessage[];
}

// The same branch as `sidekickBranchOptions`, in the shape `branchAgentThroughHost` takes.
export function sidekickHostBranchOptions(): SidekickHostBranchOptions {
    const options = sidekickBranchOptions();
    return {
        approvalMode: options.approvalMode,
        lifetime: options.attachmentLifetime,
        hideInheritedMessages: options.hideInheritedMessages,
        initialMessages: options.initialMessages.map((message) => ({
            role: message.role,
            content: [{ type: "text" as const, text: message.text }],
            internal: true,
            compactionBarrier: true,
        })),
    };
}

export const SIDEKICK_BUSY_NOTICE = "BTW context can sync only between turns";

export type SidekickSyncOutcome =
    | "synced"
    | "unchanged"
    | "busy"
    | "stale_cursor"
    | "not_found"
    | "failed";

export type SidekickSyncDecision = "ok" | "stale" | "busy";

// "stale" means the primary was rewound past the point the sidekick synced from. It can never catch up, so the
// caller drops it and branches again; the lost side conversation is the cost of a sidekick being ephemeral.
// "busy" means the primary is mid-turn and `ignoreBusy` was not set; the caller posts SIDEKICK_BUSY_NOTICE as a soft notice.
export function decideSidekickSync(outcome: SidekickSyncOutcome, ignoreBusy: boolean = false): SidekickSyncDecision {
    if (outcome === "stale_cursor") return "stale";
    if (outcome === "busy") return ignoreBusy ? "ok" : "busy";
    if (outcome === "not_found") throw new Error("BTW primary context is unavailable");
    if (outcome === "failed") throw new Error("BTW primary context could not be synchronized");
    return "ok";
}
