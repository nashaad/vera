import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostLockRecord } from "../../src/host/lockfile.ts";
import type { StopWhenIdleOptions } from "../../src/host/force-stop.ts";
import { installRelease } from "../../src/release/install.ts";
import type { ReleaseManifest } from "../../src/release/manifest.ts";

function options(prefix: string, stops: StopWhenIdleOptions[], alive: boolean) {
    return {
        prefix,
        pack: async () => ({ releaseRoot: join(prefix, "nowhere"), manifest: { build_id: "vera-new" } as ReleaseManifest }),
        verify: () => {},
        readLiveHost: async () => ({ pid: 4242, build_id: "vera-old" } as HostLockRecord),
        stopHost: async (stop: StopWhenIdleOptions) => { stops.push(stop); return { pid: 4242, endedBy: "stopped" as const }; },
        isAlive: () => alive,
        report: () => {},
    };
}

test("an update stops the idle host without a target build instead of handing off", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-cold-"));
    try {
        const stops: StopWhenIdleOptions[] = [];
        let handedOff = false;
        const outcome = await installRelease({
            ...options(prefix, stops, true),
            handOff: async () => { handedOff = true; return { kind: "accepted", buildId: "vera-new" }; },
        });
        expect(stops).toHaveLength(1);
        expect(stops[0]!.targetBuildId).toBeUndefined();
        expect(handedOff).toBe(false);
        expect(outcome.kind).toBe("not_moved");
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("the hot hand-off is still available when asked for", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-cold-"));
    try {
        const stops: StopWhenIdleOptions[] = [];
        const outcome = await installRelease({
            ...options(prefix, stops, true),
            hotHandOff: true,
            handOff: async () => ({ kind: "accepted", buildId: "vera-new" }),
        });
        expect(stops).toEqual([]);
        expect(outcome.kind).toBe("accepted");
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});
