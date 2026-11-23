import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRegistry } from "../../src/host/agent-registry.ts";
import { sendToPeer } from "../../src/host/agent-registry/roster.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry/support.ts";
import { SessionStore } from "../../src/store/session-store.ts";

test("@core a transferred stored summary cannot enqueue to an oversized terminal failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "peer-send-failure-"));
    try {
        const path = join(root, "crow.jsonl");
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendIdentity({ name: "quiet-crow:1234", key: "quiet-crow:1234" });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "The chart." }] });
        await store.appendAgentFailure("failure", "The missing map. ".repeat(8_000));
        const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
        const failure = JSON.parse(lines.pop()!);
        lines.push(JSON.stringify({ detail: failure.detail, id: failure.id, timestamp: failure.timestamp, type: failure.type }));
        await writeFile(path, `${lines.join("\n")}\n`);
        const file = await stat(path);
        const summary: RegisteredAgentSummary = {
            id: "crow", workspace: root, session_path: path, kind: "interactive", status: "completed",
            live: false, size_bytes: file.size, updated_at: file.mtime.toISOString(),
        };
        let appended = false;
        let resumed = false;
        const reg = {
            agents: new Map(),
            options: { inboxDelivery: { append: async () => { appended = true; return { seq: 1 }; } } },
            storedPeers: {
                withTarget: async (_id: string, run: (row: RegisteredAgentSummary, resume: () => Promise<never>) => Promise<unknown>) =>
                    await run(summary, async () => { resumed = true; throw new Error("unexpected resume"); }),
            },
        } as unknown as AgentRegistry;
        const result = await sendToPeer(reg,
            { id: "sender", workspace: root, label: "Sender", hop: 0, readThrough: 0 },
            { type: "agent_send", to: "crow", text: "The map is safe." });
        expect(result.isError).toBe(true);
        expect(result.output).toContain("No native Vera participant");
        expect(appended).toBe(false);
        expect(resumed).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
