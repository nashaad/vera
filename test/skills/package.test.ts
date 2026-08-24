import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadSkillPackage,
    parseSkillSource,
    SKILL_FILENAME,
} from "../../src/skills/package.ts";

test("a skill exposes portable metadata and keeps its instructions separate", () => {
    expect(parseSkillSource(`---
name: consult
description: Ask two independent agents and reconcile their evidence.
context: fork
---
# Consult

Run both investigations in parallel.
`)).toEqual({
        metadata: {
            name: "consult",
            description: "Ask two independent agents and reconcile their evidence.",
            disableModelInvocation: false,
            extra: { context: "fork" },
        },
        instructions: "# Consult\n\nRun both investigations in parallel.\n",
    });
});

test("YAML descriptions may use folded blocks", () => {
    const parsed = parseSkillSource(`---
name: review-code
description: >-
  Review a change for correctness,
  regressions, and missing tests.
---
Review the diff.
`);

    expect(parsed.metadata.description).toBe(
        "Review a change for correctness, regressions, and missing tests.",
    );
});

test("name and description are required and bounded", () => {
    for (const source of [
        "# No frontmatter\n",
        "---\nname: consult\n---\nBody\n",
        "---\nname: Consult\ndescription: Useful\n---\nBody\n",
        `---\nname: ${"a".repeat(65)}\ndescription: Useful\n---\nBody\n`,
        `---\nname: consult\ndescription: ${"a".repeat(1025)}\n---\nBody\n`,
    ]) {
        expect(() => parseSkillSource(source)).toThrow();
    }
});

test("disable-model-invocation opts a skill out of automatic use", () => {
    const parsed = parseSkillSource(`---
name: adversarial
description: Read-only adversarial review.
disable-model-invocation: true
---
Body.
`);

    expect(parsed.metadata.disableModelInvocation).toBe(true);
    expect(parsed.metadata.extra).toEqual({});
});

test("disable-model-invocation defaults to false and rejects non-booleans", () => {
    const parsed = parseSkillSource(`---
name: consult
description: Compare two independent answers.
---
Body.
`);
    expect(parsed.metadata.disableModelInvocation).toBe(false);

    expect(() =>
        parseSkillSource(`---
name: consult
description: Compare two independent answers.
disable-model-invocation: yes
---
Body.
`)
    ).toThrow();
});

test("loading accepts only a directory rooted at SKILL.md", async () => {
    const parent = mkdtempSync(join(tmpdir(), "vera-skill-"));
    const directory = join(parent, "consult");
    mkdirSync(directory);
    writeFileSync(join(directory, SKILL_FILENAME), `---
name: consult
description: Compare two independent answers.
---
Consult two agents.
`);

    const loaded = await loadSkillPackage(directory);
    expect(loaded.directory).toBe(realpathSync(directory));
    expect(loaded.skillPath).toBe(
        join(realpathSync(directory), SKILL_FILENAME),
    );
    expect(loaded.metadata.name).toBe("consult");
    expect(loaded.instructions).toBe("Consult two agents.\n");
});

test("SKILL.md cannot leave its package through a symlink", async () => {
    const parent = mkdtempSync(join(tmpdir(), "vera-skill-link-"));
    const directory = join(parent, "consult");
    mkdirSync(directory);
    const outside = join(parent, SKILL_FILENAME);
    writeFileSync(outside, `---
name: consult
description: Compare two independent answers.
---
Body
`);
    symlinkSync(outside, join(directory, SKILL_FILENAME));

    expect(loadSkillPackage(directory)).rejects.toThrow(
        `must contain a regular ${SKILL_FILENAME} file`,
    );
});

test("the skill name matches its package directory", async () => {
    const parent = mkdtempSync(join(tmpdir(), "vera-skill-name-"));
    const directory = join(parent, "consult");
    mkdirSync(directory);
    writeFileSync(join(directory, SKILL_FILENAME), `---
name: review
description: Review a change.
---
Body
`);

    expect(loadSkillPackage(directory)).rejects.toThrow(
        "name review must match directory consult",
    );
});
