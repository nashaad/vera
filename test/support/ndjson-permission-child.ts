import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runNdjsonBridge } from "../../clients/stdio/ndjson-bridge.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "./faux-adapter.ts";

const responses: AssistantMessage[] = [
    {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "python-after-permission-change",
            name: "bash",
            input: { command: "python3 --version" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    },
    {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    },
];

const sessionPath = join(
    tmpdir(),
    `vera-ndjson-permissions-${process.pid}.jsonl`,
);

try {
    await runNdjsonBridge(
        process.stdin,
        process.stdout,
        new FauxAdapter(responses, { delayMs: 75 }),
        "test",
        undefined,
        { sessionPath, approvalMode: "ask" },
    );
} finally {
    await rm(sessionPath, { force: true });
}
