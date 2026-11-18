import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseBrowserRequest } from "../../extensions/desktop-browser/arguments.ts";
import { activate } from "../../extensions/desktop-browser/extension.ts";
import type { VeraExtensionApi, VeraExtensionToolSpec } from "../../src/sdk/extensions.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";

describe("built-in browser requests", () => {
    test("registers only the built-in browser tool name", () => {
        const tools: VeraExtensionToolSpec[] = [];
        const api = {
            storage: { profile: "" },
            requests: { handle() { return () => {}; } },
            tools: { register(spec: VeraExtensionToolSpec) { tools.push(spec); } },
        } as unknown as VeraExtensionApi;

        activate(api);

        const names = tools.map((tool) => tool.name);
        expect(names).toEqual(["builtin_browser"]);
        expect(names).not.toContain("desktop_browser");
    });

    test("validates actions and bounds", () => {
        expect(parseBrowserRequest({ action: "read" })).toEqual({ action: "read" });
        expect(parseBrowserRequest({ action: "open", url: "file:///etc/passwd" })).toBeUndefined();
        expect(parseBrowserRequest({ action: "open", url: "https://example.org/" })?.action).toBe("open");
        expect(parseBrowserRequest({ action: "click", ref: "r12" })?.ref).toBe("r12");
        expect(parseBrowserRequest({ action: "click", ref: "body" })).toBeUndefined();
        expect(parseBrowserRequest({ action: "type", ref: "r1", text: "x".repeat(4001) })).toBeUndefined();
        expect(parseBrowserRequest({ action: "scroll", amount: 2001 })).toBeUndefined();
        expect(parseBrowserRequest({ action: "read", code: "x" })).toBeUndefined();
    });

    test("the switch is off by default, persists, and calls need a window", async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-browser-store-"));
        try {
            const handlers = new Map<string, (payload: JsonValue, context: { signal: AbortSignal }) => JsonValue | Promise<JsonValue>>();
            let tool: VeraExtensionToolSpec | undefined;
            const api = {
                storage: { profile: root },
                requests: { handle: (name: string, handler: typeof handlers extends Map<string, infer H> ? H : never) => { handlers.set(name, handler); return () => {}; } },
                tools: { register: (spec: VeraExtensionToolSpec) => { tool = spec; } },
            } as unknown as VeraExtensionApi;
            activate(api);
            expect(tool!.description.startsWith("Use the built-in browser, the Browser pane in the Vera desktop window.")).toBe(true);
            expect(tool!.description).toContain("It cannot control Vera's own pages such as Usage.");
            expect(tool!.description).toContain("If a tool named browser is also available, ask the user once which browser to use before the first call, and keep the answer for this conversation.");
            const signal = new AbortController().signal;
            const settings = handlers.get("settings")!;
            expect(await settings({}, { signal })).toEqual({ enabled: false });
            expect((await tool!.run({ input: { action: "read" }, workspace: root, signal })).isError).toBe(true);
            expect(await settings({ enabled: true }, { signal })).toEqual({ enabled: true });
            expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8"))).toEqual({ enabled: true });
            expect(statSync(join(root, "settings.json")).mode & 0o777).toBe(0o600);
            activate(api);
            expect(await handlers.get("settings")!({}, { signal })).toEqual({ enabled: true });
            const absent = await tool!.run({ input: { action: "read" }, workspace: root, signal });
            expect(absent.output).toContain("desktop window");
            expect(absent.isError).toBe(true);
            const polling = handlers.get("poll")!({}, { signal });
            const running = tool!.run({ input: { action: "read" }, workspace: root, signal });
            const job = await polling as { id: string; request: { action: string } };
            expect(job.request.action).toBe("read");
            expect(await handlers.get("reply")!({ id: job.id, output: "A crow" }, { signal })).toBe(true);
            expect(await running).toEqual({ output: "A crow" });
            await handlers.get("settings")!({ enabled: false }, { signal });
            await handlers.get("settings")!({ enabled: true }, { signal });
            const waiting = handlers.get("poll")!({}, { signal });
            const pending = new AbortController();
            const calls = Array.from({ length: 8 }, () => tool!.run({ input: { action: "read" }, workspace: root, signal: pending.signal }));
            await waiting;
            const overflow = await tool!.run({ input: { action: "read" }, workspace: root, signal });
            expect(overflow.output).toBe("The browser is busy.");
            expect(overflow.isError).toBe(true);
            pending.abort();
            expect((await Promise.all(calls)).every((result) => result.isError)).toBe(true);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
