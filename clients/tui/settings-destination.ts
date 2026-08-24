import {
    parseSettingsDestination,
    type SettingsDestination,
} from "../../src/engine/settings-destination.ts";
import type { ModelAssignmentId } from "../../src/config/model-assignments.ts";

export interface TuiSettingsMenuRoute {
    readonly type: "settings_menu";
}

export interface TuiModelPickerRoute {
    readonly type: "model_picker";
}

export interface TuiReasoningPickerRoute {
    readonly type: "reasoning_picker";
}

export interface TuiPermissionModePickerRoute {
    readonly type: "permission_mode_picker";
    readonly mode?: string;
}

export interface TuiAgentPickerRoute {
    readonly type: "agent_picker";
    readonly name?: string;
}

export interface TuiProviderPickerRoute {
    readonly type: "provider_picker";
    readonly provider?: string;
}

export interface TuiModelShortlistRoute {
    readonly type: "model_shortlist";
}

export interface TuiModelAssignmentsRoute {
    readonly type: "model_assignments";
}

export interface TuiModelAssignmentRoute {
    readonly type: "model_assignment";
    readonly assignment: ModelAssignmentId;
}

export type TuiSettingsRoute =
    | TuiSettingsMenuRoute
    | TuiModelPickerRoute
    | TuiReasoningPickerRoute
    | TuiPermissionModePickerRoute
    | TuiAgentPickerRoute
    | TuiProviderPickerRoute
    | TuiModelShortlistRoute
    | TuiModelAssignmentsRoute
    | TuiModelAssignmentRoute;

export interface ResolvedTuiSettingsDestination {
    readonly status: "resolved";
    readonly destination: SettingsDestination;
    readonly route: TuiSettingsRoute;
}

export interface UnsupportedTuiSettingsDestination {
    readonly status: "unsupported";
}

export type TuiSettingsDestinationResolution =
    | ResolvedTuiSettingsDestination
    | UnsupportedTuiSettingsDestination;

export interface TuiSettingsDestinationFacts {
    readonly permissionModes?: readonly string[];
}

/** Client-local rendering of a semantic settings destination. */
export function resolveTuiSettingsDestination(
    value: unknown,
    facts: TuiSettingsDestinationFacts = {},
): TuiSettingsDestinationResolution {
    const destination = parseSettingsDestination(value);
    if (destination === undefined) return { status: "unsupported" };
    if (destination.kind === "settings") {
        return resolved(destination, { type: "settings_menu" });
    }
    if (destination.kind === "model") {
        return resolved(destination, { type: "model_picker" });
    }
    if (destination.kind === "reasoning") {
        return resolved(destination, { type: "reasoning_picker" });
    }
    if (destination.kind === "permission_mode") {
        if (
            destination.mode !== undefined
            && facts.permissionModes?.includes(destination.mode) !== true
        ) {
            return { status: "unsupported" };
        }
        return resolved(destination, {
            type: "permission_mode_picker",
            ...(destination.mode === undefined ? {} : { mode: destination.mode }),
        });
    }
    if (destination.kind === "agent") {
        return resolved(destination, {
            type: "agent_picker",
            ...(destination.name === undefined ? {} : { name: destination.name }),
        });
    }
    if (destination.kind === "provider") {
        return resolved(destination, {
            type: "provider_picker",
            ...(destination.provider === undefined
                ? {}
                : { provider: destination.provider }),
        });
    }
    if (destination.kind === "model_shortlist") {
        return resolved(destination, { type: "model_shortlist" });
    }
    if (destination.kind === "model_assignments") {
        return resolved(destination, { type: "model_assignments" });
    }
    return resolved(destination, {
        type: "model_assignment",
        assignment: destination.assignment,
    });
}

function resolved(
    destination: SettingsDestination,
    route: TuiSettingsRoute,
): ResolvedTuiSettingsDestination {
    return { status: "resolved", destination, route };
}
