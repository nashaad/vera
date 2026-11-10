import type { NoticeFacts } from "../../src/engine/notice-facts.ts";

export function cacheMissText(notice: { readonly key: string; readonly facts: NoticeFacts }): string | undefined {
    if (notice.key !== "cache_miss") return undefined;
    const { calls, reread_tokens: reread, input_tokens: input, model } = notice.facts;
    if (!isPositiveNumber(calls) || !isPositiveNumber(reread) || !isPositiveNumber(input)) return undefined;
    if (typeof model !== "string" || model === "") return undefined;
    const percent = Math.round(100 * reread / input);
    return `Prompt cache keeps missing: the last ${calls} calls to ${model} re-read ${formatTokens(reread)} tokens it had already cached (${percent}% of their input).`;
}

function isPositiveNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function formatTokens(tokens: number): string {
    if (tokens < 1_000) return String(tokens);
    if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
    if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
    return `${(tokens / 1_000_000).toFixed(1)}m`;
}
