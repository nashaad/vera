import { expect, test } from "bun:test";
import { join } from "node:path";

import type { ExtensionOneshotCall } from "../../src/extensions/host-services.ts";
import { SHIPPED_EXTENSIONS_DIRECTORY } from "../../src/extensions/included.ts";
import { notifyTurnFinished } from "../../src/extensions/host-services.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import type { TurnFinishedHookPayload } from "../../src/sdk/hooks.ts";
import {
    cleanTitle,
    TITLE_PROMPT,
    titleMessages,
    wantsTitle,
} from "../../extensions/titles/titles.ts";

const first: TurnFinishedHookPayload = {
    type: "turn_finished",
    sessionId: "session-1",
    workspace: "/deck",
    outcome: "completed",
    turns: 1,
    spawned: false,
    prompt: "  teach the crow to pick the brig's lock  ",
    reply: "Aye. Start with the tumblers.",
};

test("only a completed first turn the user started asks for a title", () => {
    expect(wantsTitle(first)).toBe(true);
    expect(wantsTitle({ ...first, turns: 2 })).toBe(false);
    expect(wantsTitle({ ...first, spawned: true })).toBe(false);
    expect(wantsTitle({ ...first, outcome: "aborted" })).toBe(false);
    expect(wantsTitle({ ...first, outcome: "error" })).toBe(false);
    expect(wantsTitle({ ...first, prompt: "   " })).toBe(false);
});

test("the request holds the prompt and the start of the reply", () => {
    expect(titleMessages(first)).toEqual([{
        role: "user",
        text: "User:\nteach the crow to pick the brig's lock\n\nAssistant:\nAye. Start with the tumblers.",
    }]);
    expect(titleMessages({ ...first, reply: "" })).toEqual([{
        role: "user",
        text: "User:\nteach the crow to pick the brig's lock",
    }]);
    const long = titleMessages({ ...first, prompt: "p".repeat(5_000), reply: "r".repeat(5_000) });
    expect(long[0]!.text.length).toBeLessThan(3_100);
});

test("titles lose wrapping quotes, labels, and trailing punctuation", () => {
    expect(cleanTitle("\"Picking the Brig Lock.\"")).toBe("Picking the Brig Lock");
    expect(cleanTitle("Title: Crow lockpicking lessons!")).toBe("Crow lockpicking lessons");
    expect(cleanTitle("\n  **Shiny button heist**  \nmore text")).toBe("Shiny button heist");
    expect(cleanTitle("v2.0 release")).toBe("v2.0 release");
    expect(cleanTitle("  \n  ")).toBeUndefined();
    expect(cleanTitle("\"...\"")).toBeUndefined();
    expect(cleanTitle("x".repeat(200))).toHaveLength(80);
});

test("the included extension titles a first turn through the snappy slot", async () => {
    const calls: ExtensionOneshotCall[] = [];
    const titles: Array<[string, string]> = [];
    const failures: string[] = [];
    const registry = await startExtensionRegistry({
        extensions: [{ path: join(SHIPPED_EXTENSIONS_DIRECTORY, "titles"), enabled: true, config: {} }],
        onFailure: (failure) => failures.push(failure.message),
    });
    try {
        registry.bindHost({
            async oneshot(call) {
                calls.push(call);
                return { text: "\"Brig lock lessons.\"", model: "crow-mini" };
            },
            async setSessionTitle(sessionId, title) {
                titles.push([sessionId, title]);
                return "set";
            },
        });
        const hooks = registry.turnFinishedHooks();
        const reported: string[] = [];
        notifyTurnFinished(hooks, { ...first, turns: 2 }, (_id, message) => reported.push(message));
        notifyTurnFinished(hooks, first, (_id, message) => reported.push(message));
        await waitFor(() => titles.length === 1);
        expect(failures).toEqual([]);
        expect(reported).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ assignment: "snappy", systemPrompt: TITLE_PROMPT });
        expect(titles).toEqual([["session-1", "Brig lock lessons"]]);
    } finally {
        await registry.close();
    }
});

test("a failed title request is reported, not thrown", async () => {
    const registry = await startExtensionRegistry({
        extensions: [{ path: join(SHIPPED_EXTENSIONS_DIRECTORY, "titles"), enabled: true, config: {} }],
    });
    try {
        let named = false;
        registry.bindHost({
            async oneshot() { throw new Error("No reachable model is assigned to snappy"); },
            async setSessionTitle() { named = true; return "set"; },
        });
        const reported: string[] = [];
        notifyTurnFinished(registry.turnFinishedHooks(), first, (id, message) => reported.push(`${id}: ${message}`));
        await waitFor(() => reported.length === 1);
        expect(reported[0]).toContain("vera.titles: ");
        expect(reported[0]).toContain("snappy");
        expect(named).toBe(false);
    } finally {
        await registry.close();
    }
});

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await Bun.sleep(5);
    }
    throw new Error("Timed out waiting for the condition");
}
