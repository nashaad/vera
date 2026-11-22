import { expect, jest, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activate } from "../../extensions/builtin-browser/extension.ts";
import { BROWSER_TOOLS_OFF_TEXT } from "../../extensions/builtin-browser/failure.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import type { VeraExtensionApi, VeraExtensionToolSpec } from "../../src/sdk/extensions.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";

type Handler = (payload: JsonValue, context: { signal: AbortSignal }) => JsonValue | Promise<JsonValue>;

function trial() {
    const root = mkdtempSync(join(tmpdir(), "vera-browser-preferences-"));
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, VeraExtensionToolSpec>();
    const descriptions = new Map<string, string>();
    const descriptionCalls: Array<{ name: string; description: string }> = [];
    activate({
        storage: { profile: root },
        requests: { handle: (name: string, handler: Handler) => { handlers.set(name, handler); return () => {}; } },
        tools: {
            register: (tool: VeraExtensionToolSpec) => {
                tools.set(tool.name, tool);
                descriptions.set(tool.name, tool.description);
            },
            setDescription: (name: string, description: string) => {
                descriptionCalls.push({ name, description });
                descriptions.set(name, description);
            },
        },
    } as unknown as VeraExtensionApi);
    const controller = new AbortController();
    return {
        call: (name: string, payload: JsonValue = {}, signal = controller.signal) => handlers.get(name)!(payload, { signal }),
        run: (name: string, input: Readonly<Record<string, unknown>>, signal = controller.signal) =>
            Promise.resolve(tools.get(name)!.run({ input, workspace: root, signal })),
        description: (name: string) => descriptions.get(name),
        descriptionCalls,
        close: () => { controller.abort(); rmSync(root, { recursive: true, force: true }); },
    };
}

const ASK_SENTENCE = "If a tool named browser is also available, ask the user once which browser to use before the first call, and keep the answer for this conversation.";
const PANE_SENTENCE = "If a tool named browser is also available, use this tool unless the user asks for Chrome.";
const CHROME_SENTENCE = "If a tool named browser is also available, use that tool unless the user asks for the Browser pane.";

const offNotice = (text: string) => ({
    output: text,
    isError: true,
    presentation: { kind: "tool_notice", text, action: "open_browser" },
} as const);

test("@core Browser off setting merges and survives a real registry restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-browser-preference-store-"));
    const options = {
        extensions: [{ path: join(import.meta.dir, "../../extensions/builtin-browser"), enabled: true, config: {} }],
        storageRoots: { profile: home, machine: join(home, "machine") },
    };
    const signal = new AbortController().signal;
    const path = join(home, "extension-data", "vera.builtin-browser", "settings.json");
    const description = (registry: Awaited<ReturnType<typeof startExtensionRegistry>>): string | undefined =>
        registry.tools().find((tool) => tool.definition.name === "builtin_browser")?.definition.description;
    try {
        mkdirSync(join(home, "extension-data", "vera.builtin-browser"), { recursive: true });
        writeFileSync(path, JSON.stringify({ enabled: true }));
        let registry = await startExtensionRegistry(options);
        try {
            expect(await registry.handleRequest("vera.builtin-browser", "settings", {}, signal)).toEqual({ enabled: true, offBehavior: "ask", defaultBrowser: "ask" });
            expect(description(registry)).toEndWith(ASK_SENTENCE);
            expect(await registry.handleRequest("vera.builtin-browser", "settings", { offBehavior: "refuse" }, signal)).toEqual({ enabled: true, offBehavior: "refuse", defaultBrowser: "ask" });
            expect(await registry.handleRequest("vera.builtin-browser", "settings", { defaultBrowser: "pane" }, signal)).toEqual({ enabled: true, offBehavior: "refuse", defaultBrowser: "pane" });
            expect(description(registry)).toEndWith(PANE_SENTENCE);
            expect(await registry.handleRequest("vera.builtin-browser", "settings", { enabled: false }, signal)).toEqual({ enabled: false, offBehavior: "refuse", defaultBrowser: "pane" });
            expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabled: false, offBehavior: "refuse", defaultBrowser: "pane" });
        } finally { await registry.close(); }
        registry = await startExtensionRegistry(options);
        try {
            expect(await registry.handleRequest("vera.builtin-browser", "settings", {}, signal)).toEqual({ enabled: false, offBehavior: "refuse", defaultBrowser: "pane" });
            expect(description(registry)).toEndWith(PANE_SENTENCE);
            expect(await registry.handleRequest("vera.builtin-browser", "settings", { offBehavior: "unknown", defaultBrowser: "chrome" }, signal)).toEqual({ enabled: false, offBehavior: "ask", defaultBrowser: "chrome" });
            expect(description(registry)).toEndWith(CHROME_SENTENCE);
            expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabled: false, offBehavior: "ask", defaultBrowser: "chrome" });
        } finally { await registry.close(); }
        writeFileSync(path, JSON.stringify({ enabled: "unknown", offBehavior: "unknown", defaultBrowser: "unknown" }));
        registry = await startExtensionRegistry(options);
        try {
            expect(await registry.handleRequest("vera.builtin-browser", "settings", {}, signal)).toEqual({ enabled: false, offBehavior: "ask", defaultBrowser: "ask" });
            expect(description(registry)).toEndWith(ASK_SENTENCE);
        } finally { await registry.close(); }
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test("@core each default browser value sets one exact closing sentence", async () => {
    const fixture = trial();
    try {
        const ask = fixture.description("builtin_browser")!;
        expect(ask).toEndWith(ASK_SENTENCE);
        const head = ask.slice(0, ask.length - ASK_SENTENCE.length - 1);
        expect(head).toContain("Use the built-in browser, the Browser pane in the Vera desktop window.");
        expect(head).toEndWith("It cannot control Vera's own pages such as Usage.");
        for (const [value, sentence] of [["pane", PANE_SENTENCE], ["chrome", CHROME_SENTENCE], ["ask", ASK_SENTENCE]] as const) {
            expect(await fixture.call("settings", { defaultBrowser: value })).toEqual({ enabled: false, offBehavior: "ask", defaultBrowser: value });
            expect(fixture.description("builtin_browser")).toBe(`${head} ${sentence}`);
        }
    } finally { fixture.close(); }
});

