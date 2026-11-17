import { expect, test } from "bun:test";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import type { ListedAgentsPage } from "../../src/host/agent-list-client.ts";
import {
    BACKGROUND_COMMAND_PAGE_SIZE,
    currentBackgroundCommandCount,
    stopAndCloseDescription,
} from "../../clients/tui/background-command-count.ts";

function listedPage(
    agents: readonly { readonly id: string; readonly background_commands?: number }[],
    nextCursor?: string,
    unavailableWorkers?: readonly string[],
): ListedAgentsPage {
    return {
        agents: agents as readonly RegisteredAgentSummary[],
        ...(nextCursor === undefined ? {} : { nextCursor }),
        ...(unavailableWorkers === undefined ? {} : { unavailableWorkers }),
    };
}

test("@core close-picker copy describes the running turn or background commands", () => {
    expect(stopAndCloseDescription(0))
        .toBe("stop this conversation and its running turn");
    expect(stopAndCloseDescription(1))
        .toBe("stop this conversation and its 1 background command");
    expect(stopAndCloseDescription(2))
        .toBe("stop this conversation and its 2 background commands");
});

test("@core current background-command count pages to the active conversation", async () => {
    const requests: { limit?: number; cursor?: string; order?: string }[] = [];
    const count = await currentBackgroundCommandCount(async (options) => {
        requests.push(options);
        return requests.length === 1
            ? listedPage([{ id: "other" }], "next")
            : listedPage([{ id: "active", background_commands: 2 }]);
    }, "active");

    expect(count).toBe(2);
    expect(requests).toEqual([
        { limit: BACKGROUND_COMMAND_PAGE_SIZE, order: "recent" },
        { limit: BACKGROUND_COMMAND_PAGE_SIZE, order: "recent", cursor: "next" },
    ]);
});

test("@core a listed conversation without the optional count has no running commands", async () => {
    await expect(currentBackgroundCommandCount(async () =>
        listedPage([{ id: "active" }]), "active")).resolves.toBe(0);
});

test("@core an unavailable pool worker makes the target count unknown", async () => {
    await expect(currentBackgroundCommandCount(async () =>
        listedPage([{ id: "active" }], undefined, ["worker-7"]), "active"))
        .rejects.toThrow("pool worker is unavailable");
});

test("@core a target missing from the completed host listing is unknown", async () => {
    await expect(currentBackgroundCommandCount(async () =>
        listedPage([{ id: "other" }]), "active"))
        .rejects.toThrow("missing from the host session list");
});

test("@core a failed page does not become a zero count", async () => {
    await expect(currentBackgroundCommandCount(async () => {
        throw new Error("host page failed");
    }, "active")).rejects.toThrow("host page failed");
});

test("@core paging stops at the bounded scan limit when the active id is absent", async () => {
    let requests = 0;
    await expect(currentBackgroundCommandCount(async () => {
        requests += 1;
        return listedPage([], `cursor-${requests}`);
    }, "active")).rejects.toThrow("within 5,000 sessions");
    expect(requests).toBe(100);
});
