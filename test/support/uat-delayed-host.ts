import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { processStartedAt } from "../../src/host/process-identity.ts";

const [hostLockPath, publishHostPath] = process.argv.slice(2);
if (hostLockPath === undefined || publishHostPath === undefined) process.exit(2);

while (!existsSync(publishHostPath)) await Bun.sleep(25);
writeFileSync(hostLockPath, `${JSON.stringify({
    schema_version: 2,
    pid: process.pid,
    started_at: new Date(
        processStartedAt(process.pid) ?? Date.now(),
    ).toISOString(),
    socket_path: join(dirname(hostLockPath), "host.sock"),
})}\n`);
await Bun.sleep(300_000);
