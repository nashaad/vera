import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { DiffRenderable, type Renderable, ScrollBoxRenderable } from "@opentui/core";
import { createDiffView } from "../../extensions/diff/view.ts";
import { createTuiExperimentalHost } from "../../clients/tui/experimental-tui-host.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";
import type { WorkspaceDiff } from "../../extensions/diff/model.ts";

const snapshot: WorkspaceDiff = {
    root: "/workspace", base: "HEAD",
    files: ["src/alpha.ts", "src/beta.ts"].map((path) => ({ path, status: "Modified", additions: 1, deletions: 1, binary: false, untracked: false })),
};
const patch = (word: string): string => `--- a/src/${word}.ts\n+++ b/src/${word}.ts\n@@ -1,1 +1,1 @@\n-old ${word}\n+new ${word}\n`;
function descendants(root: Renderable): Renderable[] { return root.getChildren().flatMap((child) => [child, ...descendants(child)]); }

for (const width of [80, 120, 160]) {
    test(`diff keeps a right file tree beside patches at ${width} columns`, async () => {
        const setup = await createTestRenderer({ width, height: 30 });
        let closed = false;
        const view = createDiffView(setup.renderer, snapshot, () => { closed = true; });
        setup.renderer.root.add(view.root);
        const key = (name: string): void => { view.onKey({ name, chord: name, ctrl: false, meta: false, shift: false }); };
        try {
            view.setPatch(0, patch("alpha")); view.setPatch(1, patch("beta"));
            await setup.flush(); await Bun.sleep(50); await setup.flush();
            let frame = setup.captureCharFrame();
            expect(frame).toContain("working tree");
            expect(frame).toContain("old alpha");
            expect(frame).toContain("new beta");
            const nodes = descendants(view.root);
            const files = nodes.find((node) => node.id === "diff-files")!;
            const patches = nodes.find((node) => node.id === "diff-patches")!;
            expect(files.x).toBeGreaterThan(patches.x);
            expect(files.width).toBe(32);
            expect(files.x + files.width).toBe(width);
            const diffs = nodes.filter((node): node is DiffRenderable => node instanceof DiffRenderable);
            expect(diffs).toHaveLength(2);
            expect(diffs[0]!.view).toBe(width >= 135 ? "split" : "unified");
            key("tab");
            await setup.flush();
            frame = setup.captureCharFrame();
            expect(frame).toContain("alpha.ts");
            expect(frame).toContain("beta.ts");
            expect(frame).toContain("[Files]");
            key("down"); key("enter");
            await setup.flush();
            expect(setup.captureCharFrame()).toContain("›");
            expect((patches as ScrollBoxRenderable).scrollTop).toBeGreaterThanOrEqual(0);
            key("s"); await setup.flush();
            frame = setup.captureCharFrame();
            expect(frame).toContain("new beta");
            expect(frame).not.toContain("old alpha");
            expect(view.onKey({ name: "c", chord: "ctrl+c", ctrl: true, meta: false, shift: false })).toBe(false);
            expect(view.onKey({ name: "f", chord: "ctrl+f", ctrl: true, meta: false, shift: false })).toBe(true);
            key("escape"); expect(closed).toBe(true);
        } finally { setup.renderer.destroy(); }
    });
}

test("full-screen extension overlays mount without dialog chrome and dispose cleanly", async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const failures: string[] = [];
    const host = createTuiExperimentalHost({ renderer: setup.renderer, theme: VERA_TUI_THEME, workspace: () => "/workspace", transcript: () => [], onFailure: (_id, message) => failures.push(message), onRenderRequested() {} });
    try {
        const dispose = host.adapter.mountRenderable("fixture", { id: "diff", slot: "overlay", fullscreen: true, modal: true, create({ renderer }) { return createDiffView(renderer, snapshot, () => {}).root; } });
        host.render(); await setup.flush();
        expect(host.hasModal()).toBe(true);
        expect(setup.captureCharFrame().split("\n")[0]).toContain("Diff");
        expect(setup.captureCharFrame()).not.toContain("Extension");
        await dispose(); host.render(); await setup.flush();
        expect(host.hasModal()).toBe(false);
        expect(setup.captureCharFrame()).not.toContain("working tree");
        expect(failures).toEqual([]);
    } finally { await host.close(); setup.renderer.destroy(); }
});
