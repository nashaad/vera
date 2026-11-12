import type {
    BackgroundAgents,
    Checklist,
    CompactionOutcome,
    CompactionState,
    ContextComponent,
    ContextState,
    DeliveryKind,
    Presentation,
    RetryState,
    TimelineBoundary,
    TimelinePlan,
    TimelineRejection,
    TimelineReply,
    UsageRow,
} from "./model.ts";
import { MAX_CONTEXT_COMPONENTS, MAX_TIMELINE_BOUNDARIES } from "./model.ts";

// Wire shapes for context, compaction, rewind, background work, presentations and failures.

type Fields = Record<string, unknown>;

export interface ModelFailure {
    readonly model: string;
    readonly kind: string;
    readonly statusCode?: number;
    readonly providerMessage?: string;
    // Epoch ms when a rate limit lifts.
    readonly resetsAt?: number;
}

export interface Substitution {
    readonly model: string;
    readonly requested: string;
    readonly using?: string;
    readonly reason: string;
    readonly scope: "effort" | "model";
}

export interface Delivery {
    readonly deliveryId: string;
    readonly sourceAgentId: string;
    readonly deliveryKind: DeliveryKind;
    readonly content: string;
    readonly fromExtension: boolean;
}

export function compactCommand(requestId: string): string {
    return `${JSON.stringify({ type: "compact", requestId })}\n`;
}

export function listTimelineCommand(requestId: string): string {
    return `${JSON.stringify({ type: "list_timeline", requestId })}\n`;
}

export function previewRewindCommand(requestId: string, boundaryId: string): string {
    return `${JSON.stringify({ type: "preview_timeline_action", requestId, boundaryId, action: "rewind_conversation" })}\n`;
}

export function applyTimelineCommand(requestId: string, planId: string): string {
    return `${JSON.stringify({ type: "apply_timeline_action", requestId, planId })}\n`;
}

export function parseContext(value: unknown): ContextState | undefined {
    if (!isRecord(value)) return undefined;
    const tokens = count(value.tokens);
    if (tokens === undefined) return undefined;
    const projection = isRecord(value.projection) ? value.projection : undefined;
    const compaction = isRecord(value.compaction) ? value.compaction : undefined;
    const components = Array.isArray(projection?.components)
        ? projection.components.flatMap((item) => componentOf(item) ?? []).slice(-MAX_CONTEXT_COMPONENTS)
        : [];
    return {
        tokens,
        estimated: value.estimated === true,
        components,
        ...optional("capacity", count(value.capacity)),
        ...optional("overheadTokens", count(value.overheadTokens)),
        ...optional("projectedTokens", count(projection?.estimatedTokens)),
        ...optional("triggerTokens", count(compaction?.triggerTokens)),
        ...optional("triggerFraction", fraction(compaction?.triggerFraction)),
    };
}

function componentOf(value: unknown): ContextComponent | undefined {
    if (!isRecord(value)) return undefined;
    const { kind } = value;
    if (kind !== "prompt_contribution" && kind !== "tool_schema" && kind !== "message") return undefined;
    const id = str(value.id);
    const tokens = count(value.estimatedTokens);
    if (id === undefined || tokens === undefined) return undefined;
    return {
        kind,
        id,
        source: str(value.source) ?? "",
        displayName: str(value.displayName) ?? id,
        estimatedTokens: tokens,
    };
}

export function parseUsage(value: unknown): UsageRow[] | undefined {
    if (!isRecord(value) || !Array.isArray(value.rows)) return undefined;
    const rows: UsageRow[] = [];
    for (const row of value.rows) {
        if (!isRecord(row)) continue;
        const provider = str(row.provider);
        const model = str(row.model);
        if (provider === undefined || model === undefined) continue;
        rows.push({
            provider,
            model,
            calls: count(row.calls) ?? 0,
            inputTokens: count(row.inputTokens) ?? 0,
            outputTokens: count(row.outputTokens) ?? 0,
            cachedInputTokens: count(row.cachedInputTokens) ?? 0,
            totalTokens: count(row.totalTokens) ?? 0,
            ...optional("cost", nonNegative(row.cost)),
        });
    }
    return rows;
}

