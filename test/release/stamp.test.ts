import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    VERA_PRODUCT_VERSION,
    serializeReleaseManifest,
} from "../../src/release/manifest.ts";
import {
    formatVeraVersion,
    readStampedRelease,
} from "../../src/release/stamp.ts";

function stampDir(): string {
    return mkdtempSync(join(tmpdir(), "vera-stamp-"));
}

function writeStamp(directory: string, buildId = "vera-abc1234"): void {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "manifest.json"), serializeReleaseManifest({
        layout_version: RELEASE_LAYOUT_VERSION,
        product_version: VERA_PRODUCT_VERSION,
        source_revision: "abc1234def",
        build_id: buildId,
        protocol_version: 1,
        platform: "darwin",
        arch: "arm64",
        asset_digest: `sha256:${"ab".repeat(32)}`,
        built_at: "2026-08-31T12:00:00.000Z",
        artifacts: [...RELEASE_ARTIFACT_NAMES],
    }));
}

test("the stamp is the packed manifest and nothing else", () => {
    const directory = stampDir();
    try {
        writeStamp(directory);
        const stamp = readStampedRelease(directory);
        expect(stamp.build_id).toBe("vera-abc1234");
        expect(stamp.product_version).toBe(VERA_PRODUCT_VERSION);
        expect(formatVeraVersion(stamp)).toBe(
            `vera ${VERA_PRODUCT_VERSION} (vera-abc1234)`,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a missing stamp fails loudly and names the path", () => {
    const directory = stampDir();
    try {
        expect(() => readStampedRelease(directory)).toThrow(
            /No release stamp at .*manifest\.json/,
        );
        expect(() => readStampedRelease(directory)).toThrow(/pack:release/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
