import type {
    ModelReasoningEffort,
    ModelTool,
    ToolPresentation,
} from "../model/types.ts";
import type { ApprovalMode } from "../sdk/permissions.ts";
import type { ToolRuntime } from "./runtime.ts";

export interface ToolOutput {
    readonly kind: "output";
    readonly output: string;
    readonly isError: boolean;
    readonly presentation?: ToolPresentation;
}

export interface SpawnSubagentEffect {
    readonly type: "spawn_subagent";
    readonly description: string;
}

export interface SpawnAsyncSubagentEffect {
    readonly type: "spawn_async_subagent";
    readonly description: string;
}

export interface MessageSubagentEffect {
    readonly type: "message_subagent";
    readonly subagentId: string;
    readonly message: string;
}

export interface NotifyParentEffect {
    readonly type: "notify_parent";
    readonly message: string;
}

export type ToolEffect =
    | SpawnSubagentEffect
    | SpawnAsyncSubagentEffect
    | MessageSubagentEffect
    | NotifyParentEffect;

export interface AskUserChoice {
    readonly id: string;
    readonly label: string;
}

export interface AskUserInteraction {
    readonly type: "ask_user";
    readonly question: string;
    readonly choices: readonly AskUserChoice[];
}

export interface ToolEffectContext {
    readonly approvalMode: ApprovalMode;
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export interface ToolEffectRequest {
    readonly kind: "effect";
    readonly effect: ToolEffect;
}

export interface ToolInteractionRequest {
    readonly kind: "interaction";
    readonly interaction: AskUserInteraction;
}

export type ApplyToolEffect = (
    effect: ToolEffect,
    signal: AbortSignal,
    context: ToolEffectContext,
) => Promise<ToolOutput>;

// Tools either finish with text or return a plain-data request for the engine
// owner to resolve. Live loops, stores, UI objects, and AbortControllers never
// cross this boundary.
export type ToolExecutionResult =
    | ToolOutput
    | ToolEffectRequest
    | ToolInteractionRequest;

export type PermissionInputKind = "path" | "url";
export type PermissionInputVerb = "read" | "write" | "delete";

/**
 * Declares that one of a tool's string inputs names a filesystem path or a
 * URL, so the permission engine can gate it the same way it gates bash
 * commands, instead of only structured file tools getting checked.
 */
export interface PermissionInputSpec {
    readonly field: string;
    readonly kind: PermissionInputKind;
    readonly verb: PermissionInputVerb;
}

export interface RegisteredTool {
    readonly definition: ModelTool;
    readonly parallel?: boolean;
    readonly effectType?: ToolEffect["type"];
    /** A deliberately recognized permission operation for this whole tool. */
    readonly permissionOperation?: string;
    readonly requiresUserInteraction?: boolean;
    /** Path/URL inputs to gate by permission rules. See `PermissionInputSpec`. */
    readonly permissionInputs?: readonly PermissionInputSpec[];
    execute(
        input: Readonly<Record<string, unknown>>,
        context: ToolRuntime,
        signal: AbortSignal,
    ): Promise<ToolExecutionResult>;
}
