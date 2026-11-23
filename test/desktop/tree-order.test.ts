import { expect, test } from "bun:test";

import { compareTreePaths } from "../../clients/ui/src/session/gitChanges.ts";

test("tree order puts folders first, sorts naturally and breaks case ties by raw name", () => {
    expect(compareTreePaths("src/added.ts", "added.ts")).toBeLessThan(0);
    expect(compareTreePaths("module-2.ts", "module-10.ts")).toBeLessThan(0);
    expect(compareTreePaths("Added.ts", "added.ts")).toBeLessThan(0);
    expect(compareTreePaths("added.ts", "Added.ts")).toBeGreaterThan(0);
    expect(compareTreePaths("same.ts", "same.ts")).toBe(0);
    expect(["b.ts", "a.ts", "B.ts", "A.ts"].sort(compareTreePaths)).toEqual(["A.ts", "a.ts", "B.ts", "b.ts"]);
});