test("@core a changed default browser calls setDescription once and the same value does not", async () => {
    const fixture = trial();
    try {
        expect(fixture.descriptionCalls).toEqual([]);
        await fixture.call("settings", { defaultBrowser: "pane" });
        expect(fixture.descriptionCalls).toEqual([
            { name: "builtin_browser", description: fixture.description("builtin_browser")! },
        ]);
        await fixture.call("settings", { defaultBrowser: "pane" });
        await fixture.call("settings", { enabled: true });
        await fixture.call("settings", { offBehavior: "refuse" });
        expect(fixture.descriptionCalls).toHaveLength(1);
        await fixture.call("settings", { defaultBrowser: "chrome" });
        expect(fixture.descriptionCalls).toHaveLength(2);
        expect(fixture.descriptionCalls[1]?.description).toEndWith(CHROME_SENTENCE);
    } finally { fixture.close(); }
});

test("@core Browser asks need a desktop and Refuse keeps the existing failure", async () => {
    const fixture = trial();
    try {
        expect(await fixture.call("settings")).toEqual({ enabled: false, offBehavior: "ask", defaultBrowser: "ask" });
        for (const [name, input] of [
            ["builtin_browser", { action: "back" }],
            ["builtin_browser_eval", { script: "return 1" }],
        ] as const) {
            expect(await fixture.run(name, input)).toEqual({ output: "Open the desktop window to use browser tools.", isError: true });
        }
        await fixture.call("settings", { offBehavior: "refuse" });
        expect(await fixture.run("builtin_browser", { action: "back" })).toEqual(offNotice(BROWSER_TOOLS_OFF_TEXT));
        expect(await fixture.run("builtin_browser_eval", { script: "return 1" })).toEqual(offNotice(BROWSER_TOOLS_OFF_TEXT));
    } finally { fixture.close(); }
});

test("@core Browser and eval share one enable ask and continue after approval", async () => {
    const fixture = trial();
    try {
        const poll = fixture.call("poll");
        const browser = fixture.run("builtin_browser", { action: "back" });
        const evaluate = fixture.run("builtin_browser_eval", { script: "return 1" });
        const ask = await poll as { id: string; request: { action: string } };
        expect(ask.request).toEqual({ action: "enable_tools" });
        const noExtraAsk = new AbortController();
        let extra = false;
        const pendingPoll = Promise.resolve(fixture.call("poll", {}, noExtraAsk.signal)).then((value) => { extra = value !== null; return value; });
        await Promise.resolve();
        expect(extra).toBe(false);
        noExtraAsk.abort();
        expect(await pendingPoll).toBeNull();
        expect(await fixture.call("reply", { id: ask.id, approved: "yes" })).toBe(false);
        await fixture.call("settings", { enabled: true });
        expect(await fixture.call("reply", { id: ask.id, approved: true })).toBe(true);
        const first = await fixture.call("poll") as { id: string; request: { action: string } };
        const second = await fixture.call("poll") as { id: string; request: { action: string } };
        expect([first.request.action, second.request.action].sort()).toEqual(["back", "eval"]);
        for (const job of [first, second]) {
            await fixture.call("reply", { id: job.id, output: job.request.action === "eval" ? "1" : "Back" });
        }
        expect(await browser).toEqual({ output: "Back" });
        expect(await evaluate).toEqual({ output: "1" });
    } finally { fixture.close(); }
});

