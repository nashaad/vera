// What the session page shows, built from the host's `history` entries and the
// live updates that follow them on the watch connection.

import type { ApprovalState } from "./permissions.ts";
import type { OpenRequest } from "./requests.ts";

export type ToolState = "running" | "done" | "failed";

export interface ToolCall {
    readonly tool: string;
    // One line naming the call, such as `Read config.ts` or `bash git status`.
    readonly title: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly output?: string;
    readonly state: ToolState;
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
    readonly at?: number;
}

export type Block = UserBlock | ThoughtBlock | TextBlock | ToolsBlock | NoticeBlock;

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

export interface SessionWatch {
    readonly agentId: string;
    readonly phase: WatchPhase;
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
}

// The page keeps at most this many history blocks; older pages drop off the far end.
export const MAX_HISTORY_BLOCKS = 2_000;

export const MAX_IMAGE_REPLIES = 32;
