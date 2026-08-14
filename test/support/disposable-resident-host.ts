import { startResidentHost } from "../../src/host/runtime.ts";
import { runResidentHostProcess } from "../../clients/host/process-lifecycle.ts";
import { FauxAdapter } from "./faux-adapter.ts";

const socketPath = requiredEnvironment("VERA_TEST_HOST_SOCKET");
const root = requiredEnvironment("VERA_TEST_HOST_ROOT");
const host = await startResidentHost({
    config: {
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        approval_mode: "auto",
    },
    createAdapter: () => new FauxAdapter([]),
    socketPath,
    lockPath: `${root}/host.json`,
    sessionDirectory: `${root}/sessions`,
    eventLogDirectory: `${root}/logs`,
});

process.stdout.write(`${JSON.stringify(host.server.identity)}\n`);
await runResidentHostProcess(host);

function requiredEnvironment(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}
