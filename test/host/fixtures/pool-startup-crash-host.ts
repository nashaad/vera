import { spyOn } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as supervisor from "../../../src/host/pool/supervisor.ts";
import { startResidentHost } from "../../../src/host/runtime.ts";

const home = process.env.VERA_HOME!;
const heldId = process.env.POOL_CRASH_SCAN_HELD_ID!;
const startWorker = supervisor.startSessionWorkerSupervisor;
spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation((options) => startWorker({
    ...options,
    async handler(method, args, signal) {
        const result = await options.handler(method, args, signal);
        if (method === "recovery.recordCrash" && args[0] === heldId) {
            await writeFile(join(home, "scan-paused"), "");
            await new Promise<void>(() => {});
        }
        return result;
    },
}));

const host = await startResidentHost({
    home, processWorker: true, processWorkerCount: 2, skipStartupDiscovery: true,
    config: {
        schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
        providers: { stub: { protocol: "openai-chat", base_url: "http://127.0.0.1:1/v1", credential: "none" } },
    },
});
await writeFile(join(home, "scan-finished"), "");
const stopped = Promise.withResolvers<void>();
process.once("SIGTERM", () => stopped.resolve());
process.once("SIGINT", () => stopped.resolve());
await stopped.promise;
await host.close();
