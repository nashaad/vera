import { join } from "node:path";

import { loadVeraConfig } from "../../../src/config.ts";
import { startResidentHost } from "../../../src/host/runtime.ts";
import { runResidentHostProcess } from "../../../clients/host/process-lifecycle.ts";

const home = process.env.VERA_HOME!;
const configPath = join(home, "config.json");
const pool = process.env.HS9_STOP_MODE !== "plain";
const host = await startResidentHost({
    home, configPath, webRoot: join(home, "web"), config: loadVeraConfig({ path: configPath }),
    ...(pool ? { processWorker: true, processWorkerCount: 3 } : {}), skipStartupDiscovery: true,
});
await runResidentHostProcess(host, pool ? { poolWorkerPids: host.workerStopPids } : {});
