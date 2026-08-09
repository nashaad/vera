import type { TuiAgentPane } from "./agent-attachments.ts";

export interface TuiVisibleAgent {
    readonly agentId: string;
    readonly pane: TuiAgentPane;
    /** Composer address without the leading `@`. */
    readonly mention: string;
}

export type TuiAgentMessageRoute =
    | {
        readonly kind: "message";
        readonly text: string;
        readonly targets: readonly TuiVisibleAgent[];
    }
    | { readonly kind: "focus"; readonly pane: TuiAgentPane }
    | { readonly kind: "unknown"; readonly mention: string };

/** Resolve one submitted message against only the two agents on screen. */
export function routeTuiAgentMessage(
    text: string,
    focusedPane: TuiAgentPane,
    visible: readonly TuiVisibleAgent[],
): TuiAgentMessageRoute {
    const addressed = /^@(\S+)(?:\s+([\s\S]+))?$/.exec(text.trim());
    if (addressed === null) {
        return {
            kind: "message",
            text,
            targets: visible.filter((agent) => agent.pane === focusedPane),
        };
    }

    const mention = addressed[1]!;
    const body = addressed[2];
    if (mention === "all") {
        return body === undefined
            ? { kind: "unknown", mention }
            : { kind: "message", text: body, targets: [...visible] };
    }

    const target = visible.find((agent) => agent.mention === mention);
    if (target === undefined) {
        return { kind: "unknown", mention };
    }
    return body === undefined
        ? { kind: "focus", pane: target.pane }
        : { kind: "message", text: body, targets: [target] };
}
