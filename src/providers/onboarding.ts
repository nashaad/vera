/** The gates a cold install clears, in order: a provider, a credential, a model that answered. Clients draw this decision; they do not re-derive it. */

import type { VeraConfig } from "../config.ts";
import {
    isCuratedPoolEntry,
    isVerifiedPoolEntry,
    providerOf,
    type PoolFile,
} from "../model/pool-file.ts";
import { isSelectable } from "../model/pool-policy.ts";
import type { AuthStorage } from "./auth-storage.ts";
import type { ProviderDescriptor } from "./registry.ts";

/** Which gate is still open. `ready` means a model has answered and no onboarding surface belongs anywhere. */
export type OnboardingGate = "provider" | "key" | "model" | "ready";

/** What a provider has done, in the three words a row can show without color. */
export type ProviderAnswerState = "connected" | "key stored" | "not answering";

export interface OnboardingInput {
    readonly providers: readonly ProviderDescriptor[];
    readonly pool: PoolFile;
    readonly config?: Pick<VeraConfig, "provider">;
    readonly authStorage?: Pick<AuthStorage, "getCredential">;
    readonly env?: Readonly<Record<string, string | undefined>>;
}

/** A provider has answered when one of its selectable models passed a probe. The pool file already records it, so this needs no store of its own. */
export function hasProviderAnswered(
    providerId: string,
    pool: PoolFile,
): boolean {
    return Object.entries(pool.models).some(([id, entry]) =>
        providerOf(id) === providerId
        && isCuratedPoolEntry(entry)
        && isSelectable(id, pool)
        && isVerifiedPoolEntry(entry)
    );
}

function needsCredential(provider: ProviderDescriptor): boolean {
    return provider.credential === "api_key" || provider.credential === "oauth";
}

/** A stored key is a key Vera holds. A provider that needs none holds none, so it never reads `key stored`. */
export function holdsCredential(
    provider: ProviderDescriptor,
    input: OnboardingInput,
): boolean {
    if (provider.credential === "none") {
        // OLLAMA_HOST is an address, not a key.
        return false;
    }
    if (input.authStorage?.getCredential(provider.id) !== undefined) {
        return true;
    }
    const env = input.env ?? process.env;
    return provider.envVar !== undefined && Boolean(env[provider.envVar]);
}

export function providerAnswerState(
    provider: ProviderDescriptor,
    input: OnboardingInput,
): ProviderAnswerState {
    if (hasProviderAnswered(provider.id, input.pool)) {
        return "connected";
    }
    return holdsCredential(provider, input) ? "key stored" : "not answering";
}

/** The word a provider row shows, or nothing at all. A provider that could hold a key and holds none has been left alone, and silence says that better than a verdict. */
export function providerAnswerLabel(
    provider: ProviderDescriptor,
    input: OnboardingInput,
): ProviderAnswerState | undefined {
    const state = providerAnswerState(provider, input);
    return state === "not answering" && provider.credential !== "none"
        ? undefined
        : state;
}

export function openGate(input: OnboardingInput): OnboardingGate {
    if (
        input.providers.some((provider) =>
            hasProviderAnswered(provider.id, input.pool)
        )
    ) {
        return "ready";
    }
    const chosen = input.providers.find((provider) =>
        provider.id === input.config?.provider
    );
    if (
        chosen !== undefined
        && (!needsCredential(chosen) || holdsCredential(chosen, input))
    ) {
        return "model";
    }
    // The config names a provider that still needs a key. A credential
    // somewhere else means the user has chosen before, so the open gate is
    // that key rather than the choice above it.
    return input.providers.some((provider) => holdsCredential(provider, input))
        ? "key"
        : "provider";
}

/** The three steps, named for the gates they clear. */
export type OnboardingStepId = "provider" | "key" | "model";

/** `done` steps stay reachable, `locked` steps are skipped by the tab key. */
export type OnboardingStepState = "done" | "current" | "locked";

