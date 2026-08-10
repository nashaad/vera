import type { TuiAgentPane } from "./agent-attachments.ts";

export interface TuiVisibleAgent {
    readonly agentId: string;
    readonly pane: TuiAgentPane;
    /** Compatibility address from the legacy TUI path. */
    readonly mention?: string;
}

/** Experimental plain-data aliases for the two visible participants. */
export interface TuiHostedAgentAddressing {
    readonly primary: string;
    readonly secondary: string;
    readonly broadcast?: string;
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
    addressing?: TuiHostedAgentAddressing,
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
    const configured = addressing ?? legacyAddressing(visible);
    if (configured.broadcast === mention) {
        return body === undefined
            ? { kind: "unknown", mention }
            : { kind: "message", text: body, targets: [...visible] };
    }

    const targetPane = mention === configured.primary
        ? "main"
        : mention === configured.secondary ? "sidebar" : undefined;
    const target = targetPane === undefined
        ? addressing === undefined
            ? visible.find((agent) => agent.mention === mention)
            : undefined
        : visible.find((agent) => agent.pane === targetPane);
    if (target === undefined) {
        return { kind: "unknown", mention };
    }
    return body === undefined
        ? { kind: "focus", pane: target.pane }
        : { kind: "message", text: body, targets: [target] };
}

/** Explicit compatibility for extensions that predate declarations. */
function legacyAddressing(
    visible: readonly TuiVisibleAgent[],
): TuiHostedAgentAddressing {
    return {
        primary: visible.find((agent) => agent.pane === "main")?.mention ?? "vera",
        secondary: visible.find((agent) => agent.pane === "sidebar")?.mention
            ?? "agent",
        broadcast: "all",
    };
}
