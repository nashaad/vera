import { expect, test } from "bun:test";

import type { TuiAgentClient } from "../../clients/tui/agent-client.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
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