const COMPACTION_OUTCOMES: readonly CompactionOutcome[] = [
    "compacted", "not_needed", "no_boundary", "rejected", "unavailable", "cancelled", "busy",
];

export function parseCompaction(value: Fields): CompactionState | undefined {
    const phase = value.phase === "started" || value.phase === "finished" ? value.phase : undefined;
    if (phase === undefined) return undefined;
    const outcome = COMPACTION_OUTCOMES.find((candidate) => candidate === value.outcome);
    const trigger: "manual" | "automatic" | undefined =
        value.trigger === "manual" || value.trigger === "automatic" ? value.trigger : undefined;
    return {
        phase,
        ...optional("trigger", trigger),
        ...optional("outcome", outcome),
        ...optional("reason", str(value.reason)),
        ...optional("tokensBefore", count(value.before) ?? (phase === "started" ? count(value.tokens) : undefined)),
        ...optional("tokensAfter", count(value.after)),
    };
}

const REJECTIONS: readonly TimelineRejection[] = [
    "busy", "plan_expired", "not_plan_owner", "boundary_missing", "session_changed", "unavailable",
];

export function parseTimelineReply(type: string, value: Fields): TimelineReply | undefined {
    const requestId = str(value.requestId);
    if (requestId === undefined) return undefined;
    switch (type) {
        case "timeline": {
            if (!Array.isArray(value.boundaries)) return undefined;
            const boundaries = value.boundaries.flatMap((item) => boundaryOf(item) ?? []).slice(-MAX_TIMELINE_BOUNDARIES);
            return { kind: "list", requestId, boundaries };
        }
        case "timeline_action_preview": {
            const plan = planOf(value.plan);
            return plan === undefined ? undefined : { kind: "preview", requestId, plan };
        }
        case "timeline_action_applied": {
            const planId = str(value.planId);
            return planId === undefined ? undefined : { kind: "applied", requestId, planId };
        }
        case "timeline_action_rejected": {
            const operation = value.operation === "preview" || value.operation === "apply" ? value.operation : undefined;
            const reason = REJECTIONS.find((candidate) => candidate === value.reason) ?? "unavailable";
            return operation === undefined ? undefined : { kind: "rejected", requestId, operation, reason };
        }
        default:
            return undefined;
    }
}

function boundaryOf(value: unknown): TimelineBoundary | undefined {
    if (!isRecord(value)) return undefined;
    const userMessageId = str(value.userMessageId);
    const prompt = str(value.prompt);
    const position = count(value.position);
    if (userMessageId === undefined || prompt === undefined || position === undefined) return undefined;
    const stamp = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
    return {
        userMessageId,
        prompt,
        position,
        hasImages: Array.isArray(value.attachments) && value.attachments.length > 0,
        ...(Number.isFinite(stamp) ? { timestamp: stamp } : {}),
    };
}

function planOf(value: unknown): TimelinePlan | undefined {
    if (!isRecord(value)) return undefined;
    const planId = str(value.planId);
    const boundary = boundaryOf(value.boundary);
    const kept = count(value.keptMessageCount);
    const setAside = count(value.setAsideMessageCount);
    if (planId === undefined || boundary === undefined || kept === undefined || setAside === undefined) return undefined;
    return { planId, boundary, keptMessageCount: kept, setAsideMessageCount: setAside };
}

// On `attached` the snapshot sits under `background_agents`; the update carries the fields itself.
export function parseBackground(value: unknown): BackgroundAgents | undefined {
    if (!isRecord(value)) return undefined;
    const running = count(value.running);
    if (running === undefined) return undefined;
    const children = Array.isArray(value.children)
        ? value.children.filter((child): child is string => typeof child === "string")
        : [];
    return { running, children, hasParent: value.has_parent === true };
}

