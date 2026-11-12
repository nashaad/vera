import type { ActiveSession } from "../session/activeSession.ts";
import { tokenCount } from "../session/notices.ts";
import type { ContextState } from "../session/model.ts";
import type { ModelSettings } from "../models/settings.ts";
import { phaseLabel, type UiState } from "../state/connection.ts";

export type DiagnosticSection = "Session" | "Host";

export interface DiagnosticFact {
    readonly section: DiagnosticSection;
    readonly label: string;
    readonly value: string;
}

// The parts of an open session the facts read. A test builds this without a bridge.
export type DiagnosticSession = Pick<ActiveSession, "agentId" | "title" | "folder" | "watch">;

export const NOT_REPORTED = "Not reported yet";
// The window keeps the host's pid and build, not the socket path it connected to.
export const SOCKET_NOT_KEPT = "Not kept by this window";

export function diagnosticFacts(
    session: DiagnosticSession | undefined,
    connection: UiState,
    platform: string,
): readonly DiagnosticFact[] {
    const sessionFacts = session === undefined ? [] : sessionSection(session);
    return [...sessionFacts, ...hostSection(connection, platform)];
}

// One `label: value` line per fact, for the clipboard.
export function diagnosticsText(facts: readonly DiagnosticFact[]): string {
    return facts.map((fact) => `${fact.label}: ${fact.value}`).join("\n");
}

function sessionSection(session: DiagnosticSession): readonly DiagnosticFact[] {
    const watch = session.watch;
    return [
        fact("Session", "Session id", session.agentId),
        fact("Session", "Title", session.title),
        fact("Session", "Folder", session.folder ?? "Not known"),
        fact("Session", "Watch phase", watch.phase),
        fact("Session", "Run status", watch.status),
        fact("Session", "Model", modelText(watch.models?.settings)),
        fact("Session", "Approval mode", watch.approval?.mode ?? NOT_REPORTED),
        fact("Session", "Context", contextText(watch.context)),
        fact("Session", "Queued prompts", String(watch.queue.length)),
        fact("Session", "Open requests", String(watch.requests.length)),
        fact("Session", "Loaded blocks", String(watch.history.length + watch.live.length)),
    ];
}

function hostSection(connection: UiState, platform: string): readonly DiagnosticFact[] {
    const ready = connection.ready;
    return [
        fact("Host", "Connection", phaseLabel(connection)),
        fact("Host", "Host pid", ready === undefined ? "Not running" : String(ready.pid)),
        fact("Host", "Build", ready?.buildId ?? "Unknown"),
        fact("Host", "Protocol version", connection.identity === undefined ? NOT_REPORTED : String(connection.identity.protocol_version)),
        fact("Host", "Home", ready?.home ?? "Not known"),
        fact("Host", "Socket path", SOCKET_NOT_KEPT),
        fact("Host", "Platform", platform === "" ? "Unknown" : platform),
    ];
}

function fact(section: DiagnosticSection, label: string, value: string): DiagnosticFact {
    return { section, label, value };
}

function modelText(settings: ModelSettings | undefined): string {
    if (settings === undefined) return NOT_REPORTED;
    const name = settings.provider === undefined ? settings.model : `${settings.provider} ${settings.model}`;
    return settings.effort === undefined ? name : `${name}, effort ${settings.effort}`;
}

function contextText(context: ContextState | undefined): string {
    if (context === undefined) return NOT_REPORTED;
    const used = context.capacity === undefined
        ? `${tokenCount(context.tokens)} tokens`
        : `${tokenCount(context.tokens)} of ${tokenCount(context.capacity)} tokens`;
    return context.estimated ? `${used} (estimated)` : used;
}
