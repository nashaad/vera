import { expect, test } from "bun:test";
import { join, sep } from "node:path";

import {
    packedAnnexRoot,
    packedReleaseRoot,
    releaseManifestPath,
} from "../../src/release/layout.ts";

test("release layout names annex assets and the manifest", () => {
    const root = packedReleaseRoot();
    expect(root.split(sep).slice(-2).join(sep)).toBe(join("dist", "release"));
    expect(packedAnnexRoot(root)).toBe(join(root, "annex"));
    expect(releaseManifestPath(root)).toBe(join(root, "manifest.json"));
    expect(packedAnnexRoot(root).split(sep)).not.toContain("web");
    expect(packedAnnexRoot(root).split(sep)).not.toContain("clients");
});
