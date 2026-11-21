import { expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseBrowserRequest } from "../../extensions/builtin-browser/arguments.ts";
import { activate } from "../../extensions/builtin-browser/extension.ts";
import { HANDOFF_BUSY, HANDOFF_CANCELLED, HANDOFF_TIMED_OUT } from "../../extensions/builtin-browser/handoff.ts";
import type { VeraExtensionApi, VeraExtensionToolSpec } from "../../src/sdk/extensions.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";

type Handler = (payload: JsonValue, context: { signal: AbortSignal }) => JsonValue | Promise<JsonValue>;

function trial() {
    const root = mkdtempSync(join(tmpdir(), "vera-handoff-"));
    const handlers = new Map<string, Handler>();
    let tool: VeraExtensionToolSpec | undefined;
    activate({
        storage: { profile: root },
        requests: { handle: (name: string, handler: Handler) => { handlers.set(name, handler); return () => {}; } },
        tools: { register: (spec: VeraExtensionToolSpec) => { if (spec.name === "builtin_browser") tool = spec; } },
    } as unknown as VeraExtensionApi);
    const controller = new AbortController();
    const context = { signal: controller.signal };
    return {
        tool: tool!,
        call: (name: string, payload: JsonValue = {}, signal = context.signal) => handlers.get(name)!(payload, { signal }),
        run: (input: Readonly<Record<string, unknown>>, signal = controller.signal) => Promise.resolve(tool!.run({ input, workspace: root, signal })),
        close: () => { controller.abort(); rmSync(root, { recursive: true, force: true }); },
    };
}

test("@core handoff validates its reason and exposes a bounded schema", () => {
    expect(parseBrowserRequest({ action: "handoff", reason: "x".repeat(300) })?.reason).toHaveLength(300);
    expect(parseBrowserRequest({ action: "handoff" })).toBeUndefined();
    expect(parseBrowserRequest({ action: "handoff", reason: "  " })).toBeUndefined();
    expect(parseBrowserRequest({ action: "handoff", reason: 1 })).toBeUndefined();
    expect(parseBrowserRequest({ action: "handoff", reason: "x".repeat(301) })).toBeUndefined();
    expect(parseBrowserRequest({ action: "handoff", reason: "check", extra: true })).toBeUndefined();
    const fixture = trial();
    try {
        expect(fixture.tool.timeoutMs).toBeGreaterThan(600_000);
        expect(JSON.stringify(fixture.tool.inputSchema)).toContain('"maxLength":300');
    } finally { fixture.close(); }
});

test("@core handoff has ten minutes while ordinary requests keep their deadline", async () => {
    const fixture = trial();
    jest.useFakeTimers();
    try {
        await fixture.call("settings", { enabled: true });
        const firstPoll = fixture.call("poll");
        const running = fixture.run({ action: "handoff", reason: "Complete the check" });
        const job = await firstPoll as { id: string };
        const refused = await Promise.all(Array.from({ length: 12 }, () => fixture.run({ action: "read" })));
        expect(refused.every((result) => result.output === HANDOFF_BUSY && result.isError === true)).toBe(true);
        let settled = false;
        void running.then(() => { settled = true; });
        jest.advanceTimersByTime(25_000);
        await Promise.resolve();
        expect(settled).toBe(false);
        jest.advanceTimersByTime(575_000);
        expect(await running).toEqual({ output: HANDOFF_TIMED_OUT });
        expect(await fixture.call("poll")).toEqual({ cancel: job.id });
        expect(await fixture.call("reply", { id: job.id, output: "late" })).toBe(false);
        const nextPoll = fixture.call("poll");
        const ordinary = fixture.run({ action: "read" });
        const nextJob = await nextPoll as { id: string };
        jest.advanceTimersByTime(25_000);
        expect(await ordinary).toEqual({ output: "The desktop window did not answer.", isError: true });
        expect(await fixture.call("poll")).toEqual({ cancel: nextJob.id });
    } finally { fixture.close(); jest.useRealTimers(); }
});

test("@core delivered handoffs notify the desktop on abort and switch-off", async () => {
    const fixture = trial();
    try {
        await fixture.call("settings", { enabled: true });
        const firstPoll = fixture.call("poll");
        const turn = new AbortController();
        const running = fixture.run({ action: "handoff", reason: "Complete the check" }, turn.signal);
        const job = await firstPoll as { id: string };
        const poll = new AbortController();
        const interrupted = fixture.call("poll", {}, poll.signal);
        poll.abort();
        expect(await interrupted).toBeNull();
        turn.abort();
        expect(await running).toEqual({ output: HANDOFF_CANCELLED });
        expect(await fixture.call("poll", {}, poll.signal)).toBeNull();
        expect(await fixture.call("poll")).toEqual({ cancel: job.id });
        expect(await fixture.call("reply", { id: job.id, output: "late" })).toBe(false);

        const secondPoll = fixture.call("poll");
        const switched = fixture.run({ action: "handoff", reason: "Complete the check" });
        const second = await secondPoll as { id: string };
        const waitingAgain = fixture.call("poll");
        await fixture.call("settings", { enabled: false });
        expect(await switched).toEqual({ output: HANDOFF_CANCELLED });
        expect(await waitingAgain).toEqual({ cancel: second.id });
    } finally { fixture.close(); }
});
