import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachAgent } from "../../src/host/attached-client.ts";
import { HOST_CAPABILITY_WORK_INDEX } from "../../src/host/capabilities.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import type { WorkIndexSnapshot } from "../../src/host/work-index.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

/**
 * A session that really edits a file, through the real tool, becoming a real
 * review row on a real attached client.
 *
 * The count has to come from what the session actually did, so nothing here
 * hands the host a number: it writes a file and then asks what the inbox says.
 */

const socketTest = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? test.skip
    : test;

socketTest("a session that edited files is ready to review", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-review-row-"));
    const target = join(root, "hello.txt");
    await writeFile(target, "before\n", "utf8");
    const socketPath = join(root, "host.sock");
    const host = await startResidentHost({
        config: {
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            approval_mode: "auto",
        },
        createAdapter: () => new FauxAdapter([
            writeCall(target),
            textResponse("done"),
        ]),
        socketPath,
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "events"),
    });
    await host.registry.create({ id: "review-row-flow-agent", workspace: root });
    const client = await attachAgent({
        socketPath,
        agentId: "review-row-flow-agent",
        requestedCapabilities: [HOST_CAPABILITY_WORK_INDEX],
    });
    try {
        await client.send({ type: "prompt", content: "change it" });

        const reviewing = await untilIndex(client, (index) =>
            index.rows.some((row) => row.section === "ready_to_review"));
        const row = reviewing.rows.find((candidate) =>
            candidate.section === "ready_to_review");

        expect(row?.reason).toBe("review");
        expect(row?.summary).toBe("1 file changed");
        expect(row?.changed_files).toBe(1);
        expect(row?.session_id).toBe("review-row-flow-agent");
        // The edit really happened; the row is describing the real thing.
        expect(await readFile(target, "utf8")).toContain("after");
    } finally {
        client.close();
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);

async function untilIndex(
    client: {
        readonly workIndex: WorkIndexSnapshot | undefined;
        onWorkIndex(listener: (index: WorkIndexSnapshot) => void): () => void;
    },
    matches: (index: WorkIndexSnapshot) => boolean,
): Promise<WorkIndexSnapshot> {
    if (client.workIndex !== undefined && matches(client.workIndex)) {
        return client.workIndex;
    }
    return new Promise((resolve) => {
        const stop = client.onWorkIndex((index) => {
            if (!matches(index)) return;
            stop();
            resolve(index);
        });
    });
}

function writeCall(path: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "write-1",
            name: "write",
            input: { path, content: "after\n" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
