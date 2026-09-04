/** Which providers a cold install is shown first, and why. The reasons are data on the provider, so adding one is a config edit. */

import { arch, platform, totalmem } from "node:os";

import type { ProviderRequirement } from "./definitions.ts";
import type { ProviderDescriptor } from "./registry.ts";

/** What the machine is, in the three facts a requirement can ask about. */
export interface MachineFacts {
    readonly os: string;
    readonly arch: string;
    readonly memoryGb: number;
}

const BYTES_PER_GB = 1024 ** 3;

export function machineFacts(): MachineFacts {
    return {
        os: platform(),
        arch: arch(),
        memoryGb: Math.round(totalmem() / BYTES_PER_GB),
    };
}

export function meetsRequirement(
    requires: ProviderRequirement | undefined,
    facts: MachineFacts,
): boolean {
    if (requires === undefined) return true;
    if (requires.os !== undefined && requires.os !== facts.os) return false;
    if (requires.arch !== undefined && requires.arch !== facts.arch) {
        return false;
    }
    return requires.memory_gb === undefined
        || facts.memoryGb >= requires.memory_gb;
}

export interface RecommendedProvider {
    readonly provider: ProviderDescriptor;
    readonly reason: string;
}

/**
 * The recommended providers, best first. A provider whose requirement this
 * machine does not meet is not recommended here; it stays in the full list,
 * because a recommendation is an offer and not a filter.
 */
export function recommendedProviders(
    providers: readonly ProviderDescriptor[],
    facts: MachineFacts = machineFacts(),
): readonly RecommendedProvider[] {
    return providers
        .filter((provider) =>
            provider.recommend !== undefined
            && meetsRequirement(provider.recommend.requires, facts)
        )
        .sort((left, right) =>
            (left.recommend?.rank ?? 0) - (right.recommend?.rank ?? 0)
        )
        .map((provider) => ({
            provider,
            reason: provider.recommend?.reason ?? "",
        }));
}

/**
 * The memory the work model asks for, which is the line between a machine that
 * can do real work on this provider and one that can only get started. The
 * number lives on the definition, so a screen that draws the line reads it here
 * rather than holding its own copy.
 */
export function workModelMemoryGb(
    provider: ProviderDescriptor,
): number | undefined {
    return provider.recommendModels?.find((entry) => entry.role === "work")
        ?.requires?.memory_gb;
}
