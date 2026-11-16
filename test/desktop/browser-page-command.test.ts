import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PageCommandService } from "../../clients/desktop/src/extension-commands/page.ts";

class Contents extends EventEmitter {
    readonly scripts: string[] = [];
    captured: unknown;
    result: unknown = null;
    isDestroyed(): boolean { return false; }
    async executeJavaScriptInIsolatedWorld(world: number, entries: readonly { code: string }[]): Promise<unknown> {
        expect(world).toBe(1004);
        const code = entries[0]!.code;
        this.scripts.push(code);
        return code.includes("delete globalThis") ? undefined : this.result;
    }
    async capturePage(rect: unknown): Promise<unknown> {
        this.captured = rect;
        const image = {
            toPNG: () => Buffer.from("capture"),
            getSize: () => ({ width: 20, height: 30 }),
            resize: () => image,
            toDataURL: () => "data:image/png;base64,Y2FwdHVyZQ==",
        };
        return image;
    }
    contents(): Parameters<PageCommandService["run"]>[1] {
        return this as unknown as Parameters<PageCommandService["run"]>[1];
    }
}

describe("page command boundary", () => {
    test("captures a validated rectangle through the real pasted-image writer", async () => {
        const directory = mkdtempSync(join(tmpdir(), "vera-page-capture-"));
        const contents = new Contents();
        contents.result = { rect: { x: 1.5, y: 2.5, width: 20, height: 30 }, text: "Selection text" };
        try {
            const result = await new PageCommandService().run("pageScript()", contents.contents(), directory);
            expect(result.ok && result.kind).toBe("capture");
            if (!result.ok || result.kind !== "capture") return;
            expect(readFileSync(result.capture.path, "utf8")).toBe("capture");
            expect(contents.captured).toEqual({ x: 2, y: 3, width: 20, height: 30 });
            expect(contents.scripts.at(-1)).toContain("__veraPageCleanup");
            expect(contents.listenerCount("did-start-navigation")).toBe(0);
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });
    test("@core targets a cross-process annex frame by URL and name in an isolated world", async () => {
        const contents = new Contents();
        let attached = false;
        const calls: string[] = [];
        Object.assign(contents, { debugger: {
            isAttached: () => attached,
            attach: () => { attached = true; },
            detach: () => { attached = false; },
            sendCommand: async (method: string, parameters?: Record<string, unknown>, session?: string) => {
                calls.push(method);
                if (method === "Page.getFrameTree") return { frameTree: { frame: session === undefined ? { id: "main", url: "file:///index.html" } : { id: "annex", url: "http://localhost/usage", name: "browser-tab" } } };
                if (method === "Target.getTargets") return { targetInfos: [{ targetId: "annex", type: "iframe", url: "http://localhost/usage" }] };
                if (method === "Target.attachToTarget") return { sessionId: "child" };
                expect(session).toBe("child");
                if (method === "Page.createIsolatedWorld") {
                    expect(parameters?.frameId).toBe("annex");
                    return { executionContextId: 42 };
                }
                expect(parameters?.contextId).toBe(42);
                return { result: { value: null } };
            },
        } });
        expect(await new PageCommandService().run("pageScript()", contents.contents(), "unused", { url: "http://localhost/usage", name: "browser-tab", x: 10, y: 20, width: 300, height: 400 })).toEqual({ ok: true, kind: "closed" });
        expect(calls).toContain("Page.createIsolatedWorld");
        expect(attached).toBe(false);
    });
    test("refuses malformed output before capturing", async () => {
        const contents = new Contents();
        contents.result = { rect: { x: NaN, y: 0, width: 20, height: 30 }, text: "Selection text" };
        expect(await new PageCommandService().run("pageScript()", contents.contents(), "unused")).toEqual({ ok: false, reason: "The page could not be read." });
        expect(contents.captured).toBeUndefined();
        expect(contents.listenerCount("destroyed")).toBe(0);
    });
    test("closing or navigating cancels one pending run and refuses a second", async () => {
        const contents = new Contents();
        contents.result = new Promise(() => {});
        const service = new PageCommandService();
        const pending = service.run("pageScript()", contents.contents(), "unused");
        await Promise.resolve();
        expect(await service.run("otherScript()", contents.contents(), "unused")).toEqual({ ok: true, kind: "closed" });
        contents.emit("did-start-navigation");
        expect(await pending).toEqual({ ok: true, kind: "closed" });
        expect(contents.captured).toBeUndefined();
        expect(contents.listenerCount("did-start-navigation")).toBe(0);
        contents.result = null;
        expect(await service.run("pageScript()", contents.contents(), "unused")).toEqual({ ok: true, kind: "closed" });
    });
});
