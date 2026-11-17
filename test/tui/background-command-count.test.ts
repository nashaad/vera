import { expect, test } from "bun:test";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import type { ListedAgentsPage } from "../../src/host/agent-list-client.ts";
import {
    BACKGROUND_COMMAND_PAGE_SIZE,
    currentBackgroundCommandCount,
    quitBackgroundCommandSummary,
    shouldConfirmQuit,
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

test("@core quit only confirms when at least one background command is running", () => {
    expect(shouldConfirmQuit(0)).toBe(false);
    expect(shouldConfirmQuit(1)).toBe(true);
});

test("@core quit summary distinguishes current, other, and spread commands", async () => {
    const agents = [
        { id: "current", background_commands: 2 },
        { id: "other", background_commands: 2 },
    ];
    const list = async () => listedPage(agents);

    await expect(quitBackgroundCommandSummary(list, "current", undefined))
        .resolves.toMatchObject({
            total: 2,
            current: 2,
            other: 0,
            conversations: 1,
            message: "2 background commands are running in this conversation.",
        });
    await expect(quitBackgroundCommandSummary(list, "current", "other"))
        .resolves.toMatchObject({
            total: 4,
            current: 2,
            other: 2,
            conversations: 2,
            message: "4 background commands are running in 2 conversations.",
        });
    await expect(quitBackgroundCommandSummary(async () => listedPage([
        { id: "current" },
        { id: "other", background_commands: 1 },
    ]), "current", "other"))
        .resolves.toMatchObject({
            total: 1,
            current: 0,
            other: 1,
            conversations: 1,
            message: "1 background command is running in another conversation.",
        });
    await expect(quitBackgroundCommandSummary(list, "other", "other"))
        .resolves.toMatchObject({
            total: 2,
            current: 2,
            other: 0,
            conversations: 1,
            message: "2 background commands are running in this conversation.",
        });
});

test("@core quit wording uses singular for one current or other command", async () => {
    const list = async () => listedPage([
        { id: "current", background_commands: 1 },
        { id: "other", background_commands: 1 },
    ]);
    await expect(quitBackgroundCommandSummary(list, "current", undefined))
        .resolves.toMatchObject({ message: "1 background command is running in this conversation." });
    await expect(quitBackgroundCommandSummary(list, "current", "other"))
        .resolves.toMatchObject({ message: "2 background commands are running in 2 conversations." });
});

test("@core quit still counts the other attachment when one lookup fails", async () => {
    let requests = 0;
    const list = async () => {
        requests += 1;
        if (requests === 1) throw new Error("lookup unavailable");
        return listedPage([{ id: "other", background_commands: 2 }]);
    };
    await expect(quitBackgroundCommandSummary(list, "current", "other"))
        .resolves.toMatchObject({
            total: 2,
            message: "2 background commands are running in another conversation.",
        });
    await expect(quitBackgroundCommandSummary(async () => listedPage([
        { id: "other", background_commands: 1 },
    ]), undefined, "other"))
        .resolves.toMatchObject({
            total: 1,
            message: "1 background command is running in another conversation.",
        });
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
