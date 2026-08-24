import {
    isModelSlotId,
    type ModelAssignmentId,
} from "../config/model-assignments.ts";

export interface SettingsRootDestination {
    readonly kind: "settings";
}

export interface ModelSettingsDestination {
    readonly kind: "model";
}

export interface ReasoningSettingsDestination {
    readonly kind: "reasoning";
}

export interface PermissionModeSettingsDestination {
    readonly kind: "permission_mode";
    readonly mode?: string;
}

export interface AgentSettingsDestination {
    readonly kind: "agent";
    readonly name?: string;
}

export interface ProviderSettingsDestination {
    readonly kind: "provider";
    readonly provider?: string;
}

export interface ModelShortlistSettingsDestination {
    readonly kind: "model_shortlist";
}

export interface ModelAssignmentsSettingsDestination {
    readonly kind: "model_assignments";
}

export interface ModelAssignmentSettingsDestination {
    readonly kind: "model_assignment";
    readonly assignment: ModelAssignmentId;
}

/**
 * A human-owned setting, independent of how any client presents it.
 *
 * Keep this vocabulary about decisions and resources. A tab, row, dialog,
 * focus target, or key belongs to the client and must never be added here.
 */
export type SettingsDestination =
    | SettingsRootDestination
    | ModelSettingsDestination
    | ReasoningSettingsDestination
    | PermissionModeSettingsDestination
    | AgentSettingsDestination
    | ProviderSettingsDestination
    | ModelShortlistSettingsDestination
    | ModelAssignmentsSettingsDestination
    | ModelAssignmentSettingsDestination;

const POSITIONAL_KEYS = new Set([
    "component",
    "dialog",
    "focus",
    "modal",
    "row",
    "tab",
]);

/**
 * Parse a destination at a client boundary. Unknown settings and presentation
 * coordinates are rejected instead of being guessed into a nearby surface.
 */
export function parseSettingsDestination(
    value: unknown,
): SettingsDestination | undefined {
    if (!isRecord(value) || hasPositionalKey(value)) return undefined;
    const kind = value.kind;
    if (kind === "settings" || kind === "model" || kind === "reasoning"
        || kind === "model_shortlist" || kind === "model_assignments") {
        return hasOnlyKeys(value, ["kind"])
            ? { kind }
            : undefined;
    }
    if (kind === "permission_mode") {
        const mode = optionalName(value.mode);
        if (!hasOnlyKeys(value, ["kind", "mode"]) || mode === null) {
            return undefined;
        }
        return mode === undefined ? { kind } : { kind, mode };
    }
    if (kind === "agent") {
        const name = optionalName(value.name);
        if (!hasOnlyKeys(value, ["kind", "name"]) || name === null) {
            return undefined;
        }
        return name === undefined ? { kind } : { kind, name };
    }
    if (kind === "provider") {
        const provider = optionalName(value.provider);
        if (!hasOnlyKeys(value, ["kind", "provider"]) || provider === null) {
            return undefined;
        }
        return provider === undefined ? { kind } : { kind, provider };
    }
    if (kind === "model_assignment") {
        if (
            !hasOnlyKeys(value, ["kind", "assignment"])
            || !isModelSlotId(value.assignment)
        ) {
            return undefined;
        }
        return { kind, assignment: value.assignment };
    }
    return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
): boolean {
    const allowed = new Set(keys);
    return Object.keys(value).every((key) => allowed.has(key));
}

function hasPositionalKey(value: Record<string, unknown>): boolean {
    return Object.keys(value).some((key) => POSITIONAL_KEYS.has(key));
}

/** Undefined means omitted; null means malformed. */
function optionalName(value: unknown): string | undefined | null {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) return null;
    return value.trim();
}
