import type { VeraClientExtensionApi } from "../../sdk/extensions.ts";
import { instructionBudgetNotice } from "./context-report.ts";

// Posts one soft notice per conversation, after a turn settles, when the
// last measured request carried instructions over the budget.
export function watchInstructionBudget(vera: VeraClientExtensionApi): void {
    let warned = false;
    let working = false;
    const check = (): void => {
        if (warned || working) return;
        const notice = instructionBudgetNotice(vera.context.current());
        if (notice === undefined) return;
        warned = true;
        vera.ui.notice(notice, { tone: "soft" });
    };
    try {
        const events = vera.experimentalTui.events;
        events.on("conversation_changed", () => {
            warned = false;
            working = false;
        });
        events.on("agent_event", (event) => {
            if (event.type === "status") {
                working = event.state !== "idle";
            } else if (event.type === "user_prompt") {
                working = true;
            } else if (event.type === "turn_finished") {
                working = false;
            }
            check();
        });
        events.on("transcript_changed", check);
    } catch {
        // A client without the experimental TUI events keeps /context and skips the notice.
    }
}
