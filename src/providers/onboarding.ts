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
function holdsCredential(
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
