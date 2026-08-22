import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
    ownTmuxServer,
    ownUatProcess,
    ownVeraHostLock,
    uatOwnerWatchdogPid,
} from "./uat-process-owner.ts";
import { processStartedAt } from "../../src/host/process-identity.ts";

const [socket, readyPath, foreignPidText] = process.argv.slice(2);
const foreignPid = Number(foreignPidText);
if (
    socket === undefined
    || readyPath === undefined
    || !Number.isInteger(foreignPid)
    || foreignPid <= 0
) process.exit(2);

ownTmuxServer(socket);
const ownedChild = Bun.spawn([
    process.execPath,
    "-e",
    "await Bun.sleep(300000)",
], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
ownUatProcess(ownedChild.pid);

const hostLockPath = join(dirname(readyPath), "host.json");
ownVeraHostLock(hostLockPath);
const temporaryHost = Bun.spawn([
    process.execPath,
    "-e",
    "await Bun.sleep(300000)",
], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
writeFileSync(hostLockPath, `${JSON.stringify({
    schema_version: 2,
    pid: temporaryHost.pid,
    started_at: new Date(
        processStartedAt(temporaryHost.pid) ?? Date.now(),
    ).toISOString(),
    socket_path: join(dirname(readyPath), "host.sock"),
})}\n`);

// The lifecycle proof registers this lock deliberately, but its stale start
// identity names a different process. Cleanup must leave that process alone.
const foreignLockPath = join(dirname(readyPath), "foreign-host.json");
ownVeraHostLock(foreignLockPath);
writeFileSync(foreignLockPath, `${JSON.stringify({
    schema_version: 2,
    pid: foreignPid,
    started_at: "2000-01-01T00:00:00.000Z",
    socket_path: join(dirname(readyPath), "foreign-host.sock"),
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
const session = Bun.spawnSync([
    "tmux",
    "-L",
    socket,
    "has-session",
    "-t",
    "owned",
], { stdout: "ignore", stderr: "pipe" });
if (session.exitCode !== 0) {
    process.stderr.write(session.stderr.toString());
    process.exit(1);
}

writeFileSync(readyPath, `${JSON.stringify({
    controllerPid: process.pid,
    ownedPid: ownedChild.pid,
    hostPid: temporaryHost.pid,
    watchdogPid: uatOwnerWatchdogPid(),
})}\n`);

await Bun.sleep(300_000);
