import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

interface PageApi {
    annex: { pageUrl(pageId: string): string | undefined };
}

function createPageExtension(): string {
    const directory = join(tmpdir(), `vera-annex-pages-${crypto.randomUUID()}`);
    mkdirSync(directory);
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id: "acme.crow",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: ["tools.register"],
        contributes: {
            pages: [{ id: "loot", label: "Loot", server: "server.ts", browser: "page.ts" }],
        },
    }));
    writeFileSync(join(directory, "extension.ts"), `
        export function activate(vera) {
            globalThis.__pageApi = vera;
            vera.tools.register({
                name: "crow_session",
                description: "Says which session called it",
                inputSchema: { type: "object", properties: {} },
                run: (request) => ({ output: String(request.sessionId) }),
            });
        }
    `);
    writeFileSync(join(directory, "server.ts"), "export function activatePage() {}\n");
    writeFileSync(join(directory, "page.ts"), "export function mount() {}\n");
    return directory;
}

test("pageUrl names a declared page under the annex and is absent while the annex is down", async () => {
    const directory = createPageExtension();
    const registry = await startExtensionRegistry({
        extensions: [{ path: directory, enabled: true, config: null }],
    });
    const api = (globalThis as unknown as { __pageApi: PageApi }).__pageApi;
    let annex: string | undefined;
    registry.bindHost({
        async oneshot() {
            return { text: "", model: "crow-mini" };
        },
        async setSessionTitle() {
            return "set";
        },
        async askSession() {
            return { text: "", model: "crow-mini" };
        },
        async sendToSession() {
            return "queued";
        },
        annexUrl: () => annex,
    });

    expect(api.annex.pageUrl("loot")).toBeUndefined();
    annex = "http://127.0.0.1:4100/";
    expect(api.annex.pageUrl("loot")).toBe("http://127.0.0.1:4100/x/acme.crow/loot");
    expect(() => api.annex.pageUrl("treasure")).toThrow("does not declare page treasure");

    expect(registry.contributions().pages()).toMatchObject([
        { extensionId: "acme.crow", definition: { id: "loot" } },
    ]);
    await registry.close();
});

test("an extension tool learns the session that called it", async () => {
    const registry = await startExtensionRegistry({
        extensions: [{ path: createPageExtension(), enabled: true, config: null }],
    });
    const [tool] = registry.tools();
    const runtime = new ToolRuntime(tmpdir());
    runtime.sessionId = "session-7";
    const result = await tool!.execute({}, runtime, new AbortController().signal);
    expect(result).toMatchObject({ output: "session-7" });

    const anonymous = await tool!.execute({}, new ToolRuntime(tmpdir()), new AbortController().signal);
    expect(anonymous).toMatchObject({ output: "undefined" });
    await registry.close();
});
