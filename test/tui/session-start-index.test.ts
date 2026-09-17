import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceSidebarSessions } from "../../clients/tui/workspace-sidebar.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { indexStoredSession } from "../../src/host/runtime.ts";
import { SessionStore } from "../../src/store/session-store.ts";

for (const contexts of [["x".repeat(70_000)], ["é".repeat(65_536)], Array<string>(3).fill("x".repeat(30_000))]) {
    test(`saved sessions remain visible after ${contexts.map((text) => Buffer.byteLength(text)).join("+")} bytes of startup context`, async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-start-index-"));
        try {
            const path = join(root, "session.jsonl");
            const store = await SessionStore.create(path, { sessionId: "indexed", cwd: root });
            await store.appendMessage({
                role: "user", internal: true, contextSource: "session_start",
                content: [{ type: "text", text: contexts.join("\n\n") }],
            });
            const sessions = new Map<string, RegisteredAgentSummary>();
            await indexStoredSession(path, sessions);
            expect(workspaceSidebarSessions([...sessions.values()])).toEqual([]);

            await store.appendMessage({
                role: "user", content: [{ type: "text", text: "Find this conversation" }],
            });
            sessions.clear();
            await indexStoredSession(path, sessions);
            expect(sessions.get("indexed")).toMatchObject({
                live: false, has_user_content: true, title: "Find this conversation",
            });
            expect(workspaceSidebarSessions([...sessions.values()])).toMatchObject([
                { id: "indexed", title: "Find this conversation" },
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}
