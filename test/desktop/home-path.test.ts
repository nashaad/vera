import { expect, test } from "bun:test";

import { shortenPath } from "../../clients/ui/src/components/homePath.ts";

test("@core the user's home becomes a tilde and the full path is left to the tooltip", () => {
    expect(shortenPath("/Users/nash/.vera")).toBe("~/.vera");
    expect(shortenPath("/home/nash/.vera/machine")).toBe("~/.vera/machine");
    expect(shortenPath("/Users/nash")).toBe("~");
    expect(shortenPath("C:\\Users\\nash\\vera")).toBe("~\\vera");
});

test("a long path keeps its last two segments behind an ellipsis", () => {
    expect(shortenPath("/Users/nash/Projects/vera/.worktrees/desktop/home")).toBe("~/…/desktop/home");
    expect(shortenPath("/var/folders/ab/cd/vera-trial")).toBe("/…/cd/vera-trial");
    expect(shortenPath("C:\\Users\\nash\\a\\b\\c\\d")).toBe("~\\…\\c\\d");
});

test("a short path is shown whole", () => {
    expect(shortenPath("/tmp/vera-home")).toBe("/tmp/vera-home");
    expect(shortenPath("/a/b/c")).toBe("/a/b/c");
    expect(shortenPath("/")).toBe("/");
    expect(shortenPath("")).toBe("");
});