export function parseRetry(value: Fields): RetryState | undefined {
    if (value.phase !== "retrying") return undefined;
    const model = str(value.model);
    const nextAttempt = count(value.nextAttempt);
    const maxAttempts = count(value.maxAttempts);
    const failure = isRecord(value.failure) ? value.failure : undefined;
    const kind = str(failure?.kind);
    if (model === undefined || nextAttempt === undefined || maxAttempts === undefined || kind === undefined) return undefined;
    const retryAt = typeof value.retryAt === "string" ? Date.parse(value.retryAt) : Number.NaN;
    return {
        model,
        nextAttempt,
        maxAttempts,
        failureKind: kind,
        ...(Number.isFinite(retryAt) ? { retryAt } : {}),
        ...optional("statusCode", count(failure?.statusCode)),
    };
}

export function parsePresentation(value: unknown): Presentation | undefined {
    if (!isRecord(value)) return undefined;
    switch (value.kind) {
        case "unified_diff": {
            const path = str(value.path);
            const patch = str(value.patch);
            if (path === undefined || patch === undefined) return undefined;
            return { kind: "diff", diff: { path, patch, ...tally(patch), scratch: value.scratch === true } };
        }
        case "checklist": {
            const checklist = checklistOf(value);
            return checklist === undefined ? undefined : { kind: "checklist", checklist };
        }
        case "tool_notice": {
            const text = str(value.text);
            return text === undefined ? undefined : { kind: "tool_notice", text };
        }
        default:
            return undefined;
    }
}

function checklistOf(value: Fields): Checklist | undefined {
    const path = str(value.path);
    if (path === undefined || !Array.isArray(value.items)) return undefined;
    const items = value.items.flatMap((item) => {
        if (!isRecord(item) || typeof item.text !== "string") return [];
        return [{ text: item.text, done: item.done === true, justDone: item.justDone === true }];
    });
    return { path, items, ...optional("title", str(value.title)) };
}

// Counts the lines a patch adds and removes, skipping the file headers.
export function tally(patch: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const line of patch.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("+")) added += 1;
        else if (line.startsWith("-")) removed += 1;
    }
    return { added, removed };
}

export function parseSubstitution(value: unknown): Substitution | undefined {
    if (!isRecord(value)) return undefined;
    const model = str(value.model);
    const requested = str(value.requested);
    const reason = str(value.reason);
    const scope = value.scope === "effort" || value.scope === "model" ? value.scope : undefined;
    if (model === undefined || requested === undefined || reason === undefined || scope === undefined) return undefined;
    return { model, requested, reason, scope, ...optional("using", str(value.using)) };
}

export function parseModelFailure(value: unknown): ModelFailure | undefined {
    if (!isRecord(value)) return undefined;
    const model = str(value.model);
    const kind = str(value.kind);
    if (model === undefined || kind === undefined) return undefined;
    return {
        model,
        kind,
        ...optional("statusCode", count(value.statusCode)),
        ...optional("providerMessage", str(value.providerMessage)),
        ...optional("resetsAt", count(value.resetsAt)),
    };
}

// Live notifications name the kind `kind`; stored entries name it `deliveryKind`.
export function parseDelivery(value: Fields, kindField: "kind" | "deliveryKind"): Delivery | undefined {
    const deliveryId = str(value.deliveryId);
    const sourceAgentId = str(value.sourceAgentId);
    const content = str(value.content);
    if (deliveryId === undefined || sourceAgentId === undefined || content === undefined) return undefined;
    const kind = value[kindField];
    const deliveryKind: DeliveryKind = kind === "attention" || kind === "peer" ? kind : "completion";
    return { deliveryId, sourceAgentId, content, deliveryKind, fromExtension: value.sourceKind === "extension" };
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
    return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function count(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
    return count(value);
}

function fraction(value: unknown): number | undefined {
    return typeof value === "number" && value > 0 && value <= 1 ? value : undefined;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