test("@core declining a shared Browser ask fails both calls with the off notice", async () => {
    const fixture = trial();
    try {
        const poll = fixture.call("poll");
        const browser = fixture.run("builtin_browser", { action: "back" });
        const evaluate = fixture.run("builtin_browser_eval", { script: "return 1" });
        const ask = await poll as { id: string };
        await fixture.call("reply", { id: ask.id, approved: false });
        const denied = offNotice("The user kept Browser tools off.");
        expect(await browser).toEqual(denied);
        expect(await evaluate).toEqual(denied);
        expect(await fixture.call("settings")).toEqual({ enabled: false, offBehavior: "ask", defaultBrowser: "ask" });
    } finally { fixture.close(); }
});

test("@core cancelling one Browser call leaves the shared ask for the other", async () => {
    const fixture = trial();
    const stopped = new AbortController();
    try {
        const poll = fixture.call("poll");
        const browser = fixture.run("builtin_browser", { action: "back" }, stopped.signal);
        const evaluate = fixture.run("builtin_browser_eval", { script: "return 1" });
        const ask = await poll as { id: string };
        stopped.abort();
        expect(await browser).toEqual({ output: "Browser request cancelled.", isError: true });
        await fixture.call("settings", { enabled: true });
        expect(await fixture.call("reply", { id: ask.id, approved: true })).toBe(true);
        const job = await fixture.call("poll") as { id: string; request: { action: string } };
        expect(job.request.action).toBe("eval");
        await fixture.call("reply", { id: job.id, output: "1" });
        expect(await evaluate).toEqual({ output: "1" });
    } finally { fixture.close(); }
});

test("@core stopping the last Browser caller cancels its delivered ask", async () => {
    const fixture = trial();
    const stopped = new AbortController();
    try {
        const poll = fixture.call("poll");
        const running = fixture.run("builtin_browser", { action: "back" }, stopped.signal);
        const ask = await poll as { id: string };
        stopped.abort();
        expect(await running).toEqual({ output: "Browser request cancelled.", isError: true });
        expect(await fixture.call("poll")).toEqual({ cancel: ask.id });
        expect(await fixture.call("reply", { id: ask.id, approved: true })).toBe(false);
    } finally { fixture.close(); }
});

test("@core the Browser enable ask uses the existing bounded queue", async () => {
    const fixture = trial();
    try {
        await fixture.call("settings", { enabled: true });
        const initialPoll = fixture.call("poll");
        const running = Array.from({ length: 8 }, () => fixture.run("builtin_browser", { action: "back" }));
        const delivered = [await initialPoll as { id: string }];
        for (let i = 1; i < 8; i++) delivered.push(await fixture.call("poll") as { id: string });
        await fixture.call("settings", { enabled: false });
        expect((await Promise.all(running)).every((result) => result.isError)).toBe(true);
        expect(await fixture.run("builtin_browser", { action: "back" })).toEqual({ output: "The browser is busy.", isError: true });
        expect(await fixture.call("poll")).toEqual({ cancel: delivered[0]!.id });
        const asked = fixture.run("builtin_browser", { action: "back" });
        for (const job of delivered.slice(1)) expect(await fixture.call("poll")).toEqual({ cancel: job.id });
        const ask = await fixture.call("poll") as { id: string; request: { action: string } };
        expect(ask.request).toEqual({ action: "enable_tools" });
        await fixture.call("reply", { id: ask.id, approved: false });
        expect(await asked).toEqual(offNotice("The user kept Browser tools off."));
    } finally { fixture.close(); }
});

test("@core the Browser enable ask expires after ten minutes and cancels the notice", async () => {
    const fixture = trial();
    jest.useFakeTimers();
    try {
        const poll = fixture.call("poll");
        const running = fixture.run("builtin_browser_eval", { script: "return 1" });
        const ask = await poll as { id: string };
        let settled = false;
        void running.then(() => { settled = true; });
        jest.advanceTimersByTime(599_999);
        await Promise.resolve();
        expect(settled).toBe(false);
        jest.advanceTimersByTime(1);
        expect(await running).toEqual(offNotice("The user did not answer within 10 minutes, so Browser tools are still off."));
        expect(await fixture.call("poll")).toEqual({ cancel: ask.id });
        expect(await fixture.call("reply", { id: ask.id, approved: true })).toBe(false);
    } finally { fixture.close(); jest.useRealTimers(); }
});
