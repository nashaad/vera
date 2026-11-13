// What the session page shows, built from the host's `history` entries and the
// live updates that follow them on the watch connection.

import type { ModelRefusal, ModelSettingsReply } from "../models/settings.ts";
import type { ApprovalState } from "./permissions.ts";
import type { OpenRequest } from "./requests.ts";

export type ToolState = "running" | "done" | "failed";

export interface FileDiff {
    readonly path: string;
    readonly patch: string;
    readonly added: number;
    readonly removed: number;
    // The file sits in the session's scratch directory: working notes, not the person's files.
    readonly scratch: boolean;
}

export interface ChecklistItem {
    readonly text: string;
    readonly done: boolean;
    // Ticked by the write that produced this checklist.
    readonly justDone: boolean;
}

export interface Checklist {
    readonly path: string;
    readonly title?: string;
    readonly items: readonly ChecklistItem[];
}

export interface DiffPresentation {
    readonly kind: "diff";
    readonly diff: FileDiff;
}

export interface ChecklistPresentation {
    readonly kind: "checklist";
    readonly checklist: Checklist;
}

// Sent in place of a diff too large to show.
export interface ToolNoticePresentation {
    readonly kind: "tool_notice";
    readonly text: string;
}

export type Presentation = DiffPresentation | ChecklistPresentation | ToolNoticePresentation;

export interface ToolCall {
    readonly tool: string;
    // One line naming the call, such as `Read config.ts` or `bash git status`.
    readonly title: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly output?: string;
    readonly state: ToolState;
    // What the call changed, attached after it finished.
    readonly presentation?: Presentation;
}

export interface UserBlock {
    readonly kind: "user";
    readonly key: string;
    readonly text: string;
    readonly at?: number;
}

export interface ThoughtBlock {
    readonly kind: "thought";
    readonly key: string;
    readonly text: string;
    // True while this thought is still streaming.
    readonly live: boolean;
    readonly at?: number;
}

export interface TextBlock {
    readonly kind: "text";
    readonly key: string;
    readonly text: string;
    readonly at?: number;
}

export interface ToolsBlock {
    readonly kind: "tools";
    readonly key: string;
    readonly calls: readonly ToolCall[];
    // True while later calls may still join this group.
    readonly active: boolean;
    readonly at?: number;
}

export type NoticeTone = "info" | "warning" | "error";

export interface NoticeBlock {
    readonly kind: "notice";
    readonly key: string;
    readonly tone: NoticeTone;
    readonly text: string;
    // A short heading above the text, for failures with a known cause.
    readonly title?: string;
    // Epoch ms when a rate limit lifts.
    readonly resetsAt?: number;
    readonly at?: number;
}

export interface SubstitutionBlock {
    readonly kind: "substitution";
    readonly key: string;
    readonly text: string;
    readonly scope: "effort" | "model";
    readonly source: "turn" | "subagent";
    readonly at?: number;
}

export type DeliveryKind = "attention" | "completion" | "peer";

// A report delivered into this session, such as a finished subagent's conclusion.
export interface DeliveryBlock {
    readonly kind: "delivery";
    readonly key: string;
    readonly deliveryId: string;
    readonly sourceAgentId: string;
    readonly deliveryKind: DeliveryKind;
    readonly text: string;
    readonly fromExtension: boolean;
    readonly at?: number;
}

export type Block = UserBlock | ThoughtBlock | TextBlock | ToolsBlock | NoticeBlock | SubstitutionBlock | DeliveryBlock;

export type AgentRunStatus = "idle" | "working" | "waiting";

export interface QueuedPrompt {
    readonly content: string;
    // Held prompts wait for the turn to end; released ones join it at the next tool step.
    readonly state: "held" | "released";
}

export interface WithdrawnPrompt {
    readonly requestId: string;
    readonly content: string;
}

export interface RefusedPrompt {
    readonly requestId?: string;
    readonly content?: string;
    readonly reason: string;
}

export interface ImageAttached {
    readonly requestId: string;
    readonly outcome: "attached";
    readonly attachmentId: string;
}

export interface ImageRejected {
    readonly requestId: string;
    readonly outcome: "rejected";
    readonly error: string;
}

export type ImageReply = ImageAttached | ImageRejected;

export type WatchPhase = "attaching" | "attached" | "failed" | "closed";

export type ContextComponentKind = "prompt_contribution" | "tool_schema" | "message";

export interface ContextComponent {
    readonly kind: ContextComponentKind;
    readonly id: string;
    readonly source: string;
    readonly displayName: string;
    readonly estimatedTokens: number;
}

