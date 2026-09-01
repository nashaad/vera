import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    residentWorkerEntrypoint,
    residentWorkerSpawnCommand,
} from "../../src/host/worker/handle.ts";

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
