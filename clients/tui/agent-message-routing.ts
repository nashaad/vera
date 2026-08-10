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

export interface TuiHostedAgentAddressingOptions {
    readonly declared?: TuiHostedAgentAddressing;
    readonly hasSidebar: boolean;
    readonly sidebarMention?: string;
    readonly sidebarAgentId?: string;
    readonly extensionMentions?: readonly string[];
}

/** Names offered by the composer for the currently visible agent surface. */
export function visibleTuiAgentMentions(
    options: TuiHostedAgentAddressingOptions,
): readonly string[] {
    if (!options.hasSidebar || options.sidebarMention === undefined) {
        return options.extensionMentions ?? [];
    }
    if (options.declared !== undefined) {
        return [
            options.declared.primary,
            options.declared.secondary,
            ...(options.declared.broadcast === undefined
                ? []
                : [options.declared.broadcast]),
        ];
    }
    return (options.extensionMentions?.length ?? 0) > 0
        ? options.extensionMentions!
        : [options.sidebarMention, "all", "vera"];
}

/** Effective aliases used to route messages over the visible agent surface. */
export function resolveTuiHostedAgentAddressing(
    options: TuiHostedAgentAddressingOptions,
): TuiHostedAgentAddressing {
    return options.declared ?? {
        primary: "vera",
        secondary: options.sidebarMention
            ?? options.sidebarAgentId
            ?? "agent",
        broadcast: "all",
    };
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
