import { expect, test } from "bun:test";

import { configuredProviders } from "../../src/providers/registry.ts";
import type { ProviderDescriptor } from "../../src/providers/registry.ts";
import {
    meetsRequirement,
    recommendedProviders,
} from "../../src/providers/recommendation.ts";

const MAC: { os: string; arch: string; memoryGb: number } = {
    os: "darwin",
    arch: "arm64",
    memoryGb: 64,
};

function provider(
    id: string,
    recommend?: ProviderDescriptor["recommend"],
): ProviderDescriptor {
    return {
        id: id as ProviderDescriptor["id"],
        label: id,
        shortLabel: id,
        access: "api_key",
        credential: "api_key",
        ...(recommend === undefined ? {} : { recommend }),
    };
}

test("openrouter ships as the first recommendation", () => {
    const recommended = recommendedProviders(configuredProviders(undefined), MAC);
    expect(recommended[0]?.provider.id).toBe("openrouter");
    expect(recommended[0]?.reason).toBe("one key, most models, pay as you go");
});

test("rank orders the recommendations", () => {
    const recommended = recommendedProviders([
        provider("second", { rank: 2, reason: "b" }),
        provider("first", { rank: 1, reason: "a" }),
        provider("plain"),
    ], MAC);
    expect(recommended.map((entry) => entry.provider.id)).toEqual([
        "first",
        "second",
    ]);
});

test("a machine short of the requirement is not offered the provider", () => {
    const outrider = provider("outrider", {
        rank: 1,
        reason: "runs here",
        requires: { os: "darwin", arch: "arm64", memory_gb: 32 },
    });
    expect(recommendedProviders([outrider], MAC)).toHaveLength(1);
    expect(recommendedProviders([outrider], { ...MAC, memoryGb: 16 }))
        .toHaveLength(0);
    expect(recommendedProviders([outrider], { ...MAC, arch: "x64" }))
        .toHaveLength(0);
    expect(recommendedProviders([outrider], { ...MAC, os: "linux" }))
        .toHaveLength(0);
});

test("no requirement is met by any machine", () => {
    expect(meetsRequirement(undefined, { os: "linux", arch: "x64", memoryGb: 4 }))
        .toBe(true);
});