export interface ContextState {
    readonly tokens: number;
    readonly capacity?: number;
    // True when Vera counted the request itself rather than the provider.
    readonly estimated: boolean;
    readonly overheadTokens?: number;
    // Estimated tokens per part of the request, capped at MAX_CONTEXT_COMPONENTS.
    readonly components: readonly ContextComponent[];
    readonly projectedTokens?: number;
    readonly triggerTokens?: number;
    readonly triggerFraction?: number;
}

export type CompactionOutcome = "compacted" | "not_needed" | "no_boundary" | "rejected" | "unavailable" | "cancelled" | "busy";

export interface CompactionState {
    readonly phase: "started" | "finished";
    readonly trigger?: "manual" | "automatic";
    readonly outcome?: CompactionOutcome;
    readonly reason?: string;
    readonly tokensBefore?: number;
    readonly tokensAfter?: number;
    readonly provider?: string;
    readonly model?: string;
}

export interface TimelineBoundary {
    readonly userMessageId: string;
    readonly timestamp?: number;
    readonly prompt: string;
    readonly hasImages: boolean;
    readonly position: number;
}

export interface TimelinePlan {
    readonly planId: string;
    readonly boundary: TimelineBoundary;
    readonly keptMessageCount: number;
    readonly setAsideMessageCount: number;
}

export type TimelineRejection = "busy" | "plan_expired" | "not_plan_owner" | "boundary_missing" | "session_changed" | "unavailable";

export interface TimelineListReply {
    readonly kind: "list";
    readonly requestId: string;
    readonly boundaries: readonly TimelineBoundary[];
}

export interface TimelinePreviewReply {
    readonly kind: "preview";
    readonly requestId: string;
    readonly plan: TimelinePlan;
}

export interface TimelineAppliedReply {
    readonly kind: "applied";
    readonly requestId: string;
    readonly planId: string;
}

export interface TimelineRejectedReply {
    readonly kind: "rejected";
    readonly requestId: string;
    readonly operation: "preview" | "apply";
    readonly reason: TimelineRejection;
}

export type TimelineReply = TimelineListReply | TimelinePreviewReply | TimelineAppliedReply | TimelineRejectedReply;

export interface BackgroundAgents {
    readonly running: number;
    // Titles of the running children, not their ids.
    readonly children: readonly string[];
    readonly hasParent: boolean;
}

export interface RetryState {
    readonly model: string;
    readonly nextAttempt: number;
    readonly maxAttempts: number;
    // Epoch ms of the next attempt.
    readonly retryAt?: number;
    readonly failureKind: string;
    readonly statusCode?: number;
}

export interface UsageRow {
    readonly provider: string;
    readonly model: string;
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly totalTokens: number;
    readonly cost?: number;
}

export interface SessionWatch {
    readonly agentId: string;
    readonly phase: WatchPhase;
    // Set by the first `history` event; before it, an empty transcript is not yet known to be empty.
    readonly loaded: boolean;
    // Why the watch failed or closed, in words for the user.
    readonly error?: string;
    // Blocks from stored history, oldest first.
    readonly history: readonly Block[];
    // Blocks from live updates since the last `history` event.
    readonly live: readonly Block[];
    readonly status: AgentRunStatus;
    readonly hasOlder: boolean;
    // Exclusive cursor for the next older page.
    readonly olderBefore?: string;
    readonly loadingOlder: boolean;
    readonly title?: string;
    readonly queue: readonly QueuedPrompt[];
    // The last prompt taken back out of the queue, for the composer to restore.
    readonly withdrawn?: WithdrawnPrompt;
    // The last prompt the session would not take.
    readonly refused?: RefusedPrompt;
    // Answers to this window's image attachments, newest last, capped at MAX_IMAGE_REPLIES.
    readonly images: readonly ImageReply[];
    // Approvals and questions still open, oldest first.
    readonly requests: readonly OpenRequest[];
    // Unknown until the session answers `get_permissions`.
    readonly approval?: ApprovalState;
    // The id of the last permissions change the session refused.
    readonly approvalRefused?: string;
    // Unknown until the session answers `get_model_settings`.
    readonly models?: ModelSettingsReply;
    readonly modelRefused?: ModelRefusal;
    // The last measurement of the session's context window.
    readonly context?: ContextState;
    readonly usage?: readonly UsageRow[];
    readonly compaction?: CompactionState;
    // The last answer to this window's rewind requests.
    readonly timeline?: TimelineReply;
    readonly background?: BackgroundAgents;
    // Set while a failed model request waits to be tried again.
    readonly retry?: RetryState;
}

// The page keeps at most this many history blocks; older pages drop off the far end.
export const MAX_HISTORY_BLOCKS = 2_000;

export const MAX_IMAGE_REPLIES = 32;

// One component per message, so a long session is cut to its newest parts.
export const MAX_CONTEXT_COMPONENTS = 600;

export const MAX_TIMELINE_BOUNDARIES = 500;
