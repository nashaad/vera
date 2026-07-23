import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { startResidentHost } from "../../src/host/runtime.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";

const readyPath = process.env.VERA_TEST_READY_PATH;
if (readyPath === undefined || readyPath.length === 0) {
    throw new Error("VERA_TEST_READY_PATH is required");
}

const home = homedir();
const host = await startResidentHost({
    config: {
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        approval_mode: "auto",
    },
    createAdapter: () => new FauxAdapter([
        response("FIRST ANSWER"),
        response("SECOND ANSWER"),
    ]),
    sessionDirectory: join(home, ".vera", "sessions"),
    eventLogDirectory: join(home, ".vera", "events"),
});

await host.registry.create({
    id: "rewind-agent",
    workspace: process.cwd(),
});
await writeFile(readyPath, "ready\n", "utf8");

try {
    await waitForShutdownSignal();
} finally {
    await host.close();
}

function waitForShutdownSignal(): Promise<void> {
    return new Promise((resolve) => {
        const stop = (): void => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            resolve();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
}

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
