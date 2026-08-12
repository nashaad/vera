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

/** Answers with the prompt labels it was given, in order, so a pane assertion reads the model's context. */
function echoingAdapter(): ModelAdapter {
    return {
        stream(request) {
            const seen: string[] = [];
            for (const message of request.messages) {
                if (message.role !== "user") continue;
                for (const content of message.content) {
                    if (content.type !== "text") continue;
                    for (const token of content.text.match(/\b[PS]\d\b/g) ?? []) {
                        seen.push(token);
                    }
                }
            }
            const message: AssistantMessage = {
                role: "assistant",
                content: [{ type: "text", text: `SEEN:${seen.join(",")}` }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: emptyUsage(),
                stopReason: "stop",
            };
            return new FauxAdapter([message]).stream(request);
        },
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
    createAdapter: () => echoingAdapter(),
    sessionDirectory: join(home, ".vera", "sessions"),
    eventLogDirectory: join(home, ".vera", "events"),
    inboxPath: join(home, ".vera", "inbox.db"),
});

await host.registry.create({ id: "btw-main", workspace: process.cwd() });
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
