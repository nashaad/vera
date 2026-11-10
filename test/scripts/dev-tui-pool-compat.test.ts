import { expect } from "bun:test";
import { socketTest } from "../support/socket-probe.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runDevTui } from "../../scripts/dev-tui.ts";
import { synthesizeFactoryHome } from "../../scripts/synthesize-factory-home.ts";
import { forceStopHostProcess } from "../../src/host/force-stop.ts";
import { inspectHostLockFile } from "../../src/host/lockfile.ts";
import { inProcessWorkerSocket } from "../../src/host/pool/in-process.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";

socketTest("the development pool flag respects the single-process setting", async () => {
    const base = process.env.VERA_TEST_TEMP_BASE ?? "/private/tmp/vera-dev";
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, "pc-"));
    const sourceHome = join(root, "factory");
    synthesizeFactoryHome(sourceHome);
    await writeFile(join(sourceHome, "config.json"), JSON.stringify({
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
        host: { workers: 0 },
    }));
    let recorded: { pid: number; started_at: string } | undefined;
    try {
        const result = await runDevTui(["--pool"], process.cwd(), {
            sourceHome,
            temporaryRoot: join(root, "i"),
            devInstanceRoot: join(root, "registry"),
            async spawnTui(_args, env) {
                const home = env.VERA_HOME!;
                const lock = await inspectHostLockFile(join(home, "runtime", "host.json"));
                expect(lock.state).toBe("valid");
                if (lock.state !== "valid") throw new Error("Development host did not publish");
                recorded = lock.record;
                expect(lock.record.worker_count).toBeUndefined();
                expect(await requestHostIdentity(inProcessWorkerSocket(home))).toBeUndefined();
                return 0;
            },
        });
        expect(result).toBe(0);
    } finally {
        if (recorded !== undefined) {
            const stopped = await forceStopHostProcess(recorded, { sigtermGraceMs: 2_500, sigkillGraceMs: 1_500 });
            expect(["sigterm", "already_dead"]).toContain(stopped.endedBy);
        }
        await rm(root, { recursive: true, force: true });
    }
}, 40_000);
