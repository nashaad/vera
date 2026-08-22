import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
    configureUatOwnerLeaseForTest,
    ownTmuxServer,
    ownVeraHostLock,
    uatOwnerWatchdogPid,
} from "./uat-process-owner.ts";

const [mode, socket, readyPath, foreignPidText] = process.argv.slice(2);
const foreignPid = Number(foreignPidText);
if (
    (mode !== "death" && mode !== "wedge")
    || socket === undefined
    || readyPath === undefined
    || !Number.isInteger(foreignPid)
    || foreignPid <= 0
) process.exit(2);

configureUatOwnerLeaseForTest({
    heartbeatIntervalMs: 25,
    heartbeatTimeoutMs: 200,
});
ownTmuxServer(socket);

const root = dirname(readyPath);
const hostLockPath = join(root, "host.json");
const publishHostPath = join(root, "publish-host");
ownVeraHostLock(hostLockPath);
const temporaryHost = Bun.spawn([
    process.execPath,
    "run",
    join(import.meta.dir, "uat-delayed-host.ts"),
    hostLockPath,
    publishHostPath,
], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
if (mode === "death") {
    writeFileSync(publishHostPath, "publish\n");
    await waitForPath(hostLockPath);
}

// The lifecycle proof registers this lock deliberately, but its stale start
// identity names a different process. Cleanup must leave that process alone.
const foreignLockPath = join(root, "foreign-host.json");
ownVeraHostLock(foreignLockPath);
writeFileSync(foreignLockPath, `${JSON.stringify({
    schema_version: 2,
    pid: foreignPid,
    started_at: "2000-01-01T00:00:00.000Z",
    socket_path: join(root, "foreign-host.sock"),
})}\n`);

const tmux = Bun.spawnSync([
    "tmux",
    "-L",
    socket,
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    "owned",
    "sleep 300",
], { stdout: "ignore", stderr: "pipe" });
if (tmux.exitCode !== 0) {
    process.stderr.write(tmux.stderr.toString());
    process.exit(1);
}

writeFileSync(readyPath, `${JSON.stringify({
    controllerPid: process.pid,
    hostPid: temporaryHost.pid,
    watchdogPid: uatOwnerWatchdogPid(),
    hostLockPath,
    publishHostPath,
})}\n`);

if (mode === "wedge") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else {
    await Bun.sleep(300_000);
}

async function waitForPath(path: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (existsSync(path)) return;
        await Bun.sleep(25);
    }
    throw new Error(`Timed out waiting for ${path}`);
}
