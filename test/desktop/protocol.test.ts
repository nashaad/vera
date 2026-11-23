import { expect, test } from "bun:test";

import { HostProtocolClient, sessionCount } from "../../clients/ui/src/protocol/client.ts";

function connected(): { client: HostProtocolClient; frames: string[] } {
    const frames: string[] = [];
    const client = new HostProtocolClient((text) => frames.push(text));
    return { client, frames };
}

test("@core the client sends host_identity and reads a split reply", async () => {
    const { client, frames } = connected();
    const identity = client.hostIdentity();
    expect(JSON.parse(frames[0]!)).toEqual({ type: "host_identity" });
    client.feed("{\"type\":\"host_");
    client.feed("identity\",\"pid\":42,\"protocol_version\":7,\"build_id\":\"abc\"}\n");
    expect(await identity).toMatchObject({ pid: 42, protocol_version: 7 });
});

test("@core the client reads coalesced replies and counts sessions", async () => {
    const { client, frames } = connected();
    const identity = client.hostIdentity();
    const list = client.listAgents();
    expect(JSON.parse(frames[1]!)).toEqual({ type: "list_agents", limit: 50 });
    client.feed(
        "{\"type\":\"host_identity\",\"pid\":7,\"protocol_version\":7,\"build_id\":null}\n"
        + "{\"type\":\"agent_list\",\"agents\":[],\"total\":3}\n",
    );
    expect((await identity).pid).toBe(7);
    expect(sessionCount(await list)).toBe(3);
});

test("@core the client rejects an invalid reply", async () => {
    const { client } = connected();
    const list = client.listAgents();
    client.feed("{\"type\":\"agent_list\",\"agents\":\"nope\"}\n");
    expect(list).rejects.toThrow("invalid agent_list");
});

test("@core the client rejects an oversized frame and fails pending work", async () => {
    const { client } = connected();
    const identity = client.hostIdentity();
    client.feed("x".repeat(1_048_577));
    expect(identity).rejects.toThrow("larger than this client accepts");
});

test("@core list_agents serializes overlapping pages and carries each cursor", async () => {
    const { client, frames } = connected();
    const first = client.listAgents({ limit: 100, order: "recent" });
    const second = client.listAgents({ limit: 100, order: "recent", cursor: "crow-100" });
    expect(frames.map((frame) => JSON.parse(frame))).toEqual([
        { type: "list_agents", limit: 100, order: "recent" },
    ]);
    client.feed("{\"type\":\"agent_list\",\"agents\":[],\"next_cursor\":\"crow-100\",\"total\":101}\n");
    await first;
    await Bun.sleep(0);
    expect(frames.map((frame) => JSON.parse(frame))).toEqual([
        { type: "list_agents", limit: 100, order: "recent" },
        { type: "list_agents", limit: 100, order: "recent", cursor: "crow-100" },
    ]);
    client.feed("{\"type\":\"agent_list\",\"agents\":[{}],\"total\":101}\n");
    await second;
});

test("a lost list reply releases queued requests and overlapping polls are dropped", async () => {
    const { client, frames } = connected();
    const first = client.listAgents({ limit: 50 });
    const firstFailure = first.catch((error: unknown) => error);
    const second = client.listAgents({ limit: 100, cursor: "crow-100" });
    expect(client.pollAgents()).toBeUndefined();
    expect(frames).toHaveLength(1);
    expect(await firstFailure).toBeInstanceOf(Error);
    expect((await firstFailure as Error).message).toContain("did not answer agent_list in time");
    await Bun.sleep(0);
    expect(frames.map((frame) => JSON.parse(frame))).toEqual([
        { type: "list_agents", limit: 50 },
        { type: "list_agents", limit: 100, cursor: "crow-100" },
    ]);
    expect(client.pollAgents()).toBeUndefined();
    client.feed("{\"type\":\"agent_list\",\"agents\":[]}\n");
    expect((await second).agents).toEqual([]);
}, 7_000);

test("@core session page requests remain bounded at 50 rows and count from total", async () => {
    const { client, frames } = connected();
    const page = client.listAgents({ limit: 50, order: "recent" });
    expect(JSON.parse(frames[0]!)).toEqual({ type: "list_agents", limit: 50, order: "recent" });
    client.feed("{\"type\":\"agent_list\",\"agents\":[{}],\"next_cursor\":\"a\",\"total\":612}\n");
    expect(sessionCount(await page)).toBe(612);
});

test("@core a page with more rows behind it and no total has no count", () => {
    expect(sessionCount({ agents: [{}], next_cursor: "a" })).toBeUndefined();
    expect(sessionCount({ agents: [{}, {}] })).toBe(2);
});
