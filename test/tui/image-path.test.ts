import { expect, test } from "bun:test";

import { pastedImagePath } from "../../clients/tui/image-path.ts";

test("pasted screenshot paths recognize macOS escaping and quotes", () => {
    expect(pastedImagePath(
        "/var/folders/tmp/Screenshot\\ 2026-07-22\\ at\\ 6.11.40\\ PM.png",
    )).toBe("/var/folders/tmp/Screenshot 2026-07-22 at 6.11.40 PM.png");
    expect(pastedImagePath("'/tmp/My Screenshot.webp'"))
        .toBe("/tmp/My Screenshot.webp");
});

test("pasted image detection leaves prose and non-images alone", () => {
    expect(pastedImagePath("look at /tmp/screen.png")).toBeUndefined();
    expect(pastedImagePath("relative.png")).toBeUndefined();
    expect(pastedImagePath("/tmp/notes.txt")).toBeUndefined();
    expect(pastedImagePath("/tmp/one.png\n/tmp/two.png")).toBeUndefined();
});
