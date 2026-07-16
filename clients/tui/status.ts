import type { ReasoningSelection } from "../../src/model/reasoning-effort.ts";

export function renderTuiStatusLine(
    model: string,
    reasoning: ReasoningSelection | undefined,
    message: string,
): string {
    const thinking = renderReasoning(reasoning);
    return `${model} · ${thinking} · ${message}`;
}

function renderReasoning(reasoning: ReasoningSelection | undefined): string {
    if (reasoning === undefined) {
        return "thinking default";
    }
    if (reasoning.requested === reasoning.providerEffort) {
        return `thinking ${reasoning.requested}`;
    }
    const inference = reasoning.inferred ? " (inferred)" : "";
    return `thinking ${reasoning.requested} → ${reasoning.providerEffort}${inference}`;
}
