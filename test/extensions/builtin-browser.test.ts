import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseBrowserRequest } from "../../extensions/builtin-browser/arguments.ts";
import { activate } from "../../extensions/builtin-browser/extension.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
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

    test("old extension settings stay separate from the new store", async () => {
        const home = mkdtempSync(join(tmpdir(), "vera-browser-registry-"));
        const oldId = ["vera.desktop", "browser"].join("-");
        const oldDirectory = join(home, "extension-data", oldId);
        const oldSettings = join(oldDirectory, "settings.json");
        const newSettings = join(home, "extension-data", "vera.builtin-browser", "settings.json");
        mkdirSync(oldDirectory, { recursive: true });
        writeFileSync(oldSettings, JSON.stringify({ enabled: true }));
        const options = {
            extensions: [{ path: join(import.meta.dir, "../../extensions/builtin-browser"), enabled: true, config: {} }],
            storageRoots: { profile: home, machine: join(home, "machine") },
        };
        const signal = new AbortController().signal;
        try {
            const registry = await startExtensionRegistry(options);
            try {
                expect(await registry.handleRequest("vera.builtin-browser", "settings", {}, signal)).toEqual({ enabled: false });
                expect(existsSync(newSettings)).toBe(false);
                expect(await registry.handleRequest("vera.builtin-browser", "settings", { enabled: true }, signal)).toEqual({ enabled: true });
                expect(JSON.parse(readFileSync(newSettings, "utf8"))).toEqual({ enabled: true });
                expect(JSON.parse(readFileSync(oldSettings, "utf8"))).toEqual({ enabled: true });
            } finally { await registry.close(); }
            const restarted = await startExtensionRegistry(options);
            try {
                expect(await restarted.handleRequest("vera.builtin-browser", "settings", {}, signal)).toEqual({ enabled: true });
            } finally { await restarted.close(); }
        } finally { rmSync(home, { recursive: true, force: true }); }
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
            const disabled = await tool!.run({ input: { action: "read" }, workspace: root, signal });
            expect(disabled).toMatchObject({ isError: true, presentation: { kind: "tool_notice", action: "open_browser" } });
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
            const queued = tool!.run({ input: { action: "read" }, workspace: root, signal });
            await handlers.get("settings")!({ enabled: false }, { signal });
            expect(await queued).toEqual(disabled);
            await handlers.get("settings")!({ enabled: true }, { signal });
            const dispatched = tool!.run({ input: { action: "read" }, workspace: root, signal });
            const queuedJob = await handlers.get("poll")!({}, { signal }) as { id: string };
            await handlers.get("reply")!({ id: queuedJob.id, error: disabled.output, errorCode: "browser_tools_off" }, { signal });
            expect(await dispatched).toEqual(disabled);
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
