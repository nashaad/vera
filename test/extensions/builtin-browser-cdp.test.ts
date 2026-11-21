import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserCdp, NO_WEB_PAGE_ERROR } from "../../clients/desktop/src/browser/cdp.ts";
import type { BrowserPane } from "../../clients/desktop/src/browser/pane.ts";
import type { BrowserRequest } from "../../extensions/builtin-browser/arguments.ts";
import { activate } from "../../extensions/builtin-browser/extension.ts";
import type { VeraExtensionApi, VeraExtensionToolSpec } from "../../src/sdk/extensions.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";

describe("built-in browser without a web page", () => {
    test("returns the CDP error through the tool call", async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-browser-cdp-"));
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
            const context = { signal: controller.signal };
            await handlers.get("settings")!({ enabled: true }, context);
            const polling = handlers.get("poll")!({}, context);
            const running = tool!.run({ input: { action: "read" }, workspace: root, signal: controller.signal });
            const job = await polling as unknown as { id: string; request: BrowserRequest };
            const pane = { current: () => undefined } as unknown as BrowserPane;
            const cdp = new BrowserCdp(pane);
            const error: unknown = await cdp.run(job.request).then(() => undefined, (reason: unknown) => reason);
            expect(error).toBeInstanceOf(Error);
            if (!(error instanceof Error)) throw new Error("Expected a browser error");
            expect(error.message).toBe(NO_WEB_PAGE_ERROR);
            expect(await handlers.get("reply")!({ id: job.id, error: error.message }, context)).toBe(true);
            expect(await running).toEqual({ output: NO_WEB_PAGE_ERROR, isError: true });
        } finally {
            controller.abort();
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("returns the same error for destroyed web contents", async () => {
        const pane = { current: () => ({ isDestroyed: () => true }) } as unknown as BrowserPane;
        await expect(new BrowserCdp(pane).run({ action: "read" })).rejects.toThrow(NO_WEB_PAGE_ERROR);
    });

    test("@core read returns bounded HTML, existing controls, and human-check state", async () => {
        const commands: { method: string; params?: Record<string, unknown> }[] = [];
        let evaluationCount = 0;
        const debuggerApi = {
            attach: () => {},
            detach: () => {},
            isAttached: () => true,
            sendCommand: async (method: string, params?: Record<string, unknown>) => {
                commands.push({ method, params });
                if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
                if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
                if (method === "Runtime.evaluate") {
                    evaluationCount++;
                    return evaluationCount === 1 ? { result: { objectId: "controls" } } : {
                        result: { value: { html: "<html>bounded</html>", htmlTruncated: false, humanCheck: true } },
                    };
                }
                if (method === "Runtime.getProperties") return { result: [{ name: "0", value: { objectId: "link" } }] };
                if (method === "Accessibility.getPartialAXTree") return { nodes: [{ backendDOMNodeId: 42, role: { value: "link" }, name: { value: "Treasure Map" } }] };
                return {};
            },
        };
        const contents = {
            id: 1,
            debugger: debuggerApi,
            isDestroyed: () => false,
            getURL: () => "https://example.org/",
            getTitle: () => "Example",
            on: () => {},
        };
        const pane = { current: () => contents } as unknown as BrowserPane;
        const result = await new BrowserCdp(pane).run({ action: "read" });
        expect(result).toEqual({ url: "https://example.org/", title: "Example", html: "<html>bounded</html>", htmlTruncated: false, controls: ["r1 link Treasure Map"], humanCheck: true });
        const readExpression = String(commands.find((command) => command.method === "Runtime.evaluate" && command.params?.returnByValue)?.params?.expression);
        const evaluateInFixture = (outerHTML: string, title = "", frameSources: string[] = []) => {
            const fixtureDocument = {
                documentElement: { outerHTML },
                title,
                querySelectorAll: () => frameSources.map((src) => ({ src })),
            };
            return Function("document", "location", `return ${readExpression}`)(fixtureDocument, { href: "https://example.org/" }) as { html: string; htmlTruncated: boolean; humanCheck: boolean };
        };
        const cap = 2 * 1024 * 1024;
        const bounded = evaluateInFixture(`<html>${"é".repeat(cap)}tail</html>`);
        expect(new TextEncoder().encode(bounded.html)).toHaveLength(cap);
        expect(bounded.html.endsWith("é")).toBe(true);
        expect(bounded.htmlTruncated).toBe(true);
        expect(bounded.humanCheck).toBe(false);
        expect(evaluateInFixture("a".repeat(cap)).htmlTruncated).toBe(false);
        expect(evaluateInFixture(`${"a".repeat(cap)}a`).htmlTruncated).toBe(true);
        for (const source of [
            "https://www.google.com/recaptcha/api2/anchor",
            "https://newassets.hcaptcha.com/captcha/v1/",
            "https://challenges.cloudflare.com/turnstile/v0/api.js",
        ]) expect(evaluateInFixture("<html></html>", "", [source]).humanCheck).toBe(true);
        expect(evaluateInFixture("<html><div id='cf-challenge'></div></html>", "Just a moment").humanCheck).toBe(true);
        expect(evaluateInFixture(`${"a".repeat(cap)}<div id='cf-challenge'></div>`).humanCheck).toBe(true);
        expect(evaluateInFixture("<html><script>window._cf_chl_opt = {};</script></html>").humanCheck).toBe(true);
        const ordinaryCloudflare = "<html><head><script src='/cdn-cgi/challenge-platform/scripts/jsd/main.js'></script>"
            + "<script>window.__CF$cv$params = {};</script></head><body>ordinary</body></html>";
        expect(evaluateInFixture(ordinaryCloudflare).humanCheck).toBe(false);
        expect(evaluateInFixture("<html>ordinary</html>", "Just a moment").humanCheck).toBe(false);
        expect(evaluateInFixture("<html>ordinary</html>", "", ["https://hcaptcha.com.example.org/", "http://["]).humanCheck).toBe(false);
        const split = evaluateInFixture(`${"a".repeat(cap - 1)}😀`);
        expect(split.html).toBe("a".repeat(cap - 1));
        expect(commands.filter((command) => command.method === "Runtime.evaluate")).toHaveLength(2);
    });

    test("open creates a tab and navigates when none is active", async () => {
        let current: Electron.WebContents | undefined;
        let opened = 0;
        let navigated: string | undefined;
        const pane = {
            current: () => current,
            open: () => { opened += 1; current = {} as Electron.WebContents; return opened; },
            navigate: async (url: string) => { navigated = url; },
        } as unknown as BrowserPane;
        const url = "https://example.org/";
        expect(await new BrowserCdp(pane).run({ action: "open", url })).toEqual({ output: `Opened ${url}` });
        expect(opened).toBe(1);
        expect(navigated).toBe(url);
    });
});
