import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadVeraConfig } from "../../../src/config.ts";
import { inProcessWorkerSocket } from "../../../src/host/master/in-process.ts";
import { requestHostIdentity } from "../../../src/host/protocol.ts";
import { startResidentHost } from "../../../src/host/runtime.ts";

const home = process.env.VERA_HOME!;
const configPath = join(home, "config.json");
const host = await startResidentHost({
    home, configPath, config: loadVeraConfig({ path: configPath }), processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
});
const worker = await requestHostIdentity(inProcessWorkerSocket(home));
await writeFile(join(home, "ready.json"), JSON.stringify({
    pid: process.pid, workerPid: worker?.pid, annexPid: host.annexPid, socket: host.server.socketPath,
}));
const stopped = Promise.withResolvers<void>();
process.once("SIGTERM", () => stopped.resolve());
process.once("SIGINT", () => stopped.resolve());
await stopped.promise;
await host.close();
