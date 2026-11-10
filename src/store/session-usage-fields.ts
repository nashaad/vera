import type { AssistantMessage, ModelUsage } from "../model/types.ts";
import type { SessionJsonFields } from "./session-json-fields.ts";

function validUsage(fields: SessionJsonFields | undefined): boolean {
    if (fields === undefined || !Number.isFinite(fields.inputTokens) || !Number.isFinite(fields.outputTokens)
        || !Number.isFinite(fields.cachedInputTokens) || !Number.isFinite(fields.reasoningTokens)
        || !Number.isFinite(fields.totalTokens)
        || (fields.cacheWriteInputTokens !== undefined && !Number.isFinite(fields.cacheWriteInputTokens))
        || (fields.cost !== undefined && !Number.isFinite(fields.cost))) return false;
    return true;
}

function usageOf(fields: SessionJsonFields | undefined): ModelUsage | undefined {
    if (fields === undefined || !validUsage(fields)) return undefined;
    return {
        inputTokens: fields.inputTokens!, outputTokens: fields.outputTokens!, cachedInputTokens: fields.cachedInputTokens!,
        ...(fields.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: fields.cacheWriteInputTokens }),
        reasoningTokens: fields.reasoningTokens!, totalTokens: fields.totalTokens!,
        ...(fields.cost === undefined ? {} : { cost: fields.cost }),
    };
}

export function replyUsageFields(fields: SessionJsonFields | undefined): SessionJsonFields | null | undefined {
    const source = fields?.source ?? fields;
    const usage = fields?.usage ?? fields;
    if (fields?.role !== "assistant" || source === undefined || typeof source.provider !== "string"
        || typeof source.model !== "string" || typeof source.api !== "string" || !validUsage(usage)
        || (fields.durationMs !== undefined && (typeof fields.durationMs !== "number"
            || !Number.isFinite(fields.durationMs) || fields.durationMs < 0))) return undefined;
    if (source.api === "none") return null;
    return fields;
}

export function billedUsageFields(fields: SessionJsonFields | undefined, api: "compaction" | "ask"): AssistantMessage | undefined {
    const usage = usageOf(fields?.usage);
    if (fields === undefined || typeof fields.provider !== "string" || typeof fields.model !== "string" || usage === undefined) return undefined;
    return { role: "assistant", content: [], stopReason: "stop", source: { provider: fields.provider, model: fields.model, api }, usage };
}
