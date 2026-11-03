import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TUI = join(import.meta.dir, "..", "..", "clients", "tui");

test("every terminal input listener in the TUI is wrapped in guardInput", () => {
    const listeners: string[] = [];
    for (const file of new Bun.Glob("**/*.ts").scanSync(TUI)) {
        const source = readFileSync(join(TUI, file), "utf8");
        for (const match of source.matchAll(/keyInput\.on\(\s*"(\w+)",\s*(\w+)/g)) {
            listeners.push(`${file} ${match[1]} ${match[2]}`);
        }
    }
    expect(listeners.sort()).toEqual([
        "main.ts keypress guardInput",
        "main.ts paste guardInput",
    ]);
});

test("the composer's submit, image paste and image chip callbacks are wrapped in guardInput", () => {
    const source = readFileSync(join(TUI, "main.ts"), "utf8");
    const start = source.indexOf("rt.composer = createTuiComposer(");
    expect(start).toBeGreaterThan(-1);
    const call = source.slice(start, source.indexOf("\n    );\n", start));
    expect(call).toContain(`guardInput(rt, "submit", `);
    expect(call).toContain(`guardInput(rt, "image_paste", `);
    expect(source).toContain(`rt.composer.onImageChipRemoved = guardInput(rt, "image_chip_removed", `);
});
