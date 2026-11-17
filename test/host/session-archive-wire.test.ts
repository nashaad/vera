import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectHost } from "../../src/host/connection.ts";
import { parseHostRequest } from "../../src/host/protocol.ts";
import { startHostServer } from "../../src/host/server.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { socketTest } from "../support/socket-probe.ts";

test("@core archive request requires a target and boolean", () => {
    const request = { type: "set_session_archived", target_agent_id: "child", archived: true } as const;
    expect(parseHostRequest(JSON.stringify(request))).toEqual(request);
    expect(parseHostRequest(JSON.stringify({ ...request, archived: "true" }))).toBeUndefined();
    expect(parseHostRequest(JSON.stringify({ ...request, target_agent_id: "" }))).toBeUndefined();
});

socketTest("@core nested archive requests update the root and both clients read the family state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-archive-wire-"));
    const socketPath = join(directory, "host.sock");
    const row = (id: string, parent?: string, archived = false): RegisteredAgentSummary => ({
        id, workspace: "/work", session_path: `/sessions/${id}.jsonl`, kind: "interactive", status: "idle", live: false,
        updated_at: id === "root" ? "2020-01-01T00:00:00Z" : "2025-01-01T00:00:00Z",
        archived, ...(parent === undefined ? {} : { parent_id: parent }),
    });
    let rows = [row("root"), row("child", "root"), row("grandchild", "child"), ...Array.from({ length: 50 }, (_, i) => row(`other-${i}`))];
    const writes: string[] = [];
    const server = await startHostServer({
        socketPath, lockPath: join(directory, "host.json"),
        listAgents: () => rows,
        setSessionArchived: async (id, archived) => {
            writes.push(id);
            rows = rows.map((item) => item.id === id ? { ...item, archived } : item);
            return "updated";
        },
    });
    const request = async (value: unknown): Promise<any> => {
        const connection = await connectHost({ socketPath });
        try { await connection.send(value); return await connection.receive(); }
        finally { connection.close(); }
    };
    try {
        expect(await request({ type: "set_session_archived", target_agent_id: "grandchild", archived: true }))
            .toEqual({ type: "session_archived", agent_id: "grandchild", archived: true });
        for (let client = 0; client < 2; client += 1) {
            const list = await request({ type: "list_agents", limit: 50, order: "recent" });
            expect(list.agents.some((item: RegisteredAgentSummary) => item.id === "root")).toBe(false);
            expect(list.agents.find((item: RegisteredAgentSummary) => item.id === "grandchild")?.archived).toBe(true);
        }
        expect(await request({ type: "set_session_archived", target_agent_id: "grandchild", archived: false }))
            .toEqual({ type: "session_archived", agent_id: "grandchild", archived: false });
        for (let client = 0; client < 2; client += 1) {
            const list = await request({ type: "list_agents", limit: 50, order: "recent" });
            expect(list.agents.find((item: RegisteredAgentSummary) => item.id === "grandchild")?.archived).toBe(false);
        }
        expect(writes).toEqual(["root", "root"]);
    } finally {
        await server.close();
        await rm(directory, { recursive: true, force: true });
    }
});
