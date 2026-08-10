import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { startResidentHost } from "../../src/host/runtime.ts";
import { FauxAdapter } from "./faux-adapter.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
} from "../../src/model/types.ts";

const readyPath = process.env.VERA_TEST_READY_PATH;
if (readyPath === undefined || readyPath.length === 0) {
    throw new Error("VERA_TEST_READY_PATH is required");
}

function respondingAdapter(label: string): ModelAdapter {
    return {
        stream(request) {
            return new FauxAdapter([response(`${label} ANSWERED`)]).stream(request);
        },
    };
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

const home = homedir();
const host = await startResidentHost({
    config: {
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        approval_mode: "auto",
    },
    createAdapter: () => respondingAdapter("PAIR"),
    sessionDirectory: join(home, ".vera", "sessions"),
    eventLogDirectory: join(home, ".vera", "events"),
    inboxPath: join(home, ".vera", "inbox.db"),
});

await host.registry.create({ id: "pair-main", workspace: process.cwd() });
await writeFile(readyPath, "ready\n", "utf8");

try {
    await new Promise<void>((resolve) => {
        const stop = (): void => resolve();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
} finally {
    await host.close();
}
