import { expect, test } from "bun:test";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { createDragShield } from "../../clients/tui/drag-shield.ts";

// A panel whose rows are rebuilt on every drag step, like the session rail.
async function rebuildingPanel() {
    const setup = await createTestRenderer({ width: 60, height: 10 });
    const panel = new BoxRenderable(setup.renderer, { width: 30, height: 10 });
    let row: TextRenderable | undefined;
    const rebuild = (): void => {
        row?.destroyRecursively();
        row = new TextRenderable(setup.renderer, { content: "row".repeat(10), width: "100%", height: 10 });
        panel.add(row);
    };
    rebuild();
    setup.renderer.root.add(panel);
    await setup.renderOnce();
    return { setup, rebuild };
}

test("the shield keeps every drag step and the release", async () => {
    const { setup, rebuild } = await rebuildingPanel();
    const shield = createDragShield(setup.renderer);
    setup.renderer.root.add(shield.box);
    const seen: number[] = [];
    let released = 0;
    await setup.mockMouse.pressDown(29, 2);
    shield.begin({
        drag: (column) => {
            seen.push(column);
            rebuild();
        },
        release: () => released++,
    });
    await setup.renderOnce();
    for (const x of [25, 20, 15]) {
        await setup.mockMouse.emitMouseEvent("drag", x, 2);
        await setup.renderOnce();
    }
    await setup.mockMouse.release(15, 2);
    expect(seen).toEqual([25, 20, 15]);
    expect(released).toBe(1);
    expect(shield.dragging()).toBe(false);
    expect(shield.box.visible).toBe(false);
    setup.renderer.destroy();
});

test("a press and release with no motion still ends the drag", async () => {
    const { setup } = await rebuildingPanel();
    const shield = createDragShield(setup.renderer);
    setup.renderer.root.add(shield.box);
    let released = 0;
    shield.begin({ drag: () => {}, release: () => released++ });
    await setup.renderOnce();
    await setup.mockMouse.release(29, 2);
    expect(released).toBe(1);
    expect(shield.dragging()).toBe(false);
    setup.renderer.destroy();
});
