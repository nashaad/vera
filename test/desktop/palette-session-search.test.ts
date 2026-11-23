import { expect, test } from "bun:test";
import { HostProtocolClient, type AgentListFacts } from "../../clients/ui/src/protocol/client.ts";
import { buildSessionItems, rankItems } from "../../clients/ui/src/overlays/palette.ts";
import { appendSessionMatches, scheduleSessionSearch } from "../../clients/ui/src/overlays/session-search.ts";

function match(id: string, title: string, workspace = "/crow"): object {
    return { id, title, workspace };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("host results append without moving loaded matches or duplicating sessions", () => {
    const loaded = rankItems(buildSessionItems([
        { id: "recent", name: "Crow notes", workspace: "/crow", status: "idle", live: false, chat: false },
    ], 0), "crow");
    const result = appendSessionMatches(loaded, { agents: [match("recent", "Crow notes"), match("old", "Crow voyage"), match("folder", "Pirate"), match("other", "Sail", "/sea")] }, "crow", 0);
    expect(result.map((entry) => entry.item.id)).toEqual(["recent", "old", "folder"]);
    expect(result[0]).toBe(loaded[0]);
    expect(result[1]?.indices).toEqual([0, 1, 2, 3]);
    expect(result[2]?.indices).toEqual([]);
});

test("debounce and cancellation discard old and closed searches", async () => {
    const calls: string[] = [];
    const landed: string[] = [];
    let resolveOld: ((result: AgentListFacts) => void) | undefined;
    const search = (query: string): Promise<AgentListFacts> => {
        calls.push(query);
        if (query === "old") return new Promise((resolve) => { resolveOld = resolve; });
        return Promise.resolve({ agents: [] });
    };
    const cancelBefore = scheduleSessionSearch("before", search, () => landed.push("before"));
    cancelBefore();
    const cancelOld = scheduleSessionSearch("old", search, () => landed.push("old"));
    await wait(180);
    cancelOld();
    const cancelNew = scheduleSessionSearch("new", search, () => landed.push("new"));
    resolveOld?.({ agents: [] });
    await wait(180);
    cancelNew();
    expect(calls).toEqual(["old", "new"]);
    expect(landed).toEqual(["new"]);
});

test("a queued stale listing is ignored while the sidebar poll is busy", async () => {
    const sent: Array<{ type: string; query?: string }> = [];
    const client = new HostProtocolClient((text) => sent.push(JSON.parse(text)));
    const poll = client.listAgents({ order: "recent" });
    const landed: string[] = [];
    const search = (query: string) => client.listAgents({ query, limit: 50, order: "recent" });
    const cancelOld = scheduleSessionSearch("old", search, () => landed.push("old"));
    await wait(180);
    cancelOld();
    const cancelNew = scheduleSessionSearch("new", search, () => landed.push("new"));
    await wait(180);
    expect(sent.map((entry) => entry.query)).toEqual([undefined]);
    client.feed('{"type":"agent_list","agents":[]}\n');
    await poll;
    await wait(0);
    expect(sent.map((entry) => entry.query)).toEqual([undefined, "old"]);
    client.feed('{"type":"agent_list","agents":[]}\n');
    await wait(0);
    expect(sent.map((entry) => entry.query)).toEqual([undefined, "old", "new"]);
    client.feed('{"type":"agent_list","agents":[]}\n');
    await wait(0);
    cancelNew();
    expect(landed).toEqual(["new"]);
});

test("a rejected host search finishes quietly", async () => {
    let answered = false;
    let answer: AgentListFacts | undefined;
    const cancel = scheduleSessionSearch("crow", async () => { throw new Error("offline"); }, (result) => { answered = true; answer = result; });
    await wait(180);
    cancel();
    expect(answered).toBe(true);
    expect(answer).toBeUndefined();
});
