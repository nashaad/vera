import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadVeraConfig } from "../../../src/config.ts";
import { startResidentHost } from "../../../src/host/runtime.ts";
import { SessionStore } from "../../../src/store/session-store.ts";

const root = process.env.VERA_CRASH_TEST_ROOT!;
const home = process.env.VERA_HOME!;
const configPath = join(home, "config.json");
if (process.env.VERA_CRASH_TEST_BATCH === "1") {
    const append = SessionStore.prototype.appendForeignRecord;
    SessionStore.prototype.appendForeignRecord = async function (record) {
        const line = await append.call(this, record);
        const message = record.message as { role?: string; toolCallId?: string } | undefined;
        if (message?.role === "tool_result" && message.toolCallId === "call-fast") {
            await writeFile(join(root, "fast-durable"), "done");
        }
        return line;
    };
}
const host = await startResidentHost({
    home,
    configPath,
    config: loadVeraConfig({ path: configPath }),
    socketPath: join(root, "host.sock"),
    lockPath: join(root, "host.json"),
    sessionDirectory: join(root, "sessions"),
    eventLogDirectory: join(root, "events"),
});
await writeFile(join(root, "ready.json"), JSON.stringify({
    pid: process.pid,
    annexPid: host.annexPid,
}));
process.once("SIGTERM", () => {
    void host.close().finally(() => process.exit(0));
});