export interface OnboardingStep {
    readonly id: OnboardingStepId;
    readonly label: string;
    readonly state: OnboardingStepState;
}

export interface StepperInput extends OnboardingInput {
    /** The provider chosen on the first step, which is not yet the configured one. */
    readonly chosen?: string;
    /** The step the client has open. It wins over what the stored facts imply, because that is the one the user is looking at. */
    readonly at?: OnboardingStepId;
}

const STEP_LABELS: Record<OnboardingStepId, string> = {
    provider: "Provider",
    key: "Key",
    model: "Model",
};

function chosenProvider(input: StepperInput): ProviderDescriptor | undefined {
    return input.providers.find((provider) => provider.id === input.chosen);
}

/** A step a provider makes irrelevant reads done, not hidden, so the user sees the gate existed and was already clear. */
function keyStepState(input: StepperInput): OnboardingStepState {
    const provider = chosenProvider(input);
    if (provider === undefined) return "locked";
    return !needsCredential(provider) || holdsCredential(provider, input)
        ? "done"
        : "current";
}

const STEP_ORDER = ["provider", "key", "model"] as const;

/**
 * A stored key says the key gate is clear, but a user staring at the key card
 * is on step two whatever the store says. The open step wins, everything
 * before it is behind them, and a later step cannot also be current.
 */
function withOpenStep(
    steps: readonly OnboardingStep[],
    at: OnboardingStepId | undefined,
): readonly OnboardingStep[] {
    if (at === undefined) return steps;
    const open = STEP_ORDER.indexOf(at);
    return steps.map((step, index) => {
        if (index === open) return { ...step, state: "current" };
        if (index < open) return { ...step, state: "done" };
        return step.state === "current" ? { ...step, state: "locked" } : step;
    });
}

export function stepperSteps(input: StepperInput): readonly OnboardingStep[] {
    const provider = chosenProvider(input);
    const key = keyStepState(input);
    const model: OnboardingStepState = key !== "done"
        ? "locked"
        : provider !== undefined && hasProviderAnswered(provider.id, input.pool)
        ? "done"
        : "current";
    const states: Record<OnboardingStepId, OnboardingStepState> = {
        provider: provider === undefined ? "current" : "done",
        key: provider === undefined ? "locked" : key,
        model,
    };
    return withOpenStep(
        STEP_ORDER.map((id) => ({
            id,
            label: STEP_LABELS[id],
            state: states[id],
        })),
        input.at,
    );
}

/** The step the stepper opens on. Undefined once every gate is clear, which is when the flow closes. */
export function currentStep(input: StepperInput): OnboardingStepId | undefined {
    return stepperSteps(input).find((step) => step.state === "current")?.id;
}

/** What a `pool_add` verdict says, narrowed to what the gates care about. */
export interface AdmissionOutcome {
    readonly verdict: string;
    readonly reason?: string;
    readonly statusCode?: number;
}

/** The sentence inside a provider's error envelope. A card has one line for this, and a serialised body spends it on punctuation. */
export function providerMessage(reason: string): string {
    const start = reason.indexOf("{");
    if (start === -1) {
        return reason;
    }
    try {
        const body: unknown = JSON.parse(reason.slice(start));
        const message = (body as { error?: { message?: unknown } }).error
            ?.message ?? (body as { message?: unknown }).message;
        return typeof message === "string" ? message : reason;
    } catch {
        return reason;
    }
}

/**
 * The provider's own words when it turned the key down, or undefined when the
 * failure was not about the credential. A refusal sends the user one gate back;
 * anything else is about the model, and the model step keeps the user.
 */
export function credentialRefusal(
    outcome: AdmissionOutcome,
): string | undefined {
    if (outcome.statusCode !== 401 && outcome.statusCode !== 403) {
        return undefined;
    }
    return providerMessage(outcome.reason ?? "no reason given");
}
