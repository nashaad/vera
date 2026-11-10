import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

import type { TuiAgentClient } from "../../clients/tui/agent-client.ts";
import { focusedAgentClient } from "../../clients/tui/main/agents-dials.ts";
import { requestExtensionPicker } from "../../clients/tui/main/extension-bridge.ts";
import {
    captureExtensionInvocation,
    conversationChanged,
    dropsLateResult,
    threadHasEarlierForInvocation,
    threadLoadEarlierForInvocation,
} from "../../clients/tui/main/extension-invocation.ts";
import type { ExtensionInvocation, TuiRuntime } from "../../clients/tui/main/runtime.ts";
import { createTuiState } from "../../clients/tui/state.ts";
import { createHistoryPaging } from "../../clients/tui/history-paging-state.ts";

interface Fixture {
    readonly rt: TuiRuntime;
    readonly focused: TuiAgentClient;
    readonly other: TuiAgentClient;
    readonly requested: string[];
    readonly setSidebarFocused: (value: boolean) => void;
}

function fixture(): Fixture {
    const requested: string[] = [];
    const focused = {
        supportsHostCapability: () => true,
        requestHistoryPage: async (before: string) => {
            requested.push(before);
            throw new Error("unexpected page request");
        },
    } as unknown as TuiAgentClient;
    const other = {} as TuiAgentClient;
    let sidebarFocused = false;
    const rt = {
        extensionAgentTarget: new AsyncLocalStorage<ExtensionInvocation>(),
        sidebar: { isFocused: () => sidebarFocused },
        hostedSidebar: { pane: { client: other } },
        client: focused,
        clientGeneration: 0,
        conversationGeneration: 0,
        shuttingDown: false,
        state: {
            ...createTuiState(),
            historyWindow: { entries: [], hasEarlier: true, olderBefore: "older-1" },
        },
        historyPaging: createHistoryPaging(),
        pendingTranscriptReseed: false,
    } as unknown as TuiRuntime;
    return {
        rt,
        focused,
        other,
        requested,
        setSidebarFocused: (value) => {
            sidebarFocused = value;
        },
    };
}

function thrownBy(run: () => unknown): unknown {
    try {
        run();
    } catch (error) {
        return error;
    }
    return undefined;
}

test("a stale invocation cannot read paging state", () => {
    const { rt } = fixture();
    const invocation = captureExtensionInvocation(rt);
    rt.conversationGeneration += 1;
    const error = rt.extensionAgentTarget.run(invocation, () =>
        thrownBy(() => threadHasEarlierForInvocation(rt)));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
});

test("a focused invocation reads paging state", () => {
    const { rt } = fixture();
    const invocation = captureExtensionInvocation(rt);
    expect(rt.extensionAgentTarget.run(invocation, () => threadHasEarlierForInvocation(rt))).toBe(true);
});

test("moving focus to the side pane does not stale the invocation", () => {
    const { rt, other, setSidebarFocused } = fixture();
    const invocation = captureExtensionInvocation(rt);
    setSidebarFocused(true);
    expect(focusedAgentClient(rt)).toBe(other);
    expect(rt.extensionAgentTarget.run(invocation, () => threadHasEarlierForInvocation(rt))).toBe(true);
});

test("a transport reattach does not stale the invocation", () => {
    const { rt } = fixture();
    const invocation = captureExtensionInvocation(rt);
    rt.clientGeneration += 1;
    expect(rt.extensionAgentTarget.run(invocation, () => threadHasEarlierForInvocation(rt))).toBe(true);
});

test("a stale invocation cannot load a page", async () => {
    const { rt, requested } = fixture();
    const invocation = captureExtensionInvocation(rt);
    rt.conversationGeneration += 1;
    const failure = await rt.extensionAgentTarget.run(invocation, () =>
        threadLoadEarlierForInvocation(rt).then(() => undefined, (error: unknown) => error));
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("AbortError");
    expect(requested).toEqual([]);
});

test("conversationChanged ignores a transport reattach and flags a conversation change", () => {
    const { rt } = fixture();
    const invocation = captureExtensionInvocation(rt);
    rt.clientGeneration += 1;
    expect(conversationChanged(rt, invocation)).toBe(false);
    rt.conversationGeneration += 1;
    expect(conversationChanged(rt, invocation)).toBe(true);
});

test("dropsLateResult keeps handled results and drops other results only after the conversation changes", () => {
    const { rt } = fixture();
    const invocation = captureExtensionInvocation(rt);
    expect(dropsLateResult(rt, invocation, "text")).toBe(false);
    rt.conversationGeneration += 1;
    expect(dropsLateResult(rt, invocation, "text")).toBe(true);
    expect(dropsLateResult(rt, invocation, "client_action")).toBe(true);
    expect(dropsLateResult(rt, invocation, "handled")).toBe(false);
});

test("a stale invocation's picker is cancelled without opening", async () => {
    const { rt } = fixture();
    const invocation = captureExtensionInvocation(rt);
    rt.conversationGeneration += 1;
    const request = {} as Parameters<typeof requestExtensionPicker>[1];
    const result = await rt.extensionAgentTarget.run(invocation, () =>
        requestExtensionPicker(rt, request, new AbortController().signal));
    expect(result).toEqual({ outcome: "cancelled" });
    expect(rt.pendingExtensionPicker).toBeUndefined();
});
