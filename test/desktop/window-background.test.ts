import { expect, test } from "bun:test";

import { parseWindowBackground } from "../../clients/desktop/src/window-background.ts";

test("@core the window background accepts hex and functional colors as opaque hex", () => {
    expect(parseWindowBackground("#131313")).toBe("#131313");
    expect(parseWindowBackground("  #FFAA00 ")).toBe("#ffaa00");
    expect(parseWindowBackground("#fa0")).toBe("#ffaa00");
    expect(parseWindowBackground("#11223344")).toBe("#112233");
    expect(parseWindowBackground("#1234")).toBe("#112233");
    expect(parseWindowBackground("rgb(19, 19, 19)")).toBe("#131313");
    expect(parseWindowBackground("rgb(255 0 128)")).toBe("#ff0080");
    expect(parseWindowBackground("rgba(0, 0, 0, 0.5)")).toBe("#000000");
});

test("@core the window background rejects anything that is not a plain color", () => {
    const rejected: readonly unknown[] = [
        undefined,
        null,
        42,
        {},
        "",
        "   ",
        "red",
        "#12",
        "#12345",
        "#1234567",
        "#ggg",
        "rgb(256, 0, 0)",
        "rgb(1, 2)",
        "rgb(1, 2, 3",
        "var(--vera-surface)",
        "url(file:///etc/passwd)",
        "#131313; color: red",
        `#${"1".repeat(200)}`,
    ];
    for (const value of rejected) expect(parseWindowBackground(value)).toBeUndefined();
});
