import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadVeraConfig } from "../../../src/config.ts";
import { inProcessWorkerSocket } from "../../../src/host/master/in-process.ts";
import { requestHostIdentity } from "../../../src/host/protocol.ts";
import { startResidentHost } from "../../../src/host/runtime.ts";

const home = process.env.VERA_HOME!;
const count = Number(process.argv[2] ?? "2");
const grace = Number(process.argv[3] ?? "30000");
const auto = process.argv[4] === "auto";
const configPath = join(home, "config.json");
const host = await startResidentHost({
    home, configPath, config: loadVeraConfig({ path: configPath }),
    ...(auto ? {} : { processWorker: true, processWorkerCount: count }),
    processWorkerMasterGraceMs: grace, skipStartupDiscovery: true,
    webRoot: join(home, "web"),
});
const workers = await Promise.all(Array.from({ length: count }, (_, index) =>
    requestHostIdentity(inProcessWorkerSocket(home, index))));
await writeFile(join(home, "ready.json"), JSON.stringify({
    pid: process.pid, workers: workers.map((worker) => worker?.pid), annexPid: host.annexPid,
    socket: host.server.socketPath,
}));
const stopped = Promise.withResolvers<void>();
process.once("SIGTERM", () => stopped.resolve());
process.once("SIGINT", () => stopped.resolve());
await stopped.promise;
await host.close();
