import { spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runResidentHostProcess } from "../../../clients/host/process-lifecycle.ts";
import { loadVeraConfig } from "../../../src/config.ts";
import * as supervisor from "../../../src/host/master/supervisor.ts";
import { startResidentHost } from "../../../src/host/runtime.ts";

const home = process.env.VERA_HOME!;
const start = supervisor.startSessionWorkerSupervisor;
spyOn(supervisor, "startSessionWorkerSupervisor").mockImplementation(async (options) => {
    if (options.adopt !== undefined) {
        await writeFile(join(home, "adoption-entered"), "");
        while (!existsSync(join(home, "adoption-release"))) await Bun.sleep(10);
    }
    return await start(options);
});

const configPath = join(home, "config.json");
const host = await startResidentHost({
    home, configPath, config: loadVeraConfig({ path: configPath }),
    skipStartupDiscovery: true, webRoot: join(home, "web"),
});
await writeFile(join(home, "adoption-ready.json"), JSON.stringify({ pid: process.pid, annexPid: host.annexPid }));
await runResidentHostProcess(host, host.workerStopPids === undefined ? {} : { poolWorkerPids: host.workerStopPids });
