import { expect, test } from "bun:test";

import type { TuiAgentClient } from "../../clients/tui/agent-client.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import { refreshTerminalTitle } from "../../clients/tui/main/chrome.ts";
import { watchSessionTitle } from "../../clients/tui/main/watchers.ts";

interface TitledClient {
    readonly client: TuiAgentClient;
    report(title: string | undefined): void;
}

function titledClient(): TitledClient {
    const listeners = new Set<(title: string | undefined) => void>();
    const client: TuiAgentClient = {
        agentId: "agent-1",
        send: async () => undefined,
        receive: () => new Promise(() => undefined),
        detach: async () => undefined,
        close: () => undefined,
        onSessionTitle(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    return {
        client,
        report(title) {
            for (const listener of listeners) listener(title);
        },
    };
}

function runtime(client: TuiAgentClient, titles: string[]): TuiRuntime {
    return {
        client,
        shuttingDown: false,
        clientSurfaceReady: false,
        sessionTitle: "first prompt text",
        stopWatchingSessionTitle: undefined,
        renderer: { setTerminalTitle: (title: string) => titles.push(title) },
    } as unknown as TuiRuntime;
}

test("a reported title replaces the window title of the open session", () => {
    const attached = titledClient();
    const titles: string[] = [];
    const rt = runtime(attached.client, titles);

    watchSessionTitle(rt, attached.client);
    attached.report("Raid the parrot cove");
    attached.report(undefined);

    expect(titles).toEqual(["Raid the parrot cove · Vera", "Vera"]);
    expect(rt.sessionTitle).toBeUndefined();
});

test("a title for a session the TUI has left is ignored", () => {
    const left = titledClient();
    const current = titledClient();
    const titles: string[] = [];
    const rt = runtime(left.client, titles);

    watchSessionTitle(rt, left.client);
    rt.client = current.client;
    watchSessionTitle(rt, current.client);
    left.report("Stale crow");

    expect(titles).toEqual([]);
    expect(rt.sessionTitle).toBe("first prompt text");
});

test("the window title of an open subagent reads sub: before its name", async () => {
    const attached = titledClient();
    const titles: string[] = [];
    const rt = runtime(attached.client, titles);
    let listed: Promise<unknown> = Promise.resolve();
    (rt as { dependencies: unknown }).dependencies = {
        listAgents: () => {
            const agents = Promise.resolve([{
                id: "agent-1",
                workspace: "/w",
                session_path: "/sessions/agent-1.jsonl",
                kind: "background",
                status: "working",
                live: true,
                title: "Count the doubloons",
                parent_id: "agent-0",
            }]);
            listed = agents;
            return agents;
        },
    };

    refreshTerminalTitle(rt);
    await listed;
    await Promise.resolve();
    watchSessionTitle(rt, attached.client);
    attached.report("Recount the doubloons");

    expect(titles).toEqual([
        "sub: Count the doubloons · Vera",
        "sub: Recount the doubloons · Vera",
    ]);
});
