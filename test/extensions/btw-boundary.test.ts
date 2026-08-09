import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const tuiRoot = join(import.meta.dir, "../../clients/tui");

test("the BTW extension leaves no product policy in the TUI", async () => {
    const files = Array.from(
        new Bun.Glob("**/*.ts").scanSync({ cwd: tuiRoot }),
    );
    const policyReferences = files.flatMap((file) => {
        const source = readFileSync(join(tuiRoot, file), "utf8");
        return /\bsidekick\b|\/btw\b|\/pair\b/i.test(source) ? [file] : [];
    });

    expect(policyReferences).toEqual([]);
});
