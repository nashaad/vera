import type { ModelRef } from "./catalog.ts";
import type { ModelChoice, ModelSettings } from "./settings.ts";

// What a model control needs, the same for a running session and for New Chat.
export interface ModelControls {
    // Undefined until the host has answered.
    readonly settings: ModelSettings | undefined;
    // The model and effort the session runs, or the one New Chat will start with.
    readonly choice: ModelChoice | undefined;
    readonly enabled: boolean;
    // A short line under the pill, such as a refusal or a change waiting for the turn to end.
    readonly note?: string;
    // Where Probe and shortlist changes apply; undefined means the home.
    readonly workspace?: string;
    readonly actions: ModelActions;
}

export interface ModelActions {
    readonly pick: (choice: ModelChoice) => void;
    // `null` returns to the model's own default effort.
    readonly setEffort: (effort: string | null) => void;
    // Resolve to a reason when the host refused.
    readonly shortlist: (model: ModelRef & { readonly provider: string }, on: boolean) => Promise<string | undefined>;
    readonly probe: (model: ModelRef & { readonly provider: string }) => Promise<ProbeOutcome>;
}

export interface ProbePassed {
    readonly ok: true;
}

export interface ProbeFailed {
    readonly ok: false;
    readonly reason: string;
}

export type ProbeOutcome = ProbePassed | ProbeFailed;
