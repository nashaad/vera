import { expect, test } from "bun:test";

const source = (path: string): Promise<string> =>
    Bun.file(new URL(`../../${path}`, import.meta.url)).text();

test("the dial HUD is coloured in one place, not inside the renderer", async () => {
    const files = ["clients/tui/main.ts"];
    for await (const path of new Bun.Glob("clients/tui/main/**/*.ts").scan()) {
        files.push(path);
    }
    const sources = await Promise.all(files.map((path) => source(path)));
    expect(sources.some((text) => text.includes("paintDialHud"))).toBe(true);
    const main = sources.join("\n");
    expect(main).not.toContain("#c586c0");
});

test("the painter stays free of the renderer and the terminal", async () => {
    const paint = await source("clients/tui/dial-paint.ts");
    for (const forbidden of ["StyledText", "@opentui", "./main.ts", "./state.ts"]) {
        expect(paint).not.toContain(forbidden);
    }
});
