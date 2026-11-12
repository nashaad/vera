import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { childReleaseRoot, RELEASE_SUPERVISOR_NAME } from "../../src/release/layout.ts";
import {
    residentSupervisorEntrypoint,
    residentSupervisorSpawnCommand,
} from "../../src/host/worker-supervisor-handle.ts";
import {
    residentWorkerEntrypoint,
    residentWorkerSpawnCommand,
} from "../../src/host/worker/handle.ts";

async function withInstalledRelease(
    body: (installed: string, releaseRoot: () => string | undefined) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "vera-spawn-fallback-"));
    const previousHome = process.env.HOME;
    const previousDev = process.env.VERA_DEV_INSTANCE;
    try {
        const installed = join(root, ".local", "share", "vera", "current");
        await mkdir(installed, { recursive: true });
        await writeFile(join(installed, "manifest.json"), "{}\n");
        await writeFile(join(installed, "worker"), "#!/bin/sh\n");
        await writeFile(join(installed, RELEASE_SUPERVISOR_NAME), "#!/bin/sh\n");
        process.env.HOME = root;
        process.env.VERA_DEV_INSTANCE = "ovu30 vera-test";
        // A checkout with no pack, so the installed release is the only packed one.
        await body(installed, () => childReleaseRoot(undefined, undefined, root));
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousDev === undefined) delete process.env.VERA_DEV_INSTANCE;
        else process.env.VERA_DEV_INSTANCE = previousDev;
        await rm(root, { recursive: true, force: true });
    }
}

test("a development instance runs the source worker, not the installed one", async () => {
    await withInstalledRelease(async (installed, releaseRoot) => {
        expect(releaseRoot()).toBeUndefined();
        delete process.env.VERA_DEV_INSTANCE;
        expect(releaseRoot()).toBe(installed);
        expect(residentWorkerSpawnCommand(installed)).toEqual([join(installed, "worker")]);
    });
});

test("a development instance runs the source supervisor, not the installed one", async () => {
    await withInstalledRelease(async (installed, releaseRoot) => {
        expect(releaseRoot()).toBeUndefined();
        expect(residentSupervisorSpawnCommand(join(installed, "no-pack"))).toEqual([
            process.execPath,
            residentSupervisorEntrypoint(),
        ]);
        delete process.env.VERA_DEV_INSTANCE;
        expect(releaseRoot()).toBe(installed);
        expect(residentSupervisorSpawnCommand(installed)).toEqual([
            join(installed, RELEASE_SUPERVISOR_NAME),
        ]);
    });
});

test("a checkout pack without a worker wrapper uses bun and the source entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-spec-"));
    try {
        expect(residentWorkerSpawnCommand(root)).toEqual([
            process.execPath,
            residentWorkerEntrypoint(),
        ]);
        const packed = join(root, "worker");
        await writeFile(packed, "#!/bin/sh\n");
        expect(residentWorkerSpawnCommand(root)).toEqual([packed]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
