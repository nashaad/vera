import type { ModelReasoningEffort } from "../../src/model/types.ts";

export function renderTuiStatusLine(
    model: string,
    reasoningEffort: ModelReasoningEffort | undefined,
    message: string,
): string {
    return `${model} · thinking ${reasoningEffort ?? "default"} · ${message}`;
}
