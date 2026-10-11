import { expect, test } from "bun:test";
import { BoxRenderable, CliRenderEvents, type Selection, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { createClickCounter, expandClick } from "../../clients/tui/multi-click.ts";

// "the pirate crow " / "sails at dawn " / "tonight" wrap from one source line.
async function crowText() {
    const setup = await createTestRenderer({ width: 40, height: 10 });
    const box = new BoxRenderable(setup.renderer, { width: 20, height: 10, paddingLeft: 2, paddingTop: 1 });
    const text = new TextRenderable(setup.renderer, {
        content: "the pirate crow sails at dawn tonight\nsecond line ~/maps/isle.md.",
        wrapMode: "word",
        width: 16,
    });
    box.add(text);
    setup.renderer.root.add(box);
    await setup.renderOnce();
    const counter = createClickCounter();
    const seen: string[] = [];
    setup.renderer.on(CliRenderEvents.SELECTION, (clicked: Selection) => {
        const selection = expandClick(setup.renderer, clicked, counter, Date.now()) ?? clicked;
        seen.push(selection.getSelectedText());
    });
    return { setup, seen };
}

async function clicks(setup: Awaited<ReturnType<typeof createTestRenderer>>, x: number, y: number, times: number) {
    for (let index = 0; index < times; index++) {
        await setup.mockMouse.click(x, y);
    }
    await setup.renderOnce();
}

test("double-click selects the word under the pointer", async () => {
    const { setup, seen } = await crowText();
    await clicks(setup, 8, 1, 2);
    expect(seen).toEqual(["", "pirate"]);
    expect(setup.captureCharFrame()).toContain("pirate");
    setup.renderer.destroy();
});

test("triple-click selects the whole wrapped source line", async () => {
    const { setup, seen } = await crowText();
    await clicks(setup, 4, 2, 3);
    expect(seen.at(-1)).toBe("the pirate crow sails at dawn tonight");
    setup.renderer.destroy();
});

test("a path counts as one word and drops a trailing full stop", async () => {
    const { setup, seen } = await crowText();
    await clicks(setup, 10, 5, 2);
    expect(seen.at(-1)).toBe("~/maps/isle.md");
    setup.renderer.destroy();
});

test("a fourth click starts over as a plain click", async () => {
    const { setup, seen } = await crowText();
    await clicks(setup, 8, 1, 4);
    expect(seen.at(-1)).toBe("");
    setup.renderer.destroy();
});

test("double-click on a space selects nothing", async () => {
    const { setup, seen } = await crowText();
    await clicks(setup, 5, 1, 2);
    expect(seen).toEqual(["", ""]);
    setup.renderer.destroy();
});

test("clicks far apart in time do not combine", () => {
    const counter = createClickCounter();
    expect(counter.register({ x: 3, y: 1 }, 0)).toBe(1);
    expect(counter.register({ x: 3, y: 1 }, 200)).toBe(2);
    expect(counter.register({ x: 3, y: 1 }, 1200)).toBe(1);
    expect(counter.register({ x: 3, y: 2 }, 1300)).toBe(1);
});
