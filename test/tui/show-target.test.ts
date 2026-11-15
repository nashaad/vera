import { expect, test } from "bun:test";

import type { TuiAgentClient } from "../../clients/tui/agent-client.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import {
    TERMINAL_SHOW_RUNNERS,
    showTerminalTarget,
    terminalShowTargetIds,
    watchSessionShow,
    type TerminalShowRunner,
} from "../../clients/tui/main/show-target.ts";
import { createTuiState } from "../../clients/tui/state.ts";

interface ShowingClient {
    readonly client: TuiAgentClient;
    show(target: string): void;
    readonly listeners: Set<(target: string) => void>;
}

function showingClient(): ShowingClient {
    const listeners = new Set<(target: string) => void>();
    const client: TuiAgentClient = {
        agentId: "agent-1",
        send: async () => undefined,
        receive: () => new Promise(() => undefined),
        detach: async () => undefined,
        close: () => undefined,
        onSessionShow(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    return {
        client,
        listeners,
        show(target) {
            for (const listener of listeners) listener(target);
        },
    };
}

function runtime(client: TuiAgentClient): TuiRuntime {
    return {
        client,
        shuttingDown: false,
        stopWatchingSessionShow: undefined,
        // Every overlay field is left undefined, so nothing is open.
        experimentalTuiHost: { hasModal: () => false },
        sidebar: { isFocused: () => false },
        hostedSidebar: { pane: undefined },
        state: createTuiState(),
    } as unknown as TuiRuntime;
}

test("@core the terminal has a runner for each target marked terminal and for no other", () => {
    expect(Object.keys(TERMINAL_SHOW_RUNNERS).sort()).toEqual([...terminalShowTargetIds()].sort());
});

test("a show request runs the runner for its target", () => {
    const attached = showingClient();
    const rt = runtime(attached.client);
    const opened: string[] = [];
    const runners: Record<string, TerminalShowRunner> = {
        "dialog.themes": () => opened.push("themes"),
    };

    watchSessionShow(rt, attached.client, runners);
    attached.show("dialog.themes");
    attached.show("dialog.feedback");
    attached.show("dialog.pirate-map");

    expect(opened).toEqual(["themes"]);
});

test("a show request for a session the terminal has left is ignored", () => {
    const left = showingClient();
    const current = showingClient();
    const rt = runtime(left.client);
    const opened: string[] = [];
    const runners: Record<string, TerminalShowRunner> = {
        "dialog.themes": () => opened.push("themes"),
    };

    watchSessionShow(rt, left.client, runners);
    rt.client = current.client;
    watchSessionShow(rt, current.client, runners);
    left.show("dialog.themes");

    expect(left.listeners.size).toBe(0);
    expect(opened).toEqual([]);
    current.show("dialog.themes");
    expect(opened).toEqual(["themes"]);
});

test("a show request while an overlay is open is declined with a notice", () => {
    const attached = showingClient();
    const rt = runtime(attached.client);
    // Set so the render that follows the notice returns at once.
    (rt as { shuttingDown: boolean }).shuttingDown = true;
    (rt as { dialStrip: unknown }).dialStrip = {};
    const opened: string[] = [];
    const runners: Record<string, TerminalShowRunner> = {
        "dialog.themes": () => opened.push("themes"),
    };

    showTerminalTarget(rt, "dialog.themes", runners);

    expect(opened).toEqual([]);
    expect(JSON.stringify(rt.state.entries)).toContain(
        "Help tried to open Choose Theme. Close this dialog and ask again.",
    );
});
