import { expect, test } from "bun:test";

import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    VERA_PRODUCT_VERSION,
    parseReleaseManifest,
    serializeReleaseManifest,
    type ReleaseManifest,
} from "../../src/release/manifest.ts";

function sample(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
    return {
        layout_version: RELEASE_LAYOUT_VERSION,
        product_version: VERA_PRODUCT_VERSION,
        source_revision: "abc1234def",
        build_id: "vera-abc1234",
        protocol_version: 1,
        platform: "darwin",
        arch: "arm64",
        asset_digest: "sha256:deadbeef",
        built_at: "2026-08-31T12:00:00.000Z",
        artifacts: [...RELEASE_ARTIFACT_NAMES],
        ...overrides,
    };
}

test("manifest round-trips and lists annex as an artifact", () => {
    const text = serializeReleaseManifest(sample());
    const parsed = parseReleaseManifest(text);
    expect(parsed.artifacts).toContain("annex");
    expect(parsed.artifacts).toContain("host");
    expect(parsed.artifacts).toContain("worker");
    expect(parsed.artifacts).toContain("annex_assets");
    expect(parsed.artifacts).toContain("cli");
    expect(parsed.artifacts).toContain("tui");
    expect(parsed.artifacts).toContain("builtins");
    expect(parsed.layout_version).toBe(RELEASE_LAYOUT_VERSION);
    expect(text).toContain(`"protocol_version": 1`);
    expect(text).not.toMatch(/"protocol_version": 34/);
});

test("manifest parse refuses a missing annex artifact", () => {
    const text = serializeReleaseManifest(sample({
        artifacts: ["cli", "host", "worker"],
    }));
    expect(() => parseReleaseManifest(text)).toThrow(/must include annex/);
});

test("manifest parse refuses a hardcoded-looking digest without sha256", () => {
    const text = serializeReleaseManifest(sample()).replace(
        "sha256:deadbeef",
        "deadbeef",
    );
    expect(() => parseReleaseManifest(text)).toThrow(/sha256/);
});
