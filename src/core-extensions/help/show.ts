import type { VeraSessionShowOutcome } from "../../sdk/extensions.ts";
import { SHOW_TARGETS, type ShowTarget } from "../../help/show-targets.ts";

export function listShowTargets(): string {
    return SHOW_TARGETS.map((target) => `${target.id} (${target.label})`).join(", ");
}

// The counts are clients that opened it, and terminals that have no such screen.
export function describeShowOutcome(target: ShowTarget, outcome: VeraSessionShowOutcome): string {
    const where = [
        ...(outcome.window > 0 ? ["the window"] : []),
        ...(outcome.terminal > 0 ? ["the terminal"] : []),
    ].join(" and ");
    if (where.length === 0) {
        return outcome.terminalCannot > 0
            ? `The terminal cannot show ${target.label}.`
            : "No window or terminal is attached to this chat.";
    }
    return outcome.terminalCannot > 0
        ? `Opened ${target.label} in ${where}. The terminal cannot show it.`
        : `Opened ${target.label} in ${where}.`;
}
