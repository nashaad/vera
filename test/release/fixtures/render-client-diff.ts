import assert from "node:assert/strict";
import { createTestRenderer } from "@opentui/core/testing";
import { startClientExtensionRegistry } from "../../../src/extensions/client-registry.ts";
import { createTuiExperimentalHost } from "../../../clients/tui/experimental-tui-host.ts";
import { VERA_TUI_THEME } from "../../../clients/tui/theme.ts";
import { resolve } from "node:path";

const workspace = Bun.argv[2]!;
const setup = await createTestRenderer({ width: 120, height: 38 });
const failures: string[] = [];
const host = createTuiExperimentalHost({
    renderer: setup.renderer, theme: VERA_TUI_THEME, workspace: () => workspace,
    transcript: () => [], onFailure: (_id, message) => failures.push(message), onRenderRequested() {},
});
try {
    for (let load = 0; load < 2; load++) {
        const registry = await startClientExtensionRegistry({
            extensions: [{ path: resolve(import.meta.dir, "../../../extensions/diff"), enabled: true, config: {} }],
            preferences: { async get() { return undefined; }, async set() {}, async delete() {} },
            modelSettings: { current: () => undefined, async update() { return { status: "rejected", reason: "unavailable" }; }, subscribe: () => () => {} },
            picker: { async request() { return { outcome: "cancelled" }; } },
            notice: { post() {} }, experimentalTui: host.adapter,
            onFailure: (failure) => failures.push(failure.message),
        });
        const controller = new AbortController();
        let result: unknown;
        const invocation = registry.invokeCommand("diff", "", workspace, controller.signal).then((value) => { result = value; });
        try {
            let frame = "";
            for (let attempt = 0; attempt < 100; attempt++) {
                await Bun.sleep(25); host.render(); await setup.flush();
                frame = setup.captureCharFrame();
                if (frame.includes("hello from workspace") || result !== undefined) break;
            }
            assert.equal(result, undefined, JSON.stringify(result));
            assert.equal(host.hasModal(), true);
            assert.match(frame, /Diff  working tree/);
            assert.match(frame, /hello from workspace/);
            assert.deepEqual(failures, []);
        } finally {
            host.handleKey({ name: "escape" });
            await invocation; controller.abort(); await registry.close(); host.render();
        }
        assert.equal(host.hasModal(), false);
    }
    console.log("diff mounted and reloaded");
} finally { await host.close(); setup.renderer.destroy(); }
