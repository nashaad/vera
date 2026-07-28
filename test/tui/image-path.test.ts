import { expect, test } from "bun:test";

import { pastedImagePaths } from "../../clients/tui/image-path.ts";

test("pasted screenshot paths recognize macOS escaping and quotes", () => {
    expect(pastedImagePaths(
        "/var/folders/tmp/Screenshot\\ 2026-07-22\\ at\\ 6.11.40\\ PM.png",
    )).toEqual(["/var/folders/tmp/Screenshot 2026-07-22 at 6.11.40 PM.png"]);
    expect(pastedImagePaths("'/tmp/My Screenshot.webp'"))
        .toEqual(["/tmp/My Screenshot.webp"]);
});

test("dropping several files at once yields one path each", () => {
    expect(pastedImagePaths(
        "/Users/nash/Desktop/Screenshot\\ at\\ 11.08.54\\ AM.png"
            + " /Users/nash/Desktop/Screenshot\\ at\\ 11.04.26\\ AM.png",
    )).toEqual([
        "/Users/nash/Desktop/Screenshot at 11.08.54 AM.png",
        "/Users/nash/Desktop/Screenshot at 11.04.26 AM.png",
    ]);
    expect(pastedImagePaths("'/tmp/a b.png' '/tmp/c.jpg'"))
        .toEqual(["/tmp/a b.png", "/tmp/c.jpg"]);
});

test("pasted image detection leaves prose and non-images alone", () => {
    expect(pastedImagePaths("look at /tmp/screen.png")).toEqual([]);
    expect(pastedImagePaths("relative.png")).toEqual([]);
    expect(pastedImagePaths("/tmp/notes.txt")).toEqual([]);
    expect(pastedImagePaths("/tmp/one.png\n/tmp/two.png")).toEqual([]);
    // One unusable path in the drop makes the whole paste ordinary text
    // rather than a silent partial attach.
    expect(pastedImagePaths("/tmp/one.png /tmp/notes.txt")).toEqual([]);
});
