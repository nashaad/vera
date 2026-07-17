import { runNdjsonBridge } from "../../clients/stdio/ndjson-bridge.ts";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";

const responses: AssistantMessage[] = [
    {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    },
    {
        role: "assistant",
        content: [{ type: "text", text: "abcdefgh" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    },
    {
        role: "assistant",
        content: [{ type: "text", text: "queued" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    },
];

const sessionPath = join(tmpdir(), `vera-ndjson-${process.pid}.jsonl`);

try {
    await runNdjsonBridge(
        process.stdin,
        process.stdout,
        new FauxAdapter(responses, { chunkSize: 1, delayMs: 30 }),
        "test",
        undefined,
        { sessionPath },
    );
} finally {
    await rm(sessionPath, { force: true });
}
