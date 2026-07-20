import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";

export function renderTuiStatusLine(
    settings: ModelTurnSettings | undefined,
    approvalMode: ApprovalMode | undefined,
    message: string,
): string {
    const model = settings?.model ?? "loading";
    const thinking = settings === undefined
        ? "loading"
        : settings.reasoningEffort ?? "default";
    const permissions = approvalMode ?? "loading";
    return `${message} · ${model} · reasoning ${thinking} · permissions ${permissions}`;
}
