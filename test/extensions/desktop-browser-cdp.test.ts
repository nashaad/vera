import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserCdp, NO_WEB_PAGE_ERROR } from "../../clients/desktop/src/browser/cdp.ts";
import type { BrowserPane } from "../../clients/desktop/src/browser/pane.ts";
import type { BrowserRequest } from "../../extensions/desktop-browser/arguments.ts";
import { activate } from "../../extensions/desktop-browser/extension.ts";
import type { VeraExtensionApi, VeraExtensionToolSpec } from "../../src/sdk/extensions.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";

describe("desktop browser without a web page", () => {
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
