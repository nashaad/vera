import { parseModelSettings } from "../models/settings.ts";
import type { ExtensionFailure, ExtensionFailuresResult, HostModelsResult } from "../protocol/bridge.ts";
import { deviceDetail, deviceHealth, sessionCountLabel } from "../pages/devices.ts";
import type { UiState } from "../state/connection.ts";

export const EXTENSION_FAILURE_LIMIT = 100;
export const NO_BRIDGE_REASON = "This window has no host bridge.";
export const HOST_SILENT_REASON = "The host did not answer.";
const UNLISTED_MODELS_REASON = "The host did not list its models.";

export interface ExtensionsLoaded {
    readonly kind: "loaded";
}

export interface ExtensionsFailed {
    readonly kind: "failed";
    // Capped at EXTENSION_FAILURE_LIMIT; `total` is the whole count.
    readonly shown: readonly ExtensionFailure[];
    readonly total: number;
}

export interface ExtensionsUnreadable {
    readonly kind: "unreadable";
    readonly reason: string;
}

export type ExtensionOutcome = ExtensionsLoaded | ExtensionsFailed | ExtensionsUnreadable;

export interface ProvidersAnswered {
    readonly kind: "answered";
    readonly connected: number;
}

export interface ProvidersUnreadable {
    readonly kind: "unreadable";
    readonly reason: string;
}

export type ProviderOutcome = ProvidersAnswered | ProvidersUnreadable;

export type CheckResult = "ok" | "warn" | "fail";
export type CheckState = CheckResult | "pending";
export type CheckId = "host" | "protocol" | "sessions" | "extensions" | "providers";

export interface DoctorCheck {
    readonly id: CheckId;
    readonly label: string;
    readonly result: CheckState;
    readonly detail: string;
}

export interface DoctorInputs {
    readonly connection: UiState;
    // Undefined while the host is still being asked.
    readonly extensions: ExtensionOutcome | undefined;
    readonly providers: ProviderOutcome | undefined;
}

export function extensionOutcome(result: ExtensionFailuresResult): ExtensionOutcome {
    if (!result.ok) return { kind: "unreadable", reason: result.reason };
    if (result.failures.length === 0) return { kind: "loaded" };
    return {
        kind: "failed",
        shown: result.failures.slice(0, EXTENSION_FAILURE_LIMIT),
        total: result.failures.length,
    };
}

// The host's own answer lists its connected providers; a reply that parses but has none is an answer, not a failure.
export function providerOutcome(result: HostModelsResult): ProviderOutcome {
    if (!result.ok) return { kind: "unreadable", reason: result.reason };
    const settings = parseModelSettings(result.settings);
    if (settings === undefined) return { kind: "unreadable", reason: UNLISTED_MODELS_REASON };
    return { kind: "answered", connected: settings.providers?.length ?? 0 };
}

export function doctorChecks(inputs: DoctorInputs): readonly DoctorCheck[] {
    return [
        hostCheck(inputs.connection),
        protocolCheck(inputs.connection),
        sessionsCheck(inputs.connection),
        extensionsCheck(inputs.extensions),
        providersCheck(inputs.providers),
    ];
}

export function doctorSummary(checks: readonly DoctorCheck[]): string {
    if (checks.some((check) => check.result === "pending")) return "Checking…";
    const attention = checks.filter((check) => check.result !== "ok").length;
    if (attention === 0) return "Everything checks out.";
    return attention === 1 ? "1 check wants attention." : `${attention} checks want attention.`;
}

function hostCheck(connection: UiState): DoctorCheck {
    return { id: "host", label: "Host connection", result: deviceHealth(connection), detail: deviceDetail(connection) };
}

function protocolCheck(connection: UiState): DoctorCheck {
    const identity = connection.identity;
    if (identity !== undefined) {
        return { id: "protocol", label: "Protocol", result: "ok", detail: `The host reports protocol v${identity.protocol_version}.` };
    }
    const starting = connection.phase === "starting" || connection.phase === "waiting";
    return {
        id: "protocol",
        label: "Protocol",
        result: starting ? "warn" : "fail",
        detail: starting ? "Waiting for the host to report its protocol version." : "The host is not connected, so it reported no protocol version.",
    };
}

function sessionsCheck(connection: UiState): DoctorCheck {
    if (connection.sessions !== undefined) {
        return { id: "sessions", label: "Session list", result: "ok", detail: `${sessionCountLabel(connection.sessions)} listed by the host.` };
    }
    const attached = connection.phase === "attached";
    return {
        id: "sessions",
        label: "Session list",
        result: attached ? "warn" : "fail",
        detail: attached ? "The host has not listed its sessions yet." : "No session list, because the host is not connected.",
    };
}

function extensionsCheck(outcome: ExtensionOutcome | undefined): DoctorCheck {
    if (outcome === undefined) return { id: "extensions", label: "Extensions", result: "pending", detail: "Reading extensions…" };
    if (outcome.kind === "loaded") return { id: "extensions", label: "Extensions", result: "ok", detail: "Every configured extension loaded." };
    if (outcome.kind === "failed") {
        const count = outcome.total === 1 ? "1 extension did not load." : `${outcome.total} extensions did not load.`;
        return { id: "extensions", label: "Extensions", result: "warn", detail: `${count} Open Extensions for the reasons.` };
    }
    return { id: "extensions", label: "Extensions", result: "fail", detail: outcome.reason };
}

function providersCheck(outcome: ProviderOutcome | undefined): DoctorCheck {
    if (outcome === undefined) return { id: "providers", label: "Providers", result: "pending", detail: "Reading providers…" };
    if (outcome.kind === "unreadable") return { id: "providers", label: "Providers", result: "fail", detail: outcome.reason };
    if (outcome.connected === 0) {
        return {
            id: "providers",
            label: "Providers",
            result: "warn",
            detail: "No provider is connected. Run vera in a terminal and use /provider to connect one.",
        };
    }
    const count = outcome.connected === 1 ? "1 provider is connected." : `${outcome.connected} providers are connected.`;
    return { id: "providers", label: "Providers", result: "ok", detail: count };
}
