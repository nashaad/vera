import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserCdp, NO_WEB_PAGE_ERROR } from "../../clients/desktop/src/browser/cdp.ts";
import { BrowserHandoff } from "../../clients/desktop/src/browser/handoff.ts";
import type { BrowserPane } from "../../clients/desktop/src/browser/pane.ts";
import type { BrowserRequest } from "../../extensions/builtin-browser/arguments.ts";
import { EVAL_NOT_JSON, EVAL_TIMEOUT_DEFAULT_MS } from "../../extensions/builtin-browser/eval.ts";
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
                tools: { register: (spec: VeraExtensionToolSpec) => { if (spec.name === "builtin_browser") tool = spec; } },
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

    test("@core eval runs the script in an isolated world and returns JSON", async () => {
        const { cdp, calls } = browserWithDebugger((method) => {
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
            if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
            if (method === "Runtime.evaluate") return { result: { value: { kind: "json", json: "\"A crow\"", total: 8 } } };
            throw new Error(`Unexpected command: ${method}`);
        });
        expect(await cdp.run({ action: "eval", script: "return document.title", timeout_ms: 2000 })).toEqual({ output: "\"A crow\"", total: 8 });
        const world = calls.find((call) => call.method === "Page.createIsolatedWorld");
        expect(world?.params).toEqual({ frameId: "frame-1", worldName: "vera-browser" });
        const evaluation = calls.find((call) => call.method === "Runtime.evaluate");
        expect(evaluation?.params?.contextId).toBe(7);
        expect(evaluation?.params?.awaitPromise).toBe(true);
        expect(evaluation?.params?.returnByValue).toBe(true);
        expect(evaluation?.params?.timeout).toBe(3000);
        expect(String(evaluation?.params?.expression)).toContain("return document.title");
        expect(String(evaluation?.params?.expression)).toContain("JSON.stringify");
    });

    test("@core eval uses the default timeout when the request has none", async () => {
        const { cdp, calls } = browserWithDebugger((method) => {
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
            if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
            if (method === "Runtime.evaluate") return { result: { value: { kind: "json", json: "1", total: 1 } } };
            throw new Error(`Unexpected command: ${method}`);
        });
        await cdp.run({ action: "eval", script: "return 1" });
        const evaluation = calls.find((call) => call.method === "Runtime.evaluate");
        expect(evaluation?.params?.timeout).toBe(EVAL_TIMEOUT_DEFAULT_MS + 1000);
    });

    test("@core eval reports a thrown script and a value JSON cannot hold", async () => {
        const thrown = browserWithDebugger((method) => {
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
            if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
            if (method === "Runtime.evaluate") return { result: { value: { kind: "threw", message: "boom" } } };
            throw new Error(`Unexpected command: ${method}`);
        });
        expect(await thrown.cdp.run({ action: "eval", script: "throw new Error('boom')" })).toEqual({ error: "The script threw: boom" });

        const notJson = browserWithDebugger((method) => {
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
            if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
            if (method === "Runtime.evaluate") return { result: { value: { kind: "notJson" } } };
            throw new Error(`Unexpected command: ${method}`);
        });
        expect(await notJson.cdp.run({ action: "eval", script: "return () => 1" })).toEqual({ error: EVAL_NOT_JSON });
    });

    test("@core eval maps a CDP exception and stops a script past its timeout", async () => {
        const failed = browserWithDebugger((method) => {
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
            if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
            if (method === "Runtime.evaluate") return { exceptionDetails: { exception: { description: "Error: kaboom\n    at <anonymous>:1:1" } } };
            throw new Error(`Unexpected command: ${method}`);
        });
        expect(await failed.cdp.run({ action: "eval", script: "throw new Error('kaboom')" })).toEqual({ error: "The script threw: kaboom" });

        const slow = browserWithDebugger((method) => {
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
            if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
            if (method === "Runtime.evaluate") return new Promise(() => {});
            if (method === "Runtime.terminateExecution") return {};
            throw new Error(`Unexpected command: ${method}`);
        });
        expect(await slow.cdp.run({ action: "eval", script: "while (true) {}", timeout_ms: 20 })).toEqual({ error: "The script did not finish within 0.02 seconds." });
        expect(slow.calls.map((call) => call.method)).toContain("Runtime.terminateExecution");
    });

    test("@core handoff and CDP reject the same missing page", async () => {
        const pane = { current: () => undefined, state: () => ({ active: null }) } as unknown as BrowserPane;
        expect(() => new BrowserHandoff(pane, () => {}).start("handoff", "Complete the check")).toThrow(NO_WEB_PAGE_ERROR);
        await expect(new BrowserCdp(pane).run({ action: "read" })).rejects.toThrow(NO_WEB_PAGE_ERROR);
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

interface DebuggerCall {
    readonly method: string;
    readonly params?: Record<string, unknown>;
}

function browserWithDebugger(respond: (method: string, params?: Record<string, unknown>) => unknown): { cdp: BrowserCdp; calls: DebuggerCall[] } {
    const calls: DebuggerCall[] = [];
    const contents = {
        id: 1,
        isDestroyed: () => false,
        getURL: () => "https://example.org/",
        getTitle: () => "Example",
        on: () => {},
        debugger: {
            attach: () => {},
            detach: () => {},
            isAttached: () => true,
            sendCommand: async (method: string, params?: Record<string, unknown>) => {
                calls.push({ method, params });
                return await respond(method, params);
            },
        },
    };
    const pane = { current: () => contents } as unknown as BrowserPane;
    return { cdp: new BrowserCdp(pane), calls };
}
