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

    test("@core validates actions and bounds", () => {
        expect(parseBrowserRequest({ action: "read" })).toEqual({ action: "read" });
        expect(parseBrowserRequest({ action: "open", url: "file:///etc/passwd" })).toBeUndefined();
        expect(parseBrowserRequest({ action: "open", url: "https://example.org/" })?.action).toBe("open");
        expect(parseBrowserRequest({ action: "click", ref: "r12" })?.ref).toBe("r12");
        expect(parseBrowserRequest({ action: "click", ref: "body" })).toBeUndefined();
        expect(parseBrowserRequest({ action: "type", ref: "r1", text: "x".repeat(4001) })).toBeUndefined();
        expect(parseBrowserRequest({ action: "scroll", amount: 2001 })).toBeUndefined();
        expect(parseBrowserRequest({ action: "read", code: "x" })).toBeUndefined();
        expect(parseBrowserRequest({ action: "read", offset: 0 })).toEqual({ action: "read", offset: 0 });
        expect(parseBrowserRequest({ action: "read", offset: 10_000_000 })).toEqual({ action: "read", offset: 10_000_000 });
        for (const offset of [-1, 10_000_001, 1.5, NaN, Infinity, "1", null]) {
            expect(parseBrowserRequest({ action: "read", offset })).toBeUndefined();
        }
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

    test("@core formats markdown and pages it with the supplied offset", async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-browser-read-"));
        const controller = new AbortController();
        try {
            const handlers = new Map<string, (payload: JsonValue, context: { signal: AbortSignal }) => JsonValue | Promise<JsonValue>>();
            let tool: VeraExtensionToolSpec | undefined;
            const api = {
                storage: { profile: root },
                requests: { handle: (name: string, handler: typeof handlers extends Map<string, infer H> ? H : never) => { handlers.set(name, handler); return () => {}; } },
                tools: { register: (spec: VeraExtensionToolSpec) => { tool = spec; } },
            } as unknown as VeraExtensionApi;
            activate(api);
            expect(tool!.inputSchema).toMatchObject({ properties: { offset: { type: "integer", minimum: 0, maximum: 10_000_000 } } });
            const context = { signal: controller.signal };
            await handlers.get("settings")!({ enabled: true }, context);
            interface ReadOptions {
                readonly url?: string;
                readonly title?: string;
                readonly controls?: string[];
                readonly htmlTruncated?: boolean;
            }
            const read = async (html: string, offset = 0, humanCheck = false, options: ReadOptions = {}) => {
                const polling = handlers.get("poll")!({}, context);
                const running = tool!.run({ input: { action: "read", offset }, workspace: root, signal: controller.signal });
                const job = await polling as unknown as { id: string; request: { offset: number } };
                expect(job.request.offset).toBe(offset);
                await handlers.get("reply")!({
                    id: job.id, url: options.url ?? "https://example.org/ship/", title: options.title ?? "Crow", html,
                    htmlTruncated: options.htmlTruncated ?? false,
                    controls: options.controls ?? ["r1 link Map", "r2 button Sail"], humanCheck,
                }, context);
                return (await running).output;
            };
            const page = await read('<h1>Crow</h1><a href="/map">Map</a><table><tr><th>Ship</th><th>Port</th></tr><tr><td>Raven</td><td>Bay</td></tr></table>', 0, true);
            expect(page).toContain("URL: https://example.org/ship/");
            expect(page).toContain("Title: Crow");
            expect(page).toContain("# Crow");
            expect(page).toContain("[Map](https://example.org/map)");
            expect(page).toContain("| Ship | Port |");
            expect(page).toContain("| Raven | Bay |");
            expect(page).toContain("This page shows a human check. Use handoff to ask the user to complete it.");
            expect(page).toContain("Controls:\nr1 link Map\nr2 button Sail");
            const html = `<p>${"x".repeat(50_000)}</p>`;
            const first = await read(html);
            expect(first.length).toBeLessThanOrEqual(30_000);
            const cut = first.match(/Showing characters 0 to (\d+) of 50000\. Next offset: (\d+)\./);
            expect(cut).not.toBeNull();
            const next = Number(cut![1]);
            expect(Number(cut![2])).toBe(next);
            expect(next).toBeGreaterThan(0);
            expect(first).toContain("x".repeat(next));
            expect(first.endsWith("Controls:\nr1 link Map\nr2 button Sail")).toBe(true);
            const last = await read(html, next);
            expect(last.length).toBeLessThanOrEqual(30_000);
            expect(last).toContain("x".repeat(50_000 - next));
            expect(last).not.toContain("Next offset:");
            expect(last).not.toContain("This page shows a human check.");
            for (const offset of [5, 6, 10_000_000]) {
                const atEnd = await read("<p>hello</p>", offset);
                expect(atEnd).toContain("Showing characters 5 to 5 of 5. Next offset: 5.");
                expect(atEnd).not.toContain("hello");
                expect(atEnd).toContain("Controls:\nr1 link Map\nr2 button Sail");
            }
            const htmlCut = await read("<p>hello</p>", 0, false, { htmlTruncated: true });
            expect(htmlCut).toContain("The page HTML is over 2 MiB, so only its first 2 MiB was read.");
            const controls = Array.from({ length: 150 }, (_, index) => `r${index + 1} link ${"a".repeat(200)}`);
            const manyControls = await read("<p>hello</p>", 0, false, { controls });
            expect(manyControls.length).toBeLessThanOrEqual(30_000);
            expect(manyControls).toContain("hello");
            const controlSection = manyControls.split("Controls:\n")[1]!;
            const controlLines = controlSection.split("\n");
            const countLine = controlLines.pop();
            expect(controlLines.join("\n").length).toBeLessThanOrEqual(10_000);
            expect(controlLines).toEqual(controls.slice(0, controlLines.length));
            expect(countLine).toBe(`Showing ${controlLines.length} of 150 controls.`);
            const longWithControls = await read(html, 0, false, { controls });
            const controlsCut = longWithControls.match(/Showing characters 0 to (\d+) of 50000\. Next offset: (\d+)\./);
            expect(controlsCut).not.toBeNull();
            expect(Number(controlsCut![1])).toBeGreaterThan(10_000);
            expect(longWithControls.length).toBeLessThanOrEqual(30_000);
            const oversizedUrl = `https://example.org/${"a".repeat(8192)}/`;
            const longAddressPage = await read('<p>hello <a href="map">Map</a></p>', 0, false, { url: oversizedUrl });
            expect(longAddressPage.length).toBeLessThanOrEqual(30_000);
            expect(longAddressPage).toContain(`URL: ${oversizedUrl.slice(0, 8192)}…`);
            expect(longAddressPage).toContain(`hello [Map](${oversizedUrl}map)`);
            const title = "C".repeat(301);
            const longTitlePage = await read("<p>hello</p>", 0, false, { title });
            expect(longTitlePage).toContain(`Title: ${title.slice(0, 300)}…`);
            const cap = 2 * 1024 * 1024;
            const fullHtml = `<p>${"x".repeat(cap - 7)}</p>`;
            expect(Buffer.byteLength(fullHtml)).toBe(cap);
            const fullPage = await read(fullHtml);
            expect(fullPage).toContain(`of ${cap - 7}. Next offset:`);
            expect(fullPage).not.toContain("The page is too long to read past 10,000,000 characters.");
            const longUrl = `https://example.org/${"a".repeat(4096)}/`;
            const relativeLinks = '<p><a href="crow">Crow</a></p>'.repeat(2800);
            const expanded = await read(relativeLinks, 0, false, { url: longUrl });
            expect(expanded.length).toBeLessThanOrEqual(30_000);
            expect(expanded).toContain("of 10000000. Next offset:");
            expect(expanded).toContain("The page is too long to read past 10,000,000 characters.");
            const endOfExpanded = await read(relativeLinks, 10_000_000, false, { url: longUrl });
            expect(endOfExpanded).toContain("Showing characters 10000000 to 10000000 of 10000000. Next offset: 10000000.");
            expect(endOfExpanded).toContain("The page is too long to read past 10,000,000 characters.");
        } finally {
            controller.abort();
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

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
            expect(await handlers.get("reply")!({
                id: job.id, url: "https://example.org/", title: "Crow", html: "<p>A crow</p>", htmlTruncated: false, controls: [], humanCheck: false,
            }, { signal })).toBe(true);
            const read = await running;
            expect(read.output).toContain("URL: https://example.org/");
            expect(read.output).toContain("Title: Crow");
            expect(read.output).toContain("A crow");
            expect(read.output).toContain("Controls:");
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
