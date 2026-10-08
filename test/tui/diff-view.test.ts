import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { DiffRenderable, type Renderable, ScrollBoxRenderable } from "@opentui/core";
import { createDiffView } from "../../extensions/diff/view.ts";
import { createTuiExperimentalHost } from "../../clients/tui/experimental-tui-host.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";
import type { WorkspaceDiff, Worktree } from "../../extensions/diff/model.ts";
import { createWorktreePicker } from "../../extensions/diff/worktrees.ts";

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
            expect(view.onKey({ name: "d", chord: "ctrl+d", ctrl: true, meta: false, shift: false })).toBe(true);
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

const press = (name: string) => ({ name, chord: name, ctrl: false, meta: false, shift: false });

test("diff names the worktree it shows, offers w only when there is another worktree, and says so when clean", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    let chosen = 0;
    try {
        const clean: WorkspaceDiff = { root: "/workspace", base: "HEAD", files: [] };
        const view = createDiffView(setup.renderer, clean, () => {}, { label: "plunder · feat/plunder · other worktree", chooseWorktree: () => { chosen++; } });
        setup.renderer.root.add(view.root);
        await setup.flush();
        let frame = setup.captureCharFrame();
        expect(frame.split("\n")[0]).toContain("Diff  plunder · feat/plunder · other worktree");
        expect(frame).toContain("No changes in this worktree.");
        expect(frame).toContain("Press w to view another worktree.");
        view.onKey(press("?")); await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("w worktrees");
        for (const line of frame.split("\n")) expect(Bun.stringWidth(line.trimEnd())).toBeLessThanOrEqual(80);
        expect(view.onKey(press("w"))).toBe(true);
        expect(chosen).toBe(1);
        view.root.destroyRecursively();

        const alone = createDiffView(setup.renderer, clean, () => {});
        setup.renderer.root.add(alone.root);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("No changes in this worktree.");
        expect(frame).not.toContain("Press w");
        alone.onKey(press("?")); await setup.flush();
        expect(setup.captureCharFrame()).not.toContain("w worktrees");
    } finally { setup.renderer.destroy(); }
});

test("worktree picker lists worktrees with branch and change counts, marks this session, and keys stay inside it", async () => {
    const setup = await createTestRenderer({ width: 80, height: 16 });
    const worktrees: Worktree[] = [
        { path: "/ship/vera", name: "vera", branch: "main", current: true },
        { path: "/ship/vera/.worktrees/plunder", name: "plunder", branch: "feat/plunder", current: false },
        { path: "/ship/vera/.worktrees/lookout", name: "lookout", head: "abcdef0123456789", current: false },
        { path: "/other/plunder", name: "plunder", branch: "feat/other", current: false },
    ];
    const chosen: number[] = [];
    let back = 0;
    try {
        const picker = createWorktreePicker(setup.renderer, worktrees, { shown: 0, choose: (index) => chosen.push(index), back: () => { back++; } });
        setup.renderer.root.add(picker.root);
        picker.setCount(0, 0); picker.setCount(1, 3); picker.setCount(2, new Error("gone"));
        await setup.flush();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("Choose a worktree");
        expect(frame).toMatch(/› vera · main · this session\s+no changes/);
        picker.onKey(press("down")); await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toMatch(/• vera · main/);
        expect(frame).toMatch(/› plunder · feat\/plunder/);
        picker.onKey(press("up")); await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toMatch(/› vera · main/);
        expect(frame).toMatch(/plunder · feat\/plunder · \/ship\/vera\/\.worktrees\/plunder\s+3 files/);
        expect(frame).toMatch(/lookout · detached at abcdef0\s+unreadable/);
        expect(frame).toMatch(/plunder · feat\/other · \/other\/plunder\s+…/);
        expect(frame).toContain("enter open · esc back");
        picker.onKey(press("up")); picker.onKey(press("down")); picker.onKey(press("down"));
        expect(picker.onKey(press("x"))).toBe(true);
        picker.onKey(press("enter"));
        expect(chosen).toEqual([2]);
        for (let i = 0; i < 6; i++) picker.onKey(press("down"));
        picker.onKey(press("return"));
        expect(chosen).toEqual([2, 3]);
        expect(picker.onKey({ name: "c", chord: "ctrl+c", ctrl: true, meta: false, shift: false })).toBe(false);
        picker.setMessage("Reading plunder…"); await setup.flush();
        expect(setup.captureCharFrame()).toContain("Reading plunder…");
        picker.onKey(press("escape"));
        expect(back).toBe(1);
    } finally { setup.renderer.destroy(); }
});

test("worktree picker keeps the highlighted row on screen when the list is longer than the pane", async () => {
    const setup = await createTestRenderer({ width: 80, height: 12 });
    const worktrees: Worktree[] = Array.from({ length: 30 }, (_, index) => ({
        path: `/ship/wt${index}`, name: `crow${String(index).padStart(2, "0")}`, branch: `feat/crow${index}`, current: index === 20,
    }));
    const highlighted = (): string | undefined => setup.captureCharFrame().match(/› (crow\d\d)/)?.[1];
    try {
        const picker = createWorktreePicker(setup.renderer, worktrees, { shown: 20, choose() {}, back() {} });
        setup.renderer.root.add(picker.root);
        await setup.flush(); await setup.flush();
        expect(highlighted()).toBe("crow20");
        for (let i = 0; i < 9; i++) picker.onKey(press("down"));
        await setup.flush();
        expect(highlighted()).toBe("crow29");
        for (let i = 0; i < 29; i++) picker.onKey(press("up"));
        await setup.flush();
        expect(highlighted()).toBe("crow00");
        expect(setup.captureCharFrame()).toMatch(/Choose a worktree.*\n─+\s*\n\s*\n › crow00/);
        for (let i = 0; i < 8; i++) picker.onKey(press("down"));
        picker.setCount(3, 2);
        await setup.flush();
        expect(highlighted()).toBe("crow08");
    } finally { setup.renderer.destroy(); }
});
