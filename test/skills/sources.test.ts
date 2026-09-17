import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSkillDisabled, resolveSkillSources } from "../../src/skills/sources.ts";

test("skill patterns match exact names or a trailing-star prefix", () => {
    expect(isSkillDisabled("review", ["review"])).toBe(true);
    expect(isSkillDisabled("review-deep", ["review"])).toBe(false);
    expect(isSkillDisabled("data-plot", ["data-*"])).toBe(true);
    expect(isSkillDisabled("vera-help", ["*"])).toBe(true);
    expect(isSkillDisabled("vera-help", [])).toBe(false);
});

test("an enabled project extension contributes its skill directories", () => {
    const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "vera-skill-sources-")));
    const extensionDirectory = join(projectRoot, ".vera", "extensions", "kernel");
    mkdirSync(extensionDirectory, { recursive: true });
    writeFileSync(join(extensionDirectory, "extension.ts"), "export default {};\n");
    writeFileSync(join(extensionDirectory, "vera.extension.json"), JSON.stringify({
        id: "acme.kernel",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: [],
        contributes: { skills: ["skills"] },
    }));

    const sources = resolveSkillSources(projectRoot);

    expect(sources.extensionRoots).toContainEqual({
        extensionId: "acme.kernel",
        path: join(extensionDirectory, "skills"),
    });
});
