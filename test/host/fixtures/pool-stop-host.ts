import { spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadVeraConfig } from "../../../src/config.ts";
import * as supervisor from "../../../src/host/master/supervisor.ts";
import { startResidentHost } from "../../../src/host/runtime.ts";
import { runResidentHostProcess } from "../../../clients/host/process-lifecycle.ts";
import { installLiveProcess } from "../../../src/live-process.ts";

const home = process.env.VERA_HOME!;
if (process.env.HS9_DELAY_REPLACEMENT === "1") {
    const start = supervisor.startSessionWorkerSupervisor;
    spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) => {
        if (options.generation === 2) {
            await writeFile(join(home, "replacement-entered"), "");
            while (!existsSync(join(home, "replacement-release"))) await Bun.sleep(10);
        }
        const worker = await start(options);
        if (options.generation === 2) {
            await writeFile(join(home, "replacement-ready.json"), JSON.stringify({ pid: worker.pid, started_at: worker.startedAt }));
        }
        return worker;
    });
}
if (process.env.STOPFIX_FAIL_SESSION === "1") {
    const start = supervisor.startSessionWorkerSupervisor;
    spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation((options) => start({
        ...options,
        spawnSpec: { command: process.execPath, args: [join(import.meta.dir, "failing-session-worker.ts")] },
    }));
}
const configPath = join(home, "config.json");
const pool = process.env.HS9_STOP_MODE !== "plain";
const host = await startResidentHost({
    home, configPath, webRoot: join(home, "web"), config: loadVeraConfig({ path: configPath }),
    ...(pool ? { processWorker: true, processWorkerCount: 3 } : {}), skipStartupDiscovery: true,
    ...(process.env.STOPFIX_FAIL_SESSION === "1" ? { eventLogDirectory: join(home, "events") } : {}),
});
installLiveProcess("host", home);
await runResidentHostProcess(host, pool ? { poolWorkerPids: host.workerStopPids } : {});
