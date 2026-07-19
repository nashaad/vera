import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";

export function renderTuiStatusLine(
    settings: ModelTurnSettings | undefined,
    message: string,
): string {
    if (settings === undefined) {
        return `model loading · thinking loading · ${message}`;
    }
    const thinking = settings.reasoningEffort ?? "default";
    return `${settings.model} · thinking ${thinking} · ${message}`;
}
